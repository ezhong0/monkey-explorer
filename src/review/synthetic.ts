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

// Used when the agent hits Anthropic 429/529 (rate-limited or "Overloaded")
// or Stagehand's "Failed after N attempts" wrapper. The diagnostic
// 'rate_limited' tells the caller to retry.
//
// (A `reviewForExceededTokens` helper with diagnostic 'token_exceeded'
// previously lived here for a future tokenBudget enforcement feature, but
// budget enforcement isn't wired today and the helper had no callers. It
// was dropped in Phase 4.10 of the migration. When real budget enforcement
// lands, re-add it then.)
export function reviewForAgentRateLimited(lifterIssues: Issue[]): Review {
  return ReviewSchema.parse({
    verdict: 'unclear',
    diagnostic: 'rate_limited',
    summary: 'Agent hit a transient API rate-limit / capacity issue before completing.',
    issues: lifterIssues,
    suggestions: [
      'Retry in 60 seconds',
      'If persistent, switch agent model or use a different deployment',
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
