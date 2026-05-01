// JSON output mode — emits a single aggregate object to stdout at the end
// of a `monkey [...missions]` run. Used for agentic / CI consumption.
//
// Schema is intended to be stable. If we ever break it, bump the
// `monkey_version` field and document the change.

import type { MissionResult, RunStatus } from '../types.js';

export interface JsonOutputMission {
  mission: string;
  target: string;
  status: string;
  ranForMs: number | null;
  startedAt: string;
  finishedAt: string;
  findings: unknown[];
  findingsCount: number;
  consoleErrors: unknown[];
  networkFailures: unknown[];
  tokensUsed: number | null;
  error: string | null;
  reason: string | null;
  sessionId: string | null;
  replayUrl: string | null;
  reportPath: string;
}

export interface JsonOutput {
  monkey_version: string;
  missions: JsonOutputMission[];
  summary: {
    total: number;
    completed: number;
    failed: number;
    findingsTotal: number;
    consoleErrorsTotal: number;
    networkFailuresTotal: number;
    walledMs: number;
  };
}

export function buildJsonOutput(opts: {
  monkeyVersion: string;
  results: MissionResult[];
  walledMs: number;
}): JsonOutput {
  const missions = opts.results.map(toJsonMission);
  return {
    monkey_version: opts.monkeyVersion,
    missions,
    summary: {
      total: missions.length,
      completed: missions.filter((m) => m.status === 'completed').length,
      failed: missions.filter((m) => m.status !== 'completed').length,
      findingsTotal: missions.reduce((sum, m) => sum + m.findingsCount, 0),
      consoleErrorsTotal: missions.reduce((sum, m) => sum + m.consoleErrors.length, 0),
      networkFailuresTotal: missions.reduce((sum, m) => sum + m.networkFailures.length, 0),
      walledMs: opts.walledMs,
    },
  };
}

function toJsonMission(r: MissionResult): JsonOutputMission {
  const ranForMs = ranForMsOf(r.status);
  const findings = findingsOf(r.status);
  return {
    mission: r.mission,
    target: r.target,
    status: r.status.kind,
    ranForMs,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    findings,
    findingsCount: findings.length,
    consoleErrors: r.consoleErrors,
    networkFailures: r.networkFailures,
    tokensUsed: tokensOf(r.status),
    error: errorOf(r.status),
    reason: reasonOf(r.status),
    sessionId: r.sessionId,
    replayUrl: r.replayUrl,
    reportPath: r.reportPath,
  };
}

function ranForMsOf(s: RunStatus): number | null {
  if ('ranForMs' in s) return s.ranForMs;
  return null;
}
function findingsOf(s: RunStatus): unknown[] {
  if ('findings' in s) return s.findings;
  return [];
}
function tokensOf(s: RunStatus): number | null {
  if (s.kind === 'completed' && s.tokensUsed != null) return s.tokensUsed;
  return null;
}
function errorOf(s: RunStatus): string | null {
  if ('error' in s) return s.error;
  return null;
}
function reasonOf(s: RunStatus): string | null {
  if ('reason' in s) return s.reason;
  return null;
}

export function emitJson(out: JsonOutput): void {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
