// Execute a single mission end-to-end:
//   1. Create report at start (status: running)
//   2. Create BB session + fetch live view URL
//   3. Print [N/M] header with live view + replay URLs
//   4. Connect Stagehand
//   5. Probe — if sign-in-page, run auth dispatch + retry probe (1x)
//   6. Execute agent (Stagehand hybrid mode: act/goto/extract + pixel fallbacks)
//   7. Fetch session events (console + network) post-mission
//   8. Lift deterministic Issues (console errors + 4xx/5xx)
//   9. Build in-memory trace; run adjudicator → Review
//   10. Update report; close session
//
// Each step's failure mode is mapped onto the RunStatus discriminated
// union. Every non-running RunStatus carries a Review (real one from the
// adjudicator on `completed`; synthetic on failure paths) so JSON
// consumers don't have to branch on its presence.

import { randomUUID } from 'node:crypto';
import * as log from '../log/stderr.js';
import { computeCost, formatCostSummary } from '../cost/compute.js';
import { probe } from '../probe/probe.js';
import { sanitizeText } from '../findings/sanitize.js';
import { writeReportInitial, writeReportTerminal } from '../report/write.js';
import { startWallClockTimer } from './caps.js';
import { createSession, type MonkeySession } from '../bb/session.js';
import { createStagehand } from '../stagehand/adapter.js';
import { executeAgent } from '../stagehand/agent.js';
import { liftDeterministicIssues } from '../observe/promote.js';
import { pickModelApiKey } from '../stagehand/modelKey.js';
import { buildTrace } from '../trace/build.js';
import { runAdjudicator, AdjudicatorError } from '../adjudicate/run.js';
import { fetchSessionEvents } from '../observe/fetchEvents.js';
import {
  reviewForAborted,
  reviewForAdjudicatorFailed,
  reviewForAdjudicatorRateLimited,
  reviewForAgentRateLimited,
  reviewForErrored,
  reviewForNotStarted,
  reviewForTimedOut,
} from '../review/synthetic.js';
import type { Review } from '../review/schema.js';
import type { Browserbase } from '../bb/client.js';
import type {
  AdjudicatorErrorKind,
  ConsoleEvent,
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

export async function runMission(opts: RunMissionOpts): Promise<MissionResult> {
  const startedAt = new Date();
  const prefix = logPrefix(opts.index, opts.total);
  let session: MonkeySession | null = null;
  let stagehandHandle: Awaited<ReturnType<typeof createStagehand>> | null = null;
  let reportPath = '';
  let initialFm: Awaited<ReturnType<typeof writeReportInitial>>['frontMatter'] | null = null;

  // Create session FIRST so we have session_id for the report.
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

  // Initial report (status: running)
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

  // Print header with live view + replay URLs.
  log.info(`${prefix} ${opts.mission}`);
  if (session.liveViewUrl) {
    log.info(`${prefix}   Live view: ${session.liveViewUrl}`);
  }
  log.info(`${prefix}   Replay:    ${session.replayUrl}  (available after run)`);

  // Connect Stagehand.
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
    const errMsg = sanitizeText((err as Error).message);
    return await finalize(opts, {
      session,
      stagehandHandle: null,
      reportPath,
      initialFm: initialFm!,
      startedAt,
      status: {
        kind: 'errored',
        review: reviewForErrored(errMsg),
        error: errMsg,
        ranForMs: elapsed(startedAt),
      },
      consoleErrors: [],
      networkFailures: [],
    });
  }

  // Probe to confirm the session inherited valid auth from the just-bootstrapped
  // context. Bootstrap ran moments ago in commands/run.ts so this should always
  // pass for non-`none` auth modes; if it doesn't, something's wrong with the
  // target's auth (cookies revoked, app outage, etc.) and we fail fast.
  try {
    const page = await stagehandHandle.page();
    const probeResult = await probe({ page, stagehand: stagehandHandle.stagehand, target: opts.target.url, authModeKind: opts.authMode.kind });

    if (probeResult.kind !== 'ok') {
      const reason =
        probeResult.kind === 'unreachable'
          ? `unreachable: ${probeResult.details}`
          : probeResult.kind === 'sign-in-page'
            ? `not signed in (bootstrap just ran but cookies didn't apply). Run \`monkey auth ${opts.targetName}\` to refresh.`
            : `unknown auth state: ${probeResult.details}`;
      return await finalize(opts, {
        session,
        stagehandHandle,
        reportPath,
        initialFm: initialFm!,
        startedAt,
        status: {
          kind: 'not_started',
          review: reviewForNotStarted(reason),
          reason,
        },
        consoleErrors: [],
        networkFailures: [],
      });
    }

    log.ok(`${prefix} Probe passed.`);
  } catch (err) {
    const errMsg = sanitizeText((err as Error).message);
    return await finalize(opts, {
      session,
      stagehandHandle,
      reportPath,
      initialFm: initialFm!,
      startedAt,
      status: {
        kind: 'errored',
        review: reviewForErrored(errMsg),
        error: errMsg,
        ranForMs: elapsed(startedAt),
      },
      consoleErrors: [],
      networkFailures: [],
    });
  }

  // Run the agent with wall-clock timer.
  type AgentErrorKind = 'timed_out' | 'exceeded_tokens' | 'errored';
  let tokensUsed: number | undefined;
  let agentError: { kind: AgentErrorKind; message: string } | null = null;
  let rawActions: unknown[] = [];

  const timer = startWallClockTimer({
    wallClockMs: opts.caps.wallClockMs,
    onFire: () => session!.close(),
    signal: opts.signal,
  });

  try {
    const result = await executeAgent({
      stagehand: stagehandHandle.stagehand,
      agentModel: opts.agentModel,
      agentApiKey: pickModelApiKey(opts.agentModel, opts.credentials),
      // When the user has configured an Anthropic base URL override
      // (e.g. an Azure Foundry endpoint), thread it through so the agent
      // routes Claude calls there instead of api.anthropic.com.
      agentBaseURL: opts.agentModel.startsWith('anthropic/')
        ? opts.credentials.anthropicBaseURL
        : undefined,
      // Route Stagehand's in-agent grounding calls (act/extract internals) to
      // the per-target stagehandModel. Without this, grounding inherits the
      // agent's expensive opus-tier model and saturates the same deployment
      // — see Layer 1 in capacity-hardening notes.
      executionModel: opts.stagehandModel,
      executionApiKey: pickModelApiKey(opts.stagehandModel, opts.credentials),
      instruction: opts.mission,
      maxSteps: opts.caps.maxSteps,
      signal: opts.signal,
    });
    tokensUsed = result.tokensUsed;
    rawActions = result.rawActions;
    if (result.error) {
      if (timer.fired()) {
        agentError = { kind: 'timed_out', message: result.error.message };
      } else if (result.error.kind === 'rate_limit') {
        agentError = { kind: 'exceeded_tokens', message: result.error.message };
      } else {
        agentError = { kind: 'errored', message: result.error.message };
      }
    }
  } finally {
    timer.clear(); // clear before downstream LLM calls so a late-fire doesn't kill them
  }

  // Fetch console + network events from Browserbase's server-side log capture.
  // Best-effort — empty if session was released too quickly.
  const targetOrigin = (() => {
    try {
      return new URL(opts.target.url).origin;
    } catch {
      return opts.target.url;
    }
  })();
  const collectedEvents = session
    ? await fetchSessionEvents({
        bb: opts.bb,
        sessionId: session.id,
        targetOrigin,
      })
    : { consoleErrors: [], networkFailures: [] };

  // Deterministic-issue lifter: console errors + 4xx/5xx network failures
  // become first-class Issues with source='lifter'.
  const { issues: lifterIssues } = liftDeterministicIssues(collectedEvents);

  // Adjudicator pass: reads trace + lifted issues, emits a Review.
  // Runs whenever there's trace content to adjudicate, even on timed_out /
  // exceeded_tokens / errored runs — the partial trace is still useful and
  // the adjudicator can verdict 'partial' or 'unclear' accordingly. Skipped
  // only when the agent produced zero actions or the run was SIGINT'd.
  let review: Review | null = null;
  let adjudicatorError: string | null = null;
  let adjudicatorErrorKind: AdjudicatorErrorKind | null = null;
  const haveTraceContent = rawActions.length > 0;
  if (haveTraceContent && !opts.signal.aborted) {
    try {
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
      const useAzureForAdj = adjModel.startsWith('anthropic/') && !!opts.credentials.anthropicBaseURL;
      const adjModelName = useAzureForAdj ? adjModel.replace(/^anthropic\//, '') : adjModel;

      review = await runAdjudicator({
        apiKey: pickModelApiKey(adjModel, opts.credentials),
        baseURL: useAzureForAdj ? opts.credentials.anthropicBaseURL : undefined,
        model: adjModelName,
        trace,
        liftedIssues: lifterIssues,
      });
    } catch (err) {
      // The adjudicator should always throw AdjudicatorError, but defend
      // against bugs (or buildTrace failures) that leak a different shape.
      if (err instanceof AdjudicatorError) {
        adjudicatorError = sanitizeText(err.message);
        adjudicatorErrorKind = err.kind;
      } else {
        const e = err as { name?: string; message?: string; stack?: string };
        const msg = e?.message ?? String(err);
        adjudicatorError = sanitizeText(`unexpected ${e?.name ?? 'error'}: ${msg}`);
        adjudicatorErrorKind = 'other';
        // Surface the unexpected error type so debugging is possible.
        log.warn(`${prefix} adjudicator threw non-AdjudicatorError (${e?.name ?? 'unknown'}): ${msg}`);
        if (process.env.MONKEY_DEBUG && e?.stack) {
          log.warn(e.stack);
        }
      }
      log.warn(
        `${prefix} adjudicator failed (${adjudicatorErrorKind}); shipping ${lifterIssues.length} lifter issue(s) only.`,
      );
    }
  }

  // Build terminal status. The adjudicator may have produced a real Review
  // even on partial-failure paths (timed_out / exceeded_tokens / errored),
  // since we now run the adjudicator whenever there's trace content. Prefer
  // that real Review; fall back to a synthetic only when adjudication didn't
  // run or itself failed.
  const ranForMs = elapsed(startedAt);
  let status: RunStatus;
  if (opts.signal.aborted) {
    status = { kind: 'aborted', review: reviewForAborted(), ranForMs };
  } else if (agentError?.kind === 'timed_out' || timer.fired()) {
    status = {
      kind: 'timed_out',
      review: review ?? reviewForTimedOut(lifterIssues),
      ranForMs,
    };
  } else if (agentError?.kind === 'exceeded_tokens') {
    // Today: 'exceeded_tokens' fires only on agent-side rate-limit/overload
    // (classifyError maps API 429/529 + Stagehand "Failed after N attempts"
    // to kind='rate_limit' which we wire here). Use the rate-limited
    // synthetic Review so the diagnostic surfaces 'rate_limited' (retry me)
    // not 'token_exceeded' (raise the budget). When real token-budget
    // enforcement lands, swap in reviewForExceededTokens for that path.
    status = {
      kind: 'exceeded_tokens',
      review: review ?? reviewForAgentRateLimited(lifterIssues),
      ranForMs,
    };
  } else if (agentError) {
    const errMsg = sanitizeText(agentError.message);
    status = {
      kind: 'errored',
      review: review ?? reviewForErrored(errMsg),
      error: errMsg,
      ranForMs,
    };
  } else if (adjudicatorError) {
    const kind = adjudicatorErrorKind ?? 'other';
    const synth =
      kind === 'rate_limit'
        ? reviewForAdjudicatorRateLimited(lifterIssues)
        : reviewForAdjudicatorFailed(lifterIssues, adjudicatorError, kind);
    status = {
      kind: 'adjudicator_failed',
      review: synth,
      error: adjudicatorError,
      errorKind: kind,
      ranForMs,
    };
  } else if (review) {
    status = { kind: 'completed', review, ranForMs, tokensUsed };
  } else {
    // Agent returned without errors but produced no actions — there's no
    // review to be had. Treat as a run-time error.
    const errMsg = 'Agent produced no actions';
    status = {
      kind: 'errored',
      review: reviewForErrored(errMsg),
      error: errMsg,
      ranForMs,
    };
  }

  return await finalize(opts, {
    session,
    stagehandHandle,
    reportPath,
    initialFm: initialFm!,
    startedAt,
    status,
    consoleErrors: collectedEvents.consoleErrors,
    networkFailures: collectedEvents.networkFailures,
  });
}

function elapsed(startedAt: Date): number {
  return Date.now() - startedAt.getTime();
}

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
  const consoleErrors = ctx.consoleErrors;
  const networkFailures = ctx.networkFailures;

  // Write terminal report
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
        consoleErrors,
        networkFailures,
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
  if (ctx.stagehandHandle) {
    await ctx.stagehandHandle.close();
  }
  if (ctx.session) {
    await ctx.session.close();
  }

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
    consoleErrors,
    networkFailures,
  };
}

async function writeNotStartedReport(
  opts: RunMissionOpts,
  startedAt: Date,
  err: Error,
): Promise<MissionResult> {
  const finishedAt = new Date();
  const reason = sanitizeText(`session create failed: ${err.message}`);

  // We can still write a report — initial + terminal in one go since there's no session_id.
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
