// Adjudicate stage: run the post-mission LLM judge over trace + lifter
// issues, return a Review.
//
// The adjudicator's runAdjudicator throws AdjudicatorError with a 'kind'
// of 'rate_limit' | 'parse' | 'other'. This stage maps those into the
// FailureCause taxonomy. AdjudicatorError(parse) covers both Zod parse
// failures and validateReview cross-reference failures.

import { runAdjudicator, AdjudicatorError } from '../adjudicate/run.js';
import type { Issue, Review } from '../review/schema.js';
import type { Trace } from '../trace/schema.js';
import type { StageResult } from './types.js';
import { ok, fail } from './types.js';

export interface AdjudicateStageOpts {
  apiKey: string;
  baseURL?: string;
  model: string;
  trace: Trace;
  liftedIssues: Issue[];
}

export async function adjudicate(opts: AdjudicateStageOpts): Promise<StageResult<Review>> {
  try {
    const review = await runAdjudicator({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      model: opts.model,
      trace: opts.trace,
      liftedIssues: opts.liftedIssues,
    });
    return ok(review);
  } catch (err) {
    if (err instanceof AdjudicatorError) {
      if (err.kind === 'rate_limit') return fail('rate_limited', err.message);
      if (err.kind === 'parse') return fail('adjudicator_parse', err.message);
      return fail('adjudicator_other', err.message);
    }
    // Defensive: runAdjudicator wraps all non-AdjudicatorError into
    // AdjudicatorError before throwing, but if that breaks, treat as
    // adjudicator_other.
    return fail('adjudicator_other', (err as Error)?.message ?? String(err));
  }
}
