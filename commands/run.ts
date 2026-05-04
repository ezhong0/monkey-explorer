// `monkey [--target <name>] [...missions]` — bare invocation. Runs missions
// against the resolved target (current or --target).

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { input } from '../lib/prompts/index.js';
import * as log from '../lib/log/stderr.js';
import { buildJsonOutput, emitJson } from '../lib/log/json.js';
import { requireGlobalState } from '../lib/state/load.js';
import { updateTarget } from '../lib/state/save.js';
import { resolveTarget } from '../lib/state/predicates.js';
import { getReportsBaseDir } from '../lib/state/path.js';
import { createClient } from '../lib/bb/client.js';
import { sweepStaleTmpFiles, sweepStaleRunningReports } from '../lib/report/write.js';
import { runMissions, summarizeCascadingFailures } from '../lib/runner/runMissions.js';
import {
  computeCost,
  estimateCostRange,
  formatCostEstimate,
  formatCostSummary,
} from '../lib/cost/compute.js';
import { modelProvider } from '../lib/stagehand/modelKey.js';
import { runBootstrapAuth } from './bootstrap-auth.js';
import type { Credentials, Defaults } from '../lib/state/schema.js';
import {
  installSigintHandler,
  registerCleanup,
  getRootSignal,
} from '../lib/signal/abort.js';
import type { MissionResult, RunStatus } from '../lib/types.js';

export interface RunOpts {
  targetName: string | undefined;
  positionalMissions: string[];
  dryRun: boolean;
  json: boolean;
  /** When true, include speculative-tier findings in report + JSON.
   *  Default: hide them entirely (only verified findings surface). */
  includeSpeculative: boolean;
  nonInteractive: boolean;
}

class NonInteractiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonInteractiveError';
  }
}

async function readPackageVersion(): Promise<string> {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pj = await readFile(join(__dirname, '..', 'package.json'), 'utf-8');
    return JSON.parse(pj).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function runRun(opts: RunOpts): Promise<number> {
  const state = await requireGlobalState();
  const credentials = state.credentials!;
  const reportsBaseDir = getReportsBaseDir();

  // Resolve target.
  const { name: targetName, target } = resolveTarget(state, opts.targetName);
  const reportsDir = join(reportsBaseDir, targetName);

  // Sweep stale temp/running reports for this target's reports dir.
  await sweepStaleTmpFiles(reportsDir, 10 * 60 * 1000);
  await sweepStaleRunningReports({
    reportsDir,
    wallClockMs: state.defaults.caps.wallClockMs,
  });

  // Resolve missions
  let missions = opts.positionalMissions;
  if (missions.length === 0) {
    if (opts.nonInteractive) {
      throw new NonInteractiveError(
        '--non-interactive set but mission is missing. Pass at least one positional mission.',
      );
    }
    const single = await input({
      message: 'What do you want monkey-explorer to do?',
      validate: (v) => (v.trim().length > 0 ? true : 'Mission cannot be empty'),
    });
    missions = [single];
  }

  // Preflight: ensure every model in defaults has a matching API key.
  // Fails loud with an actionable message before any session spawns.
  const keyValidation = validateModelKeys(state.defaults, credentials);
  if (keyValidation) {
    log.fail(keyValidation);
    return 1;
  }

  // Echo missions to stderr (defense against prompt injection).
  log.blank();
  log.info(`Target: ${targetName} (${target.url})`);
  log.info(`Missions (${missions.length}):`);
  missions.forEach((m, i) => {
    log.info(`  [${i + 1}/${missions.length}] ${JSON.stringify(m)}`);
  });
  log.info(
    formatCostEstimate(
      estimateCostRange({
        missionCount: missions.length,
        wallClockMs: state.defaults.caps.wallClockMs,
        agentModel: state.defaults.agentModel,
      }),
      missions.length,
    ),
  );
  log.blank();

  if (opts.dryRun) {
    log.info('--dry-run: not spawning sessions.');
    if (opts.json) {
      const version = await readPackageVersion();
      emitJson(
        buildJsonOutput({
          monkeyVersion: version,
          results: [],
          walledMs: 0,
          includeSpeculative: opts.includeSpeculative,
        }),
      );
    }
    return 0;
  }

  // Always bootstrap before missions. Eliminates the staleness bug class
  // (mission sessions inheriting old context cookies) by guaranteeing the
  // BB context has fresh cookies right before any mission session attaches.
  // Skipped only for auth-mode=none.
  if (target.authMode.kind !== 'none') {
    log.step(`Bootstrapping auth for "${targetName}"…`);
    const code = await runBootstrapAuth({
      targetName,
      nonInteractive: opts.nonInteractive,
    });
    if (code !== 0) return code;
  }

  // Re-load state in case bootstrap-auth minted a fresh contextId.
  const refreshedState = await requireGlobalState();
  const refreshedTarget = refreshedState.targets[targetName]!;

  installSigintHandler();
  const bb = createClient(credentials.browserbaseApiKey);
  registerCleanup(async () => {
    // Best-effort: per-mission cleanups handle SIGINT propagation.
  });

  // In --json mode, Stagehand's internal logging can leak to stdout (some
  // paths bypass both pino and the logger callback). We hijack stdout for
  // the duration of mission execution, redirecting writes to stderr, and
  // restore it before emitJson. Keeps the JSON output channel clean.
  const restoreStdout = opts.json ? quarantineStdout() : null;

  const invocationId = randomUUID().slice(0, 8);
  const startedAt = Date.now();

  const results = await runMissions({
    missions,
    target: refreshedTarget,
    targetName,
    bb,
    projectId: credentials.browserbaseProjectId,
    contextId: refreshedTarget.contextId,
    reportsDir,
    authMode: refreshedTarget.authMode,
    caps: refreshedState.defaults.caps,
    stagehandModel: refreshedState.defaults.stagehandModel,
    agentModel: refreshedState.defaults.agentModel,
    adjudicatorModel: refreshedState.defaults.adjudicatorModel,
    credentials,
    invocationId,
    signal: getRootSignal(),
  });

  // Update lastUsed (best-effort — last-write-wins on concurrent runs).
  await updateTarget(targetName, (t) => ({ ...t, lastUsed: new Date().toISOString() })).catch(
    () => {},
  );

  const walledMs = Date.now() - startedAt;

  if (opts.json) {
    const version = await readPackageVersion();
    // Restore stdout so emitJson writes to the real channel, not stderr.
    if (restoreStdout) restoreStdout();
    emitJson(
      buildJsonOutput({
        monkeyVersion: version,
        results,
        walledMs,
        includeSpeculative: opts.includeSpeculative,
      }),
    );
  } else {
    printSummary(results, walledMs, refreshedState.defaults.agentModel);
    const cascade = summarizeCascadingFailures(results);
    if (cascade) {
      log.blank();
      log.warn(cascade);
    }
  }

  const anyCompleted = results.some((r) => r.status.kind === 'completed');
  return anyCompleted ? 0 : 1;
}

function printSummary(results: MissionResult[], wallMs: number, agentModel: string): void {
  log.blank();
  log.info('─── Run summary ────────────────────────────────');
  const total = results.length;
  const completed = results.filter((r) => r.status.kind === 'completed').length;

  log.info(`${completed}/${total} mission(s) completed in ${fmtDuration(wallMs)}${total > 1 ? ' (wall — ran in parallel)' : ''}.`);

  let findingsTotal = 0;
  const sevCounts: Record<string, number> = {};
  for (const r of results) {
    if (r.status.kind === 'completed' || r.status.kind === 'timed_out' || r.status.kind === 'exceeded_tokens') {
      findingsTotal += r.status.findings.length;
      for (const f of r.status.findings) {
        sevCounts[f.severity] = (sevCounts[f.severity] ?? 0) + 1;
      }
    }
  }
  if (findingsTotal > 0) {
    const sevStr = Object.entries(sevCounts)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ');
    log.info(`${findingsTotal} findings — ${sevStr}`);
  }

  const failed = results.filter((r) => r.status.kind !== 'completed');
  if (failed.length > 0) {
    log.info(`Issues:`);
    for (const r of failed) {
      const errStr =
        r.status.kind === 'errored' || r.status.kind === 'adjudicator_failed'
          ? `: ${r.status.error}`
          : r.status.kind === 'not_started'
            ? `: ${r.status.reason}`
            : '';
      log.info(`  ${r.mission} → ${r.status.kind}${errStr}`);
    }
  }

  let totalDollars = 0;
  let totalTokens = 0;
  let totalLlmDollars = 0;
  let bbMinutes = 0;
  let effectiveRate = 0;
  for (const r of results) {
    const ranForMs = ranForMsOf(r.status);
    if (ranForMs == null) continue;
    const tokensUsed =
      r.status.kind === 'completed' ? r.status.tokensUsed : undefined;
    const c = computeCost({ ranForMs, tokensUsed, agentModel });
    totalDollars += c.totalDollars;
    if (c.tokens) totalTokens += c.tokens;
    if (c.llmDollars) totalLlmDollars += c.llmDollars;
    bbMinutes += c.bbMinutes;
    effectiveRate = c.effectiveRate;
  }
  log.info(formatCostSummary({
    bbMinutes,
    bbDollars: bbMinutes * 0.10,
    tokens: totalTokens || null,
    llmDollars: totalTokens ? totalLlmDollars : null,
    totalDollars,
    effectiveRate,
  }));

  const writtenReports = results.map((r) => r.reportPath).filter(Boolean);
  if (writtenReports.length > 0) {
    log.info(`Report${writtenReports.length > 1 ? 's' : ''}:`);
    writtenReports.forEach((p) => log.info(`  ${p}`));
  }
}

function ranForMsOf(s: RunStatus): number | null {
  if ('ranForMs' in s) return s.ranForMs;
  return null;
}

/**
 * Returns null if every configured model has a matching API key, or a
 * user-facing error string if any model would fail at runtime. Adjudicator
 * model is optional; checked only if set.
 */
function validateModelKeys(defaults: Defaults, creds: Credentials): string | null {
  const slots: Array<[label: string, model: string]> = [
    ['stagehandModel', defaults.stagehandModel],
    ['agentModel', defaults.agentModel],
  ];
  if (defaults.adjudicatorModel) slots.push(['adjudicatorModel', defaults.adjudicatorModel]);

  for (const [label, model] of slots) {
    const provider = modelProvider(model);
    if (provider === 'anthropic' && !creds.anthropicApiKey) {
      return (
        `${label} is set to "${model}" but no Anthropic API key is configured. ` +
        `Run \`monkey login\` to add one, or \`monkey config\` to switch ${label} to an OpenAI model.`
      );
    }
    if ((provider === 'openai' || provider === 'other') && !creds.openaiApiKey) {
      return (
        `${label} is set to "${model}" but no OpenAI API key is configured. ` +
        `Run \`monkey login\` to add one, or \`monkey config\` to switch ${label} to an Anthropic model.`
      );
    }
  }
  return null;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

/**
 * Hijack process.stdout.write to redirect all output to stderr. Returns a
 * restore function. Used in --json mode to keep stdout clean of Stagehand's
 * stray DEBUG output that bypasses the logger callback.
 */
function quarantineStdout(): () => void {
  const originalWrite = process.stdout.write.bind(process.stdout);
  // The real signature has overloads (string|Uint8Array, encoding?, callback?).
  // We just funnel everything to stderr.write.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    return process.stderr.write(chunk, ...rest);
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = originalWrite;
  };
}
