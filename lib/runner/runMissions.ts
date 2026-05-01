// Parallel mission orchestration. Promise.all + per-mission .catch so one
// mission's failure doesn't abort the batch. Shared AbortController flows
// through to runMission via opts.signal.
//
// Pre-flight check: if missions.length exceeds the BB plan's concurrent
// session limit, surface a friendly error.

import * as log from '../log/stderr.js';
import { runMission, type RunMissionOpts } from './runMission.js';
import type { MissionResult } from '../types.js';

const DEFAULT_BB_CONCURRENT_LIMIT = 3; // Developer plan default

export interface RunMissionsOpts extends Omit<RunMissionOpts, 'index' | 'total' | 'mission'> {
  missions: string[];
}

export async function runMissions(opts: RunMissionsOpts): Promise<MissionResult[]> {
  const limit = Number(process.env.BROWSERBASE_CONCURRENT_LIMIT) || DEFAULT_BB_CONCURRENT_LIMIT;
  if (opts.missions.length > limit) {
    log.warn(
      `You requested ${opts.missions.length} parallel missions, but the configured ` +
        `concurrent-session limit is ${limit}.`,
    );
    log.info(
      '  This usually matches a Browserbase plan tier (Developer = 3, Pro = 10, etc.).',
    );
    log.info(
      '  Set BROWSERBASE_CONCURRENT_LIMIT in .env.local to override, or run with fewer args.',
    );
    log.info('');
    log.info('  Continuing anyway — Browserbase will reject overflow sessions with errors.');
    log.blank();
  }

  const total = opts.missions.length;

  const tasks = opts.missions.map((mission, index) =>
    runMission({
      ...opts,
      mission,
      index,
      total,
    }).catch((err) => {
      // Defensive: should never throw to here; runMission catches its own errors
      // and returns a MissionResult with errored status. But just in case:
      const finishedAt = new Date().toISOString();
      const result: MissionResult = {
        index,
        total,
        mission,
        target: opts.target,
        status: { kind: 'errored', error: (err as Error).message, ranForMs: 0 },
        sessionId: null,
        replayUrl: null,
        startedAt: finishedAt,
        finishedAt,
        reportPath: '',
        consoleErrors: [],
        networkFailures: [],
      };
      return result;
    }),
  );

  return Promise.all(tasks);
}

// After all missions complete: detect cascading shared failures (all errored
// with the same root-cause message) and surface a single summary instead of
// N independent error messages.
export function summarizeCascadingFailures(results: MissionResult[]): string | null {
  if (results.length < 2) return null;
  const errored = results.filter(
    (r) => r.status.kind === 'errored' || r.status.kind === 'extract_failed',
  );
  if (errored.length !== results.length) return null;
  const messages = new Set(
    errored.map((r) => {
      if (r.status.kind === 'errored' || r.status.kind === 'extract_failed') {
        return r.status.error;
      }
      return '';
    }),
  );
  if (messages.size !== 1) return null;
  const [shared] = messages;
  return `All ${results.length} missions failed with the same error: ${shared}`;
}
