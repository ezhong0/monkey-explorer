// Verdict derivation — used at mission-terminal time to lock the
// pass/fail/inconclusive judgment onto MissionResult so it doesn't drift
// if findings get post-processed downstream (sanitization, replay, etc.).
//
// Snapshot the decision; never recompute.

import type { Finding, RunStatus } from '../types.js';

export type Verdict = 'pass' | 'fail' | 'inconclusive';

/** Per-mission verdict from the run's status + verified findings. */
export function deriveVerdict(status: RunStatus, verifiedFindings: Finding[]): Verdict {
  if (
    status.kind === 'errored' ||
    status.kind === 'not_started' ||
    status.kind === 'aborted' ||
    status.kind === 'timed_out' ||
    status.kind === 'exceeded_tokens'
  ) {
    return 'fail';
  }
  // Adjudicator failed but lifter findings shipped — fall through to
  // verdict-from-findings using whatever's in verifiedFindings.
  const hasSerious = verifiedFindings.some(
    (f) => f.severity === 'critical' || f.severity === 'high',
  );
  if (hasSerious) return 'fail';
  if (verifiedFindings.length === 0) return 'pass';
  // medium/low/observation only — worth a look, not a blocker.
  return 'inconclusive';
}

export function aggregateVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.some((v) => v === 'fail')) return 'fail';
  if (verdicts.every((v) => v === 'pass')) return 'pass';
  return 'inconclusive';
}
