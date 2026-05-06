// Validation pipeline for adjudicator output (Review).
//
// The adjudicator LLM emits a Review via tool({inputSchema}). Zod parsing
// happens at the tool boundary (cross-field constraints handled there).
// AFTER Zod, this module enforces two cross-reference invariants:
//
//   1. Forward provenance: every Issue's cites[].stepId must reference a
//      real trace step OR a lifter-introduced step.
//   2. Inverse provenance: every critical/high lifter Issue must appear in
//      review.issues[]. The LLM cannot silently drop high-severity
//      deterministic signals — that would corrupt the verdict.
//
// On either failure, return { ok: false, reason } so the caller can retry
// the LLM with the failure message as feedback.

import type { Issue, Review } from '../review/schema.js';
import type { Trace } from '../trace/schema.js';

export type ValidateResult = { ok: true } | { ok: false; reason: string };

export function validateReview(
  review: Review,
  lifterIssues: Issue[],
  trace: Trace,
): ValidateResult {
  const traceStepIds = new Set(trace.steps.map((s) => s.id));
  const lifterStepIds = new Set(lifterIssues.flatMap((i) => i.cites.map((c) => c.stepId)));
  const allKnownStepIds = new Set([...traceStepIds, ...lifterStepIds]);

  // 1. Forward provenance — every cite must reference a real step.
  for (const issue of review.issues) {
    for (const cite of issue.cites) {
      if (!allKnownStepIds.has(cite.stepId)) {
        return {
          ok: false,
          reason: `Issue cites non-existent step ${cite.stepId}: "${issue.summary}"`,
        };
      }
    }
  }

  // 2. Inverse provenance — every critical/high lifter Issue must appear
  //    somewhere in review.issues. We match by stepId overlap (the LLM may
  //    re-cast the lifter's wording, downgrade severity, or merge multiple
  //    lifter issues into one review issue — all fine — but the cited
  //    stepIds must be present).
  for (const lifterIssue of lifterIssues) {
    if (lifterIssue.severity !== 'critical' && lifterIssue.severity !== 'high') continue;
    const lifterStepIdsForThis = new Set(lifterIssue.cites.map((c) => c.stepId));
    const present = review.issues.some((reviewIssue) =>
      reviewIssue.cites.some((cite) => lifterStepIdsForThis.has(cite.stepId)),
    );
    if (!present) {
      return {
        ok: false,
        reason:
          `Lifter detected ${lifterIssue.severity}-severity issue at ` +
          `${[...lifterStepIdsForThis].join(',')} ("${lifterIssue.summary}") ` +
          `that does not appear in review.issues. You may downgrade severity ` +
          `if you judge it noise, but you cannot omit high-severity lifter signals.`,
      };
    }
  }

  return { ok: true };
}
