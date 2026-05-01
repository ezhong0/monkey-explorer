// JSON output mode — emits a single aggregate object to stdout at the end
// of a `monkey [...missions]` run. Used for agentic / CI consumption.
//
// Schema is intended to be stable. If we ever break it, bump the
// `monkey_version` field and document the change.

import type { AdjudicatorErrorKind, Finding, MissionResult, RunStatus } from '../types.js';
import { aggregateVerdict, type Verdict } from '../runner/verdict.js';

export type { Verdict };

export interface JsonOutputMission {
  mission: string;
  target: string;
  status: string;
  /** PASS / FAIL / INCONCLUSIVE — Claude Code's primary signal. Derived
   *  from verified findings: any critical/high → fail; zero verified → pass;
   *  otherwise inconclusive. Mission-level errors (timeout, errored,
   *  not_started) → fail. */
  verdict: Verdict;
  ranForMs: number | null;
  startedAt: string;
  finishedAt: string;
  findings: Finding[];                  // verified-tier only by default
  findingsCount: number;                // count of verified
  speculativeFindings?: Finding[];      // present only when --include-speculative
  consoleErrors: unknown[];
  networkFailures: unknown[];
  tokensUsed: number | null;
  error: string | null;
  /** Populated when status === 'adjudicator_failed'. Lets CI/Claude Code
   *  decide whether the failure is retryable (rate_limit) or not (parse). */
  adjudicatorErrorKind: AdjudicatorErrorKind | null;
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
    /** Top-level verdict across all missions: PASS iff every mission is PASS,
     *  FAIL if any mission is FAIL, INCONCLUSIVE otherwise. */
    verdict: Verdict;
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
  /** When true, emit speculative findings alongside verified in the
   *  speculativeFindings field. Default: hide them entirely. */
  includeSpeculative?: boolean;
}): JsonOutput {
  const missions = opts.results.map((r) => toJsonMission(r, opts.includeSpeculative ?? false));
  return {
    monkey_version: opts.monkeyVersion,
    missions,
    summary: {
      total: missions.length,
      completed: missions.filter((m) => m.status === 'completed').length,
      failed: missions.filter((m) => m.verdict === 'fail').length,
      verdict: aggregateVerdict(missions.map((m) => m.verdict)),
      findingsTotal: missions.reduce((sum, m) => sum + m.findingsCount, 0),
      consoleErrorsTotal: missions.reduce((sum, m) => sum + m.consoleErrors.length, 0),
      networkFailuresTotal: missions.reduce((sum, m) => sum + m.networkFailures.length, 0),
      walledMs: opts.walledMs,
    },
  };
}

function toJsonMission(r: MissionResult, includeSpeculative: boolean): JsonOutputMission {
  const ranForMs = ranForMsOf(r.status);
  const allFindings = findingsOf(r.status);
  const verified = allFindings.filter((f) => f.tier !== 'speculative');
  const speculative = allFindings.filter((f) => f.tier === 'speculative');
  return {
    mission: r.mission,
    target: r.target,
    status: r.status.kind,
    verdict: r.verdict,
    ranForMs,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    findings: verified,
    findingsCount: verified.length,
    ...(includeSpeculative ? { speculativeFindings: speculative } : {}),
    consoleErrors: r.consoleErrors,
    networkFailures: r.networkFailures,
    tokensUsed: tokensOf(r.status),
    error: errorOf(r.status),
    adjudicatorErrorKind: r.status.kind === 'adjudicator_failed' ? r.status.errorKind : null,
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
function findingsOf(s: RunStatus): Finding[] {
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
