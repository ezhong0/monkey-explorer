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
// in lib/adjudicate/run.ts.
export type AdjudicatorErrorKind = 'rate_limit' | 'parse' | 'other';

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
