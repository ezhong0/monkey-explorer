// Shared types and discriminated unions used across the framework.
//
// Design invariant: every multi-state concept uses a discriminated union
// with `kind` as the discriminator (TS-land convention). Adding a new
// variant to any of these unions becomes a compile error in any consumer
// that hadn't accounted for it — exhaustiveness via TS `never`.

import type { Page } from 'playwright-core';

// ─── Findings ────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'observation';

// Evidence types the adjudicator may cite. V1 trace captures network +
// console + observation; screenshot/dom/diff are forward-compat slots
// (V2 trace adds per-step screenshots; baseline mode adds diff).
// In V1, citations against unsupported types fail cross-reference and
// the finding is demoted to `speculative` with `validation_failed`.
export type EvidenceType =
  | 'network'      // step has 4xx/5xx or net::ERR — oracle-backed
  | 'console'      // step has console.error or .warn — oracle-backed
  | 'observation'  // explorer's record_observation text at a step — NOT oracle (LLM-generated)
  | 'screenshot'   // V2: per-step screenshot — NOT oracle (VLM hallucination risk)
  | 'dom'          // V2: per-step DOM snapshot — oracle-backed
  | 'diff';        // V2 baseline mode: diff against baseline run — oracle-backed

// Oracle-backed evidence types tier as `verified`. Others (observation,
// screenshot) tier as `speculative` even when valid — the underlying data
// is LLM- or VLM-generated, not ground truth.
export const ORACLE_EVIDENCE_TYPES = ['network', 'console', 'dom', 'diff'] as const satisfies ReadonlyArray<EvidenceType>;

export type Tier = 'verified' | 'speculative';

export interface Provenance {
  stepId: string;          // matches /^step_\d{4,}$/
  evidenceType: EvidenceType;
}

export interface Finding {
  severity: Severity;
  summary: string;
  details: string;
  // V2 fields (optional during migration; required for adjudicator output):
  provenance?: Provenance[];
  tier?: Tier;
  validation_failed?: string; // populated when demoted by validation pipeline
}

// ─── Run status (per mission) ────────────────────────────────────────────────

export type RunStatus =
  | { kind: 'running' }
  | { kind: 'completed'; findings: Finding[]; ranForMs: number; tokensUsed?: number }
  | { kind: 'timed_out'; findings: Finding[]; ranForMs: number }
  | { kind: 'exceeded_tokens'; findings: Finding[]; ranForMs: number }
  | { kind: 'extract_failed'; error: string; ranForMs: number }                                  // legacy, retired with extract path
  | { kind: 'adjudicator_failed'; error: string; findings: Finding[]; ranForMs: number }         // deterministic findings still ship
  | { kind: 'errored'; error: string; ranForMs: number }
  | { kind: 'not_started'; reason: string }
  | { kind: 'aborted'; ranForMs: number };

export const ALL_RUN_STATUS_KINDS = [
  'running',
  'completed',
  'timed_out',
  'exceeded_tokens',
  'extract_failed',
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

