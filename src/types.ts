// Shared types and discriminated unions used across the framework.
//
// Design invariant: every multi-state concept uses a discriminated union
// with `kind` as the discriminator (TS-land convention). Adding a new
// variant to any of these unions becomes a compile error in any consumer
// that hadn't accounted for it — exhaustiveness via TS `never`.

import type { Page } from 'playwright-core';
import type { Review } from './review/schema.js';

// ─── Adjudicator failure kinds ───────────────────────────────────────────────

// Surfaced in `adjudicator_failed` RunStatus and JSON output so callers
// (Claude Code, CI) can distinguish transient quota failures from
// schema/parse problems vs. unknown SDK errors. Mirrors AdjudicatorError.kind
// in src/adjudicate/run.ts.
export type AdjudicatorErrorKind = 'rate_limit' | 'parse' | 'other';

// ─── Failure cause taxonomy (Phase 1.2 of migration) ─────────────────────────
//
// Today's codebase uses three vocabularies for the same operational state:
//   - AgentResult.error.kind:   'timeout' | 'rate_limit' | 'other'
//                                                    (in src/stagehand/agent.ts)
//   - agentError.kind in runMission:
//       'timed_out' | 'exceeded_tokens' | 'errored'
//   - Diagnostic enum:
//       'timed_out' | 'rate_limited' | 'parse_failed' | 'token_exceeded'
//       | 'errored'
//   - AdjudicatorErrorKind:     'rate_limit' | 'parse' | 'other'
//
// The same Anthropic 529 gets called 'rate_limit', 'exceeded_tokens',
// 'rate_limited' across the three layers. Future maintenance pain.
//
// FailureCause is the unified vocabulary the migration is moving toward.
// Pipeline stages (Phase 4) will return a Result type using this enum.
// runMission (Phase 4.9) will dispatch on this. Synthetic-Review helpers
// (Phase 4.10) will be parameterized by this. AdjudicatorErrorKind +
// agent.error.kind will retire once their callers migrate.
//
// Mapping of today's vocabularies to FailureCause:
//   wallclock          ← timer.fired()
//   rate_limited       ← agent.error.kind 'rate_limit' OR adjudicator 429/529
//   budget_exceeded    ← future: caps.tokenBudget enforcement (not wired today)
//   agent_errored      ← agent.error.kind 'other'
//   adjudicator_parse  ← adjudicator AdjudicatorError(parse)
//   adjudicator_other  ← adjudicator AdjudicatorError(other) or unwrapped
//   probe_failed       ← probe returns kind != 'ok'
//   infrastructure     ← BB session create / connection / fetch failed
//   aborted            ← signal.aborted (SIGINT)
export type FailureCause =
  | 'wallclock'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'agent_errored'
  | 'adjudicator_parse'
  | 'adjudicator_other'
  | 'probe_failed'
  | 'infrastructure'
  | 'aborted';

export const ALL_FAILURE_CAUSES = [
  'wallclock',
  'rate_limited',
  'budget_exceeded',
  'agent_errored',
  'adjudicator_parse',
  'adjudicator_other',
  'probe_failed',
  'infrastructure',
  'aborted',
] as const satisfies ReadonlyArray<FailureCause>;

// Type-level exhaustiveness guard — adding a new FailureCause variant must
// also add it to ALL_FAILURE_CAUSES. Mirrors the RunStatus guard below.
type _FailureCauseExhaustivenessCheck = Exclude<
  FailureCause,
  (typeof ALL_FAILURE_CAUSES)[number]
> extends never
  ? true
  : { error: 'ALL_FAILURE_CAUSES missing a variant' };
const _failureCauseOk: _FailureCauseExhaustivenessCheck = true;
void _failureCauseOk;

// ─── Run status (per mission) ────────────────────────────────────────────────

// Every status that ran (or attempted to run) the agent carries a Review.
// For completed runs, the Review is the adjudicator's output. For
// non-completed runs, monkey synthesizes a Review (verdict='unclear' +
// diagnostic) so JSON consumers don't have to branch on "is review present."
export type RunStatus =
  | { kind: 'running' }
  | { kind: 'completed'; review: Review; ranForMs: number; tokensUsed?: number }
  | { kind: 'timed_out'; review: Review; ranForMs: number }
  | { kind: 'exceeded_tokens'; review: Review; ranForMs: number }
  | { kind: 'adjudicator_failed'; review: Review; error: string; errorKind: AdjudicatorErrorKind; ranForMs: number }
  | { kind: 'errored'; review: Review; error: string; ranForMs: number }
  | { kind: 'not_started'; review: Review; reason: string }
  | { kind: 'aborted'; review: Review; ranForMs: number };

export const ALL_RUN_STATUS_KINDS = [
  'running',
  'completed',
  'timed_out',
  'exceeded_tokens',
  'adjudicator_failed',
  'errored',
  'not_started',
  'aborted',
] as const satisfies ReadonlyArray<RunStatus['kind']>;

// Type-level exhaustiveness guard.
type _RunStatusExhaustivenessCheck = Exclude<
  RunStatus['kind'],
  (typeof ALL_RUN_STATUS_KINDS)[number]
> extends never
  ? true
  : { error: 'ALL_RUN_STATUS_KINDS missing a variant' };
const _runStatusOk: _RunStatusExhaustivenessCheck = true;
void _runStatusOk;

// AuthMode + Caps now live in lib/state/schema.ts (Zod-derived). Import from
// there for canonical types.

// ─── Probe result (per pre-flight) ───────────────────────────────────────────

export type ProbeResult =
  | { kind: 'ok' }
  | { kind: 'sign-in-page' }
  | { kind: 'unreachable'; details: string }
  | { kind: 'unknown'; details: string };

// ─── Public framework API: SignInFn for custom auth mode ─────────────────────

export type SignInFn = (opts: {
  page: Page;
  signInUrl: string;
  email: string | undefined;
  password: string | undefined;
  signal: AbortSignal;
}) => Promise<void>;

// ─── Browser observation events (captured during the mission) ────────────────

// Captured by lib/observe/. Sanitized before storage.
export interface ConsoleEvent {
  level: 'error' | 'warn';
  message: string;
  source?: { url: string; line: number; column: number };
  timestamp: string;
}

export interface NetworkFailure {
  url: string;
  method: string;
  status?: number; // 4xx / 5xx
  failure?: string; // e.g., "net::ERR_FAILED" for requestfailed events
  timestamp: string;
}

// ─── Mission result (one per parallel mission) ───────────────────────────────

export interface MissionResult {
  index: number;
  total: number;
  mission: string;
  target: string;
  status: RunStatus;
  sessionId: string | null;
  replayUrl: string | null;
  startedAt: string;
  finishedAt: string;
  reportPath: string;
  consoleErrors: ConsoleEvent[];
  networkFailures: NetworkFailure[];
}
