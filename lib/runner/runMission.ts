// Execute a single mission end-to-end:
//   1. Create report at start (status: running)
//   2. Create BB session + fetch live view URL
//   3. Print [N/M] header with live view + replay URLs
//   4. Connect Stagehand
//   5. Probe — if sign-in-page, run auth dispatch + retry probe (1x)
//   6. Execute agent (with wall-clock timer guarding)
//   7. Extract findings (in finally — wall-clock timer cleared first)
//   8. Update report with terminal status
//   9. Close session
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
import type { Browserbase } from '../bb/client.js';
import type {
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
  // Auto-reauth callback — runMission asks the caller to refresh the
  // BB context's cookie when probe returns sign-in-page.
  onReauthNeeded: () => Promise<void>;
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
      modelApiKey: opts.credentials.openaiApiKey,
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

  // Probe → maybe re-auth.
  try {
    const page = await stagehandHandle.page();
    let probeResult = await probe({ page, stagehand: stagehandHandle.stagehand, target: opts.target.url });

    if (probeResult.kind === 'sign-in-page') {
      log.fail(`${prefix} Auth expired. Re-authenticating…`);
      await opts.onReauthNeeded(); // refreshes BB context cookie
      // After re-auth, the session's cookie may need a re-navigation.
      probeResult = await probe({ page, stagehand: stagehandHandle.stagehand, target: opts.target.url });
    }

    if (probeResult.kind !== 'ok') {
      const reason =
        probeResult.kind === 'unreachable'
          ? `unreachable: ${probeResult.details}`
          : probeResult.kind === 'sign-in-page'
            ? `re-auth failed; run \`monkey bootstrap-auth --target ${opts.targetName}\``
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
      log.warn(`${prefix} adjudicator failed (${ae.kind}); shipping ${liftedFindings.length} deterministic findings only.`);
    }
  }
  let extractError: string | null = null;
  void extractError; // legacy, retired with the extract path

  // Build terminal status. Note: handle-closed-during-extract is treated as
  // a successful mission (the agent did its work; findings extraction is a
  // best-effort second step). Other extract errors fail the mission.
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
    // Mission completed; adjudicator failed. Deterministic findings still ship.
    status = {
      kind: 'adjudicator_failed',
      error: adjudicatorError,
      findings,
      ranForMs,
    };
  } else {
    void agentSucceeded;
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
  void ctx.observations; // Phase 4/6 will surface these in the report

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
    sessionId: null,
    replayUrl: null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    reportPath: initial?.filePath ?? '',
    consoleErrors: [],
    networkFailures: [],
  };
}
