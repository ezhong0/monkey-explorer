// Shared types and discriminated unions used across the framework.
//
// Design invariant: every multi-state concept uses a discriminated union
// with `kind` as the discriminator (TS-land convention). Adding a new
// variant to any of these unions becomes a compile error in any consumer
// that hadn't accounted for it — exhaustiveness via TS `never`.

import type { Page } from 'playwright-core';

// ─── Findings ────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'observation';

export interface Finding {
  severity: Severity;
  summary: string;
  details: string;
}

// ─── Run status (per mission) ────────────────────────────────────────────────

export type RunStatus =
  | { kind: 'running' }
  | { kind: 'completed'; findings: Finding[]; ranForMs: number; tokensUsed?: number }
  | { kind: 'timed_out'; findings: Finding[]; ranForMs: number }
  | { kind: 'exceeded_tokens'; findings: Finding[]; ranForMs: number }
  | { kind: 'extract_failed'; error: string; ranForMs: number }
  | { kind: 'errored'; error: string; ranForMs: number }
  | { kind: 'not_started'; reason: string }
  | { kind: 'aborted'; ranForMs: number };

export const ALL_RUN_STATUS_KINDS = [
  'running',
  'completed',
  'timed_out',
  'exceeded_tokens',
  'extract_failed',
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

// ─── Auth mode (per project config) ──────────────────────────────────────────

export type AuthMode =
  | { kind: 'ai-form'; signInUrl: string }
  | { kind: 'interactive'; signInUrl: string }
  | { kind: 'none' }
  | { kind: 'custom'; path: string };

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

// ─── Caps ────────────────────────────────────────────────────────────────────

export interface Caps {
  wallClockMs: number;
  maxSteps: number;
  sessionTimeoutSec: number;
}
