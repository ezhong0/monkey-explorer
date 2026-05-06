// Execute a single mission end-to-end.
//
// Phases (each delegated to a pipeline stage where possible):
//   1. Create BB session + initial running-status report
//   2. Connect Stagehand
//   3. Probe — pipeline/probe.ts
//   4. Run agent — pipeline/run-agent.ts (under wallclock timer)
//   5. Fetch session events — pipeline/fetch-events.ts (best-effort)
//   6. Lift deterministic Issues — pipeline/lift-issues.ts
//   7. Build trace + adjudicate (gated on trace content) —
//      pipeline/build-trace.ts + pipeline/adjudicate.ts
//   8. Assemble RunStatus from stage results
//   9. Finalize: write terminal report, close session
//
// Every non-running RunStatus carries a Review (real one from the
// adjudicator on `completed`; synthetic on failure paths) so JSON
// consumers don't have to branch on its presence.

import { randomUUID } from 'node:crypto';
import * as log from '../log/stderr.js';
import { computeCost, formatCostSummary } from '../cost/compute.js';
import { sanitizeText } from '../review/sanitize.js';
import { writeReportInitial, writeReportTerminal } from '../report/write.js';
import { startWallClockTimer } from './caps.js';
import { createSession, type MonkeySession } from '../bb/session.js';
import { createStagehand } from '../stagehand/adapter.js';
import { liftDeterministicIssues } from '../pipeline/lift-issues.js';
import { pickModelApiKey } from '../stagehand/modelKey.js';
import { buildTrace } from '../pipeline/build-trace.js';
import { fetchSessionEvents } from '../pipeline/fetch-events.js';
import { runProbe } from '../pipeline/probe.js';
import { runAgent, type RunAgentValue } from '../pipeline/run-agent.js';
import { adjudicate } from '../pipeline/adjudicate.js';
import type { StageResult } from '../pipeline/types.js';
import {
  reviewForAborted,
  reviewForAdjudicatorFailed,
  reviewForAdjudicatorRateLimited,
  reviewForAgentRateLimited,
  reviewForErrored,
  reviewForNotStarted,
  reviewForTimedOut,
} from '../review/synthetic.js';
import type { Issue, Review } from '../review/schema.js';
import type { Browserbase } from '../bb/client.js';
import type {
  ConsoleEvent,
  FailureCause,
  MissionResult,
  NetworkFailure,
  RunStatus,
} from '../types.js';
import type { AuthMode, Caps, Credentials, Target } from '../state/schema.js';

export interface RunMissionOpts {
  // Mission + parallel context
  mission: string;
  index: number;
  total: number;
  invocationId: string;
  /** The resolved Target object (full record). */
  target: Target;
  /** Target name (for log messages, report linkage). */
  targetName: string;
  // Wiring
  bb: Browserbase;
  projectId: string;
  contextId: string;
  reportsDir: string;
  authMode: AuthMode;
  caps: Caps;
  stagehandModel: string;
  agentModel: string;
  /** Optional override; falls back to agentModel when undefined. */
  adjudicatorModel?: string;
  credentials: Credentials;
  signal: AbortSignal;
}

function logPrefix(index: number, total: number): string {
  return total > 1 ? `[${index + 1}/${total}]` : '';
}

function elapsed(startedAt: Date): number {
  return Date.now() - startedAt.getTime();
}

export async function runMission(opts: RunMissionOpts): Promise<MissionResult> {
  const startedAt = new Date();
  const prefix = logPrefix(opts.index, opts.total);

  // ─── 1. Session + initial report ────────────────────────────────────────
  let session: MonkeySession;
  try {
    session = await createSession({
      bb: opts.bb,
      projectId: opts.projectId,
      contextId: opts.contextId,
      mission: opts.mission,
      invocationId: opts.invocationId,
      sessionTimeoutSec: opts.caps.sessionTimeoutSec,
    });
  } catch (err) {
    return await writeNotStartedReport(opts, startedAt, err as Error);
  }

  let reportPath: string;
  let initialFm: Awaited<ReturnType<typeof writeReportInitial>>['frontMatter'];
  try {
    const initial = await writeReportInitial({
      reportsDir: opts.reportsDir,
      startedAt,
      target: opts.target.url,
      mission: opts.mission,
      sessionId: session.id,
      liveViewUrl: session.liveViewUrl || null,
      replayUrl: session.replayUrl,
    });
    reportPath = initial.filePath;
    initialFm = initial.frontMatter;
  } catch (err) {
    await session.close();
    throw err; // can't write reports — fatal
  }

  log.info(`${prefix} ${opts.mission}`);
  if (session.liveViewUrl) log.info(`${prefix}   Live view: ${session.liveViewUrl}`);
  log.info(`${prefix}   Replay:    ${session.replayUrl}  (available after run)`);

  // From here on, all failures flow through finalize() — a closure that
  // captures the session/handle/report so each phase can fail with a
  // single-line return.
  let stagehandHandle: Awaited<ReturnType<typeof createStagehand>> | null = null;
  const finalizeWith = (
    status: RunStatus,
    consoleErrors: ConsoleEvent[] = [],
    networkFailures: NetworkFailure[] = [],
  ): Promise<MissionResult> =>
    finalize(opts, {
      session,
      stagehandHandle,
      reportPath,
      initialFm,
      startedAt,
      status,
      consoleErrors,
      networkFailures,
    });

  // ─── 2. Connect Stagehand ───────────────────────────────────────────────
  try {
    stagehandHandle = await createStagehand({
      apiKey: opts.credentials.browserbaseApiKey,
      projectId: opts.projectId,
      sessionId: session.id,
      modelName: opts.stagehandModel,
      modelApiKey: pickModelApiKey(opts.stagehandModel, opts.credentials),
      logPrefix: prefix,
    });
  } catch (err) {
    return finalizeWith(statusFromEarlyFailure('infrastructure', (err as Error).message, elapsed(startedAt)));
  }

  // ─── 3. Probe ───────────────────────────────────────────────────────────
  const page = await stagehandHandle.page();
  const probeResult = await runProbe({
    page,
    stagehand: stagehandHandle.stagehand,
    targetUrl: opts.target.url,
    authModeKind: opts.authMode.kind,
    targetName: opts.targetName,
  });
  if (!probeResult.ok) {
    return finalizeWith(statusFromEarlyFailure(probeResult.cause, probeResult.error, elapsed(startedAt)));
  }
  log.ok(`${prefix} Probe passed.`);

  // ─── 4. Run agent under wallclock timer ─────────────────────────────────
  const timer = startWallClockTimer({
    wallClockMs: opts.caps.wallClockMs,
    onFire: () => session.close(),
    signal: opts.signal,
  });
  let agentResult: StageResult<RunAgentValue>;
  try {
    agentResult = await runAgent({
      stagehand: stagehandHandle.stagehand,
      agentModel: opts.agentModel,
      agentApiKey: pickModelApiKey(opts.agentModel, opts.credentials),
      agentBaseURL: opts.agentModel.startsWith('anthropic/')
        ? opts.credentials.anthropicBaseURL
        : undefined,
      executionModel: opts.stagehandModel,
      executionApiKey: pickModelApiKey(opts.stagehandModel, opts.credentials),
      instruction: opts.mission,
      maxSteps: opts.caps.maxSteps,
      signal: opts.signal,
      timerFired: () => timer.fired(),
    });
  } finally {
    timer.clear(); // clear before downstream LLM calls so a late-fire doesn't kill them
  }

  // ─── 5. Fetch session events (best-effort) ──────────────────────────────
  const targetOrigin = (() => {
    try {
      return new URL(opts.target.url).origin;
    } catch {
      return opts.target.url;
    }
  })();
  const collectedEvents = await fetchSessionEvents({
    bb: opts.bb,
    sessionId: session.id,
    targetOrigin,
  });

  // ─── 6. Lift deterministic Issues ───────────────────────────────────────
  const { issues: lifterIssues } = liftDeterministicIssues(collectedEvents);

  // ─── Aborted check (after agent + events so we have lifter signal) ──────
  if (opts.signal.aborted) {
    return finalizeWith(
      { kind: 'aborted', review: reviewForAborted(), ranForMs: elapsed(startedAt) },
      collectedEvents.consoleErrors,
      collectedEvents.networkFailures,
    );
  }

  // ─── 7. Build trace + adjudicate (gated on rawActions content) ──────────
  const rawActions = agentResult.ok ? agentResult.value.rawActions : [];
  const tokensUsed = agentResult.ok ? agentResult.value.tokensUsed : undefined;

  let review: Review | null = null;
  let adjFailure: { cause: FailureCause; error?: string } | null = null;
  if (rawActions.length > 0) {
    const trace = buildTrace({
      header: {
        missionId: opts.invocationId,
        mission: opts.mission,
        target: opts.target.url,
        startedAt: startedAt.toISOString(),
        agentModel: opts.agentModel,
      },
      rawActions,
      consoleErrors: collectedEvents.consoleErrors,
      networkFailures: collectedEvents.networkFailures,
    });

    const adjModel = opts.adjudicatorModel ?? opts.agentModel;
    const useAzureForAdj =
      adjModel.startsWith('anthropic/') && !!opts.credentials.anthropicBaseURL;
    const adjModelName = useAzureForAdj ? adjModel.replace(/^anthropic\//, '') : adjModel;

    const adjResult = await adjudicate({
      apiKey: pickModelApiKey(adjModel, opts.credentials),
      baseURL: useAzureForAdj ? opts.credentials.anthropicBaseURL : undefined,
      model: adjModelName,
      trace,
      liftedIssues: lifterIssues,
    });

    if (adjResult.ok) {
      review = adjResult.value;
    } else {
      adjFailure = { cause: adjResult.cause, error: adjResult.error };
      log.warn(
        `${prefix} adjudicator failed (${adjResult.cause}); shipping ${lifterIssues.length} lifter issue(s) only.`,
      );
      if (process.env.MONKEY_DEBUG && adjResult.error) log.warn(adjResult.error);
    }
  }

  // ─── 8. Assemble RunStatus ──────────────────────────────────────────────
  const status = assembleStatus({
    agentResult,
    adjFailure,
    review,
    lifterIssues,
    ranForMs: elapsed(startedAt),
    tokensUsed,
  });

  // ─── 9. Finalize ────────────────────────────────────────────────────────
  return finalizeWith(status, collectedEvents.consoleErrors, collectedEvents.networkFailures);
}

// ─── Status assembly ──────────────────────────────────────────────────────

function statusFromEarlyFailure(
  cause: FailureCause,
  error: string | undefined,
  ranForMs: number,
): RunStatus {
  const errMsg = sanitizeText(error ?? 'failed');
  switch (cause) {
    case 'probe_failed':
      return { kind: 'not_started', review: reviewForNotStarted(errMsg), reason: errMsg };
    case 'aborted':
      return { kind: 'aborted', review: reviewForAborted(), ranForMs };
    case 'infrastructure':
    case 'agent_errored':
    default:
      return { kind: 'errored', review: reviewForErrored(errMsg), error: errMsg, ranForMs };
  }
}

function assembleStatus(args: {
  agentResult: StageResult<RunAgentValue>;
  adjFailure: { cause: FailureCause; error?: string } | null;
  review: Review | null;
  lifterIssues: Issue[];
  ranForMs: number;
  tokensUsed: number | undefined;
}): RunStatus {
  const { agentResult, adjFailure, review, lifterIssues, ranForMs, tokensUsed } = args;

  // Agent failed — the failure cause drives status (review may still come
  // from the adjudicator if it ran on partial trace; prefer real over synth).
  if (!agentResult.ok) {
    const errMsg = sanitizeText(agentResult.error ?? 'agent failed');
    switch (agentResult.cause) {
      case 'wallclock':
        return {
          kind: 'timed_out',
          review: review ?? reviewForTimedOut(lifterIssues),
          ranForMs,
        };
      case 'rate_limited':
        // Today: API rate-limit / Anthropic 429/529. The 'exceeded_tokens'
        // status name is legacy — when real budget enforcement lands this
        // branch will split. The diagnostic on the synthetic Review is
        // 'rate_limited' (retry me), which is the operationally honest
        // signal.
        return {
          kind: 'exceeded_tokens',
          review: review ?? reviewForAgentRateLimited(lifterIssues),
          ranForMs,
        };
      case 'agent_errored':
      default:
        return {
          kind: 'errored',
          review: review ?? reviewForErrored(errMsg),
          error: errMsg,
          ranForMs,
        };
    }
  }

  // Agent succeeded; adjudicator may have failed.
  if (adjFailure) {
    const errMsg = sanitizeText(adjFailure.error ?? 'adjudicator failed');
    switch (adjFailure.cause) {
      case 'rate_limited':
        return {
          kind: 'adjudicator_failed',
          review: reviewForAdjudicatorRateLimited(lifterIssues),
          error: errMsg,
          errorKind: 'rate_limit',
          ranForMs,
        };
      case 'adjudicator_parse':
        return {
          kind: 'adjudicator_failed',
          review: reviewForAdjudicatorFailed(lifterIssues, errMsg, 'parse'),
          error: errMsg,
          errorKind: 'parse',
          ranForMs,
        };
      case 'adjudicator_other':
      default:
        return {
          kind: 'adjudicator_failed',
          review: reviewForAdjudicatorFailed(lifterIssues, errMsg, 'other'),
          error: errMsg,
          errorKind: 'other',
          ranForMs,
        };
    }
  }

  // Agent + adjudicator both succeeded.
  if (review) {
    return { kind: 'completed', review, ranForMs, tokensUsed };
  }

  // Agent ran cleanly but produced no actions — adjudicator never ran.
  // Treat as a run-time error (the agent did literally nothing).
  const errMsg = 'Agent produced no actions';
  return {
    kind: 'errored',
    review: reviewForErrored(errMsg),
    error: errMsg,
    ranForMs,
  };
}

// ─── Finalize ─────────────────────────────────────────────────────────────

async function finalize(
  opts: RunMissionOpts,
  ctx: {
    session: MonkeySession | null;
    stagehandHandle: Awaited<ReturnType<typeof createStagehand>> | null;
    reportPath: string;
    initialFm: Awaited<ReturnType<typeof writeReportInitial>>['frontMatter'];
    startedAt: Date;
    status: RunStatus;
    consoleErrors: ConsoleEvent[];
    networkFailures: NetworkFailure[];
  },
): Promise<MissionResult> {
  const finishedAt = new Date();
  const sessionId = ctx.session?.id ?? '';
  const replayUrl = ctx.session?.replayUrl ?? '';

  // Cost summary only on completed runs (where tokensUsed is meaningful).
  let costSummary: string | undefined;
  if (ctx.status.kind === 'completed') {
    const cost = computeCost({
      ranForMs: ctx.status.ranForMs,
      tokensUsed: ctx.status.tokensUsed,
      agentModel: opts.agentModel,
    });
    costSummary = formatCostSummary(cost);
  }

  if (ctx.reportPath) {
    try {
      await writeReportTerminal({
        filePath: ctx.reportPath,
        initialFm: ctx.initialFm,
        status: ctx.status,
        consoleErrors: ctx.consoleErrors,
        networkFailures: ctx.networkFailures,
        finishedAt,
        costSummary,
        sessionId,
        replayUrl,
      });
    } catch (err) {
      log.warn(`Failed to update report ${ctx.reportPath}: ${(err as Error).message}`);
    }
  }

  // Close Stagehand + session (idempotent).
  if (ctx.stagehandHandle) await ctx.stagehandHandle.close();
  if (ctx.session) await ctx.session.close();

  return {
    index: opts.index,
    total: opts.total,
    mission: opts.mission,
    target: opts.target.url,
    status: ctx.status,
    sessionId: sessionId || null,
    replayUrl: replayUrl || null,
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    reportPath: ctx.reportPath,
    consoleErrors: ctx.consoleErrors,
    networkFailures: ctx.networkFailures,
  };
}

async function writeNotStartedReport(
  opts: RunMissionOpts,
  startedAt: Date,
  err: Error,
): Promise<MissionResult> {
  const finishedAt = new Date();
  const reason = sanitizeText(`session create failed: ${err.message}`);

  const tempSessionId = randomUUID();
  const initial = await writeReportInitial({
    reportsDir: opts.reportsDir,
    startedAt,
    target: opts.target.url,
    mission: opts.mission,
    sessionId: tempSessionId,
    liveViewUrl: null,
    replayUrl: null,
  }).catch(() => null);

  const status: RunStatus = {
    kind: 'not_started',
    review: reviewForNotStarted(reason),
    reason,
  };

  if (initial) {
    await writeReportTerminal({
      filePath: initial.filePath,
      initialFm: initial.frontMatter,
      status,
      finishedAt,
      sessionId: '',
      replayUrl: '',
    }).catch(() => {});
  }

  return {
    index: opts.index,
    total: opts.total,
    mission: opts.mission,
    target: opts.target.url,
    status,
    sessionId: null,
    replayUrl: null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    reportPath: initial?.filePath ?? '',
    consoleErrors: [],
    networkFailures: [],
  };
}
