// Synthetic Reviews for non-completed run states. Every RunStatus carries
// a Review so JSON consumers (Claude) never branch on "is review present."
// When the adjudicator never ran (timeout, token budget, error), monkey
// itself constructs the Review here.
//
// All synthetic Reviews have verdict='unclear'. The diagnostic field
// distinguishes WHY: 'timed_out', 'token_exceeded', 'rate_limited',
// 'parse_failed', or absent (errored / not_started / aborted).
//
// Lifter-promoted Issues are preserved on partial-failure states
// (timed_out / exceeded_tokens / adjudicator_failed) — the deterministic
// signals are still real, even when the LLM verdict isn't reachable.

import { ReviewSchema, type Issue, type Review } from './schema.js';

export function reviewForTimedOut(lifterIssues: Issue[]): Review {
  return ReviewSchema.parse({
    verdict: 'unclear',
    diagnostic: 'timed_out',
    summary: 'Mission hit the wall-clock cap before completing.',
    issues: lifterIssues,
    suggestions: [
      'Increase wallClockMs cap',
      'Re-run with a tighter mission scope',
    ],
  });
}

export function reviewForExceededTokens(lifterIssues: Issue[]): Review {
  return ReviewSchema.parse({
    verdict: 'unclear',
    diagnostic: 'token_exceeded',
    summary: 'Mission exceeded the token budget before completing.',
    issues: lifterIssues,
    suggestions: [
      'Increase tokenBudget cap',
      'Switch agent model to a cheaper option',
    ],
  });
}

export function reviewForAdjudicatorRateLimited(lifterIssues: Issue[]): Review {
  return ReviewSchema.parse({
    verdict: 'unclear',
    diagnostic: 'rate_limited',
    summary: 'Adjudicator was rate-limited; lifter-promoted issues are still surfaced.',
    issues: lifterIssues,
    suggestions: ['Retry in 60 seconds'],
  });
}

export function reviewForAdjudicatorFailed(
  lifterIssues: Issue[],
  reason: string,
  errorKind: 'parse' | 'other',
): Review {
  // 'parse' = LLM output malformed twice. 'other' = unexpected non-rate-limit
  // error (network blip, type error, anything else). Surface them as distinct
  // diagnostics so debugging knows which bucket fired.
  const diagnostic = errorKind === 'parse' ? 'parse_failed' : 'errored';
  return ReviewSchema.parse({
    verdict: 'unclear',
    diagnostic,
    summary: `Adjudicator failed: ${reason}. Lifter-promoted issues are still surfaced.`,
    issues: lifterIssues,
    suggestions: [
      'Re-run; if persistent, investigate adjudicator prompt',
    ],
  });
}

export function reviewForErrored(error: string): Review {
  return ReviewSchema.parse({
    verdict: 'unclear',
    summary: `Mission errored: ${error}`,
    issues: [],
    suggestions: ['Investigate error and re-run'],
  });
}

export function reviewForNotStarted(reason: string): Review {
  return ReviewSchema.parse({
    verdict: 'unclear',
    summary: `Mission did not start: ${reason}`,
    issues: [],
    suggestions: ['Address blocker and re-run'],
  });
}

export function reviewForAborted(): Review {
  return ReviewSchema.parse({
    verdict: 'unclear',
    summary: 'Mission aborted (SIGINT).',
    issues: [],
    suggestions: [],
  });
}
