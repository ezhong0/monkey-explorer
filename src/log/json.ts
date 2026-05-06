// JSON output mode — emits a single aggregate object to stdout at the end
// of a `monkey [...missions]` run. Used for agentic / CI consumption.
//
// Schema is intended to be stable. If we ever break it, bump the
// `monkey_version` field and document the change.
//
// The reframe: each mission carries a `verdict` (works | broken | partial
// | unclear) plus the full `review` object. Claude branches on `verdict`
// to decide ship/iterate; details live in `review` for triage.

import type { Review, Verdict } from '../review/schema.js';
import type {
  AdjudicatorErrorKind,
  ConsoleEvent,
  MissionResult,
  NetworkFailure,
  RunStatus,
} from '../types.js';

export type { Verdict };

export interface JsonOutputMission {
  mission: string;
  target: string;

  /** Per-mission verdict — Claude's primary branch signal. */
  verdict: Verdict;
  /** 1–3 sentence summary lifted from review.summary; safe for one-line display. */
  summary: string;
  /** Full Review object — tested[], worked[], issues[], suggestions[]. */
  review: Review;

  status: RunStatus['kind'];
  ranForMs: number | null;
  startedAt: string;
  finishedAt: string;
  consoleErrors: ConsoleEvent[];
  networkFailures: NetworkFailure[];
  tokensUsed: number | null;
  error: string | null;
  /** Populated when status === 'adjudicator_failed'. Lets CI/Claude
   *  decide whether the failure is retryable (rate_limit) or not. */
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
    by_verdict: { works: number; broken: number; partial: number; unclear: number };
    walledMs: number;
    issuesTotal: number;
  };
}

export function buildJsonOutput(opts: {
  monkeyVersion: string;
  results: MissionResult[];
  walledMs: number;
}): JsonOutput {
  const missions = opts.results.map(toJsonMission);
  const by_verdict = { works: 0, broken: 0, partial: 0, unclear: 0 };
  for (const m of missions) by_verdict[m.verdict] += 1;
  return {
    monkey_version: opts.monkeyVersion,
    missions,
    summary: {
      total: missions.length,
      by_verdict,
      walledMs: opts.walledMs,
      issuesTotal: missions.reduce((sum, m) => sum + m.review.issues.length, 0),
    },
  };
}

function toJsonMission(r: MissionResult): JsonOutputMission {
  const ranForMs = ranForMsOf(r.status);
  const review = reviewOf(r.status);
  return {
    mission: r.mission,
    target: r.target,
    verdict: review.verdict,
    summary: review.summary,
    review,
    status: r.status.kind,
    ranForMs,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
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
function reviewOf(s: RunStatus): Review {
  if ('review' in s) return s.review;
  // 'running' is the only variant without a Review; runMission only emits
  // terminal statuses to the result list, so this branch is defensive.
  throw new Error(`reviewOf: status ${s.kind} has no review`);
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
