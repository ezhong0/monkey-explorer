// Common types for pipeline stages.
//
// Each pipeline stage is a function: `(opts) => Promise<StageResult<T>>` for
// stages that can fail, or `(opts) => Promise<T>` (or just `(opts) => T` if
// pure) for stages that can't.
//
// StageResult uses FailureCause from src/types.ts as its failure
// vocabulary — the same vocabulary RunStatus + Diagnostic move toward in
// commit 4.10.
//
// Why Result instead of throw: pipeline stages are composed by runner/
// orchestrate.ts, which dispatches on cause. Errors as values are easier
// to dispatch on than catch blocks.

import type { FailureCause } from '../types.js';

export type StageResult<T> =
  | { ok: true; value: T }
  | { ok: false; cause: FailureCause; error?: string };

/** Helper to construct a successful StageResult. */
export function ok<T>(value: T): StageResult<T> {
  return { ok: true, value };
}

/** Helper to construct a failed StageResult. */
export function fail(cause: FailureCause, error?: string): StageResult<never> {
  return { ok: false, cause, error };
}
