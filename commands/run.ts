// `monkey [--target <url>] [...missions]` — bare invocation. Runs missions.

import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { input } from '../lib/prompts/index.js';
import * as log from '../lib/log/stderr.js';
import { buildJsonOutput, emitJson } from '../lib/log/json.js';
import { loadConfig } from '../lib/config/load.js';
import { loadEnv, validateEnvForConfig } from '../lib/env/loadEnv.js';
import { createClient } from '../lib/bb/client.js';
import { readContextId } from '../lib/bb/context.js';
import { readLastTarget, writeLastTarget } from '../lib/env/lastTarget.js';
import { sweepStaleTmpFiles, sweepStaleRunningReports } from '../lib/report/write.js';
import { runMissions, summarizeCascadingFailures } from '../lib/runner/runMissions.js';
import { computeCost, formatCostSummary } from '../lib/cost/compute.js';
import {
  installSigintHandler,
  registerCleanup,
  getRootSignal,
} from '../lib/signal/abort.js';
import { runBootstrapAuth } from './bootstrap-auth.js';
import type { MissionResult, RunStatus } from '../lib/types.js';

export interface RunOpts {
  projectDir: string;
  target: string | undefined;
  positionalMissions: string[];
  dryRun: boolean;
  json: boolean;
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
  const cwd = resolve(opts.projectDir);
  const reportsDir = join(cwd, 'reports');

  const { config, configDir } = await loadConfig(cwd);
  const env = loadEnv(cwd);
  validateEnvForConfig(env, config);

  // Sweep stale temp files + running reports from prior crashes (best-effort).
  await sweepStaleTmpFiles(reportsDir, 10 * 60 * 1000);
  await sweepStaleRunningReports({ reportsDir, wallClockMs: config.caps.wallClockMs });

  // Resolve target URL
  let target = opts.target;
  if (!target) {
    const lastTarget = await readLastTarget(cwd);
    if (opts.nonInteractive) {
      if (lastTarget) {
        target = lastTarget;
      } else {
        throw new NonInteractiveError(
          '--non-interactive set but URL is missing. Pass --target <url>.',
        );
      }
    } else {
      target = await input({
        message: 'Target URL:',
        default: lastTarget ?? undefined,
        validate: (v) => {
          try {
            new URL(v);
            return true;
          } catch {
            return 'Must be a valid URL';
          }
        },
      });
    }
  }

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

  // Echo missions to stderr (defense against prompt injection — user sees
  // exactly what the agent will receive, including any hidden chars).
  log.blank();
  log.info(`Target: ${target}`);
  log.info(`Missions (${missions.length}):`);
  missions.forEach((m, i) => {
    log.info(`  [${i + 1}/${missions.length}] ${JSON.stringify(m)}`);
  });
  log.blank();

  if (opts.dryRun) {
    log.info('--dry-run: not spawning sessions.');
    if (opts.json) {
      const version = await readPackageVersion();
      emitJson(buildJsonOutput({ monkeyVersion: version, results: [], walledMs: 0 }));
    }
    return 0;
  }

  // Need a context-id for the run. If missing, run bootstrap-auth first.
  const contextId = await readContextId(cwd);
  if (!contextId) {
    log.warn('No .context-id — bootstrapping auth first.');
    const code = await runBootstrapAuth({ projectDir: cwd, quiet: true });
    if (code !== 0) return code;
  }
  const finalContextId = (await readContextId(cwd))!;

  // Wire SIGINT
  installSigintHandler();
  const bb = createClient(env.BROWSERBASE_API_KEY);
  registerCleanup(async () => {
    // Best-effort: just let the per-mission cleanups run. SIGINT propagates
    // through the abort signal to runMission's finally blocks.
  });

  const invocationId = randomUUID().slice(0, 8);
  const startedAt = Date.now();

  const results = await runMissions({
    missions,
    target,
    bb,
    projectId: env.BROWSERBASE_PROJECT_ID,
    contextId: finalContextId,
    reportsDir,
    configDir,
    authMode: config.authMode,
    caps: config.caps,
    stagehandModel: config.stagehandModel,
    agentModel: config.agentModel,
    env,
    invocationId,
    signal: getRootSignal(),
    onReauthNeeded: async () => {
      log.fail('Auth expired. Re-authenticating…');
      await runBootstrapAuth({ projectDir: cwd, quiet: true });
    },
  });

  // Write last-target after a successful run (atomic write — handles parallel
  // monkey invocations from the same shell).
  await writeLastTarget(cwd, target);

  const walledMs = Date.now() - startedAt;

  if (opts.json) {
    const version = await readPackageVersion();
    emitJson(buildJsonOutput({ monkeyVersion: version, results, walledMs }));
  } else {
    printSummary(results, walledMs);

    // Cascading shared failure (all missions errored with same root cause)
    const cascade = summarizeCascadingFailures(results);
    if (cascade) {
      log.blank();
      log.warn(cascade);
    }
  }

  // Exit code: 0 if any completed cleanly, else 1
  const anyCompleted = results.some((r) => r.status.kind === 'completed');
  return anyCompleted ? 0 : 1;
}

function printSummary(results: MissionResult[], wallMs: number): void {
  log.blank();
  log.info('─── Run summary ────────────────────────────────');
  const total = results.length;
  const completed = results.filter((r) => r.status.kind === 'completed').length;

  log.info(`${completed}/${total} mission(s) completed in ${fmtDuration(wallMs)}${total > 1 ? ' (wall — ran in parallel)' : ''}.`);

  // Aggregate findings count + severity counts
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

  // Status breakdown for non-completed missions
  const failed = results.filter((r) => r.status.kind !== 'completed');
  if (failed.length > 0) {
    log.info(`Issues:`);
    for (const r of failed) {
      const errStr =
        r.status.kind === 'errored' || r.status.kind === 'extract_failed'
          ? `: ${r.status.error}`
          : r.status.kind === 'not_started'
            ? `: ${r.status.reason}`
            : '';
      log.info(`  ${r.mission} → ${r.status.kind}${errStr}`);
    }
  }

  // Aggregate cost
  let totalDollars = 0;
  let totalTokens = 0;
  let bbMinutes = 0;
  for (const r of results) {
    const ranForMs = ranForMsOf(r.status);
    if (ranForMs == null) continue;
    const tokensUsed =
      r.status.kind === 'completed' ? r.status.tokensUsed : undefined;
    const c = computeCost({ ranForMs, tokensUsed });
    totalDollars += c.totalDollars;
    if (c.tokens) totalTokens += c.tokens;
    bbMinutes += c.bbMinutes;
  }
  log.info(formatCostSummary({
    bbMinutes,
    bbDollars: bbMinutes * 0.10,
    tokens: totalTokens || null,
    llmDollars: totalTokens ? (totalTokens / 1_000_000) * 10 : null,
    totalDollars,
  }));

  // Report paths
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

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}
