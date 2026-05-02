// Execute a single mission end-to-end:
//   1. Create report at start (status: running)
//   2. Create BB session + fetch live view URL
//   3. Print [N/M] header with live view + replay URLs
//   4. Connect Stagehand
//   5. Probe — if sign-in-page, run auth dispatch + retry probe (1x)
//   6. Execute agent (CUA loop with record_observation tool)
//   7. Fetch session events (console + network) post-mission
//   8. Lift deterministic findings (console errors + 4xx/5xx)
//   9. Build in-memory trace; run adjudicator with provenance enforcement
//   10. Combine lifter + adjudicator findings; update report; close session
//
// Each step's failure mode is mapped onto the RunStatus discriminated union.

import { randomUUID } from 'node:crypto';
import * as log from '../log/stderr.js';
import { computeCost, formatCostSummary } from '../cost/compute.js';
import { probe } from '../probe/probe.js';
import { sanitizeText } from '../findings/sanitize.js';
import { writeReportInitial, writeReportTerminal } from '../report/write.js';
import { startWallClockTimer } from './caps.js';
import { createSession, type MonkeySession } from '../bb/session.js';
import { createStagehand } from '../stagehand/adapter.js';
import { executeAgent, type RecordedObservation } from '../stagehand/agent.js';
import { liftDeterministicFindings } from '../observe/promote.js';
import { pickModelApiKey } from '../stagehand/modelKey.js';
import { buildTrace } from '../trace/build.js';
import { runAdjudicator, AdjudicatorError } from '../adjudicate/run.js';
import { fetchSessionEvents } from '../observe/fetchEvents.js';
import { deriveVerdict } from './verdict.js';
import type { Browserbase } from '../bb/client.js';
import type {
  AdjudicatorErrorKind,
  ConsoleEvent,
  Finding,
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
    // Session creation itself failed — write a not_started report.
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
    return await finalize(opts, {
      session,
      stagehandHandle: null,
      reportPath,
      initialFm: initialFm!,
      startedAt,
      status: { kind: 'errored', error: (err as Error).message, ranForMs: elapsed(startedAt) },
      findings: [],
      observations: [],
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
        status: { kind: 'not_started', reason },
        findings: [],
        observations: [],
        consoleErrors: [],
        networkFailures: [],
      });
    }

    log.ok(`${prefix} Probe passed.`);
  } catch (err) {
    return await finalize(opts, {
      session,
      stagehandHandle,
      reportPath,
      initialFm: initialFm!,
      startedAt,
      status: { kind: 'errored', error: (err as Error).message, ranForMs: elapsed(startedAt) },
      findings: [],
      observations: [],
      consoleErrors: [],
      networkFailures: [],
    });
  }

  // Run the agent with wall-clock timer.
  let agentSucceeded = false;
  let tokensUsed: number | undefined;
  let agentError: { kind: RunStatus['kind']; message: string } | null = null;
  let observations: RecordedObservation[] = [];
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
      instruction: opts.mission,
      maxSteps: opts.caps.maxSteps,
      signal: opts.signal,
    });
    agentSucceeded = result.success;
    tokensUsed = result.tokensUsed;
    observations = result.observations;
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

  // Deterministic-finding lifter: console errors + 4xx/5xx network failures
  // become first-class `verified` findings. No LLM judgment.
  const { findings: liftedFindings, introducedStepIds: liftedStepIdsList } = liftDeterministicFindings({
    consoleErrors: collectedEvents.consoleErrors,
    networkFailures: collectedEvents.networkFailures,
  });

  // Adjudicator pass: reads the trace + lifted findings, emits additional
  // findings with cited provenance and rubric-derived severity. Skipped if
  // the explorer failed badly (no actions, no observations) or if the
  // mission was aborted/timed-out — there's nothing to adjudicate over.
  let findings: Finding[] = liftedFindings;
  let adjudicatorError: string | null = null;
  let adjudicatorErrorKind: AdjudicatorErrorKind | null = null;
  const haveTraceContent = rawActions.length > 0 || observations.length > 0;
  if (haveTraceContent && !agentError && !timer.fired() && !opts.signal.aborted) {
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
        observations,
        consoleErrors: collectedEvents.consoleErrors,
        networkFailures: collectedEvents.networkFailures,
      });

      const adjModel = opts.adjudicatorModel ?? opts.agentModel;
      const useAzureForAdj = adjModel.startsWith('anthropic/') && !!opts.credentials.anthropicBaseURL;
      const adjModelName = useAzureForAdj ? adjModel.replace(/^anthropic\//, '') : adjModel;

      const adjudicated = await runAdjudicator({
        apiKey: pickModelApiKey(adjModel, opts.credentials),
        baseURL: useAzureForAdj ? opts.credentials.anthropicBaseURL : undefined,
        model: adjModelName,
        trace,
        liftedFindings,
        liftedStepIds: new Set(liftedStepIdsList),
      });

      findings = [...liftedFindings, ...adjudicated];
    } catch (err) {
      const ae = err as AdjudicatorError;
      adjudicatorError = sanitizeText(ae.message);
      adjudicatorErrorKind = ae.kind;
      log.warn(`${prefix} adjudicator failed (${ae.kind}); shipping ${liftedFindings.length} deterministic findings only.`);
    }
  }

  // Build terminal status. Adjudicator failure is treated as mission-
  // completed-with-warning: deterministic findings still ship, but the run
  // is marked `adjudicator_failed` so consumers can distinguish.
  const ranForMs = elapsed(startedAt);
  let status: RunStatus;
  if (opts.signal.aborted) {
    status = { kind: 'aborted', ranForMs };
  } else if (agentError?.kind === 'timed_out' || timer.fired()) {
    status = { kind: 'timed_out', findings, ranForMs };
  } else if (agentError?.kind === 'exceeded_tokens') {
    status = { kind: 'exceeded_tokens', findings, ranForMs };
  } else if (agentError) {
    status = { kind: 'errored', error: sanitizeText(agentError.message), ranForMs };
  } else if (adjudicatorError) {
    status = {
      kind: 'adjudicator_failed',
      error: adjudicatorError,
      errorKind: adjudicatorErrorKind ?? 'other',
      findings,
      ranForMs,
    };
  } else {
    void agentSucceeded; // currently informational; verdict derives from findings instead
    status = { kind: 'completed', findings, ranForMs, tokensUsed };
  }

  return await finalize(opts, {
    session,
    stagehandHandle,
    reportPath,
    initialFm: initialFm!,
    startedAt,
    status,
    findings,
    observations,
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
    findings: Finding[];
    observations: RecordedObservation[];
    consoleErrors: ConsoleEvent[];
    networkFailures: NetworkFailure[];
  },
): Promise<MissionResult> {
  const finishedAt = new Date();
  const sessionId = ctx.session?.id ?? '';
  const replayUrl = ctx.session?.replayUrl ?? '';
  const consoleErrors = ctx.consoleErrors;
  const networkFailures = ctx.networkFailures;
  // Observations are captured in the trace + fed to the adjudicator; we
  // don't surface them as a separate report section today. If the adjudicator
  // turned an observation into a finding, it shows up there.
  void ctx.observations;

  // Write terminal report
  let costSummary: string | undefined;
  if (ctx.status.kind === 'completed') {
    const cost = computeCost({
      ranForMs: ctx.status.ranForMs,
      tokensUsed: ctx.status.tokensUsed,
    });
    costSummary = formatCostSummary(cost);
  }

  if (ctx.reportPath) {
    try {
      await writeReportTerminal({
        filePath: ctx.reportPath,
        initialFm: ctx.initialFm,
        status: ctx.status,
        findings: ctx.findings,
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

  const verifiedForVerdict = ctx.findings.filter((f) => f.tier !== 'speculative');
  return {
    index: opts.index,
    total: opts.total,
    mission: opts.mission,
    target: opts.target.url,
    status: ctx.status,
    verdict: deriveVerdict(ctx.status, verifiedForVerdict),
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

  const status: RunStatus = { kind: 'not_started', reason };

  if (initial) {
    await writeReportTerminal({
      filePath: initial.filePath,
      initialFm: initial.frontMatter,
      status,
      findings: [],
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
    verdict: deriveVerdict(status, []),
    sessionId: null,
    replayUrl: null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    reportPath: initial?.filePath ?? '',
    consoleErrors: [],
    networkFailures: [],
  };
}
