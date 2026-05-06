// Functional review schema. The wire contract Claude programs against.
//
// A Review is what monkey emits per mission: a verdict (works | broken |
// partial | unclear) plus structured supporting fields. Replaces the old
// findings[] + derived pass/fail/inconclusive verdict.
//
// Two layers:
//   - Issue: a single problem observed by the agent or lifted from
//     deterministic signals (4xx/5xx, console errors).
//   - Review: the adjudicator's verdict + summary + tested/worked/issues/
//     suggestions, validated with cross-field constraints.
//
// Synthetic-Review templates handle non-completed run states uniformly,
// so JSON consumers (Claude) never branch on "is review present."

import { z } from 'zod';

// Cite a step in the trace OR a lifter-introduced step. Same regex as the
// pre-reframe Provenance type.
const STEP_ID_RE = /^(step_\d{4,}|step_(console|network)_\d{4,})$/;

export const VerdictSchema = z.enum(['works', 'broken', 'partial', 'unclear']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const DiagnosticSchema = z.enum([
  'rate_limited',   // adjudicator hit 429; transient, retryable
  'parse_failed',   // adjudicator output malformed twice
  'errored',        // adjudicator threw an unexpected error (non-parse, non-rate-limit)
  'timed_out',      // mission hit wallclock cap before adjudicator ran
  'token_exceeded', // mission hit token budget before adjudicator ran
]);
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const SeveritySchema = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.toLowerCase().trim();
  if (s === 'warn' || s === 'warning') return 'low';
  if (s === 'error' || s === 'err') return 'high';
  if (s === 'info' || s === 'note') return 'observation';
  return s;
}, z.enum(['critical', 'high', 'medium', 'low', 'observation']));
export type Severity = z.infer<typeof SeveritySchema>;

export const IssueSourceSchema = z.enum([
  'agent',  // observed by the LLM during the run; LLM's judgment
  'lifter', // auto-promoted from network 4xx/5xx or console.error/warn
]);
export type IssueSource = z.infer<typeof IssueSourceSchema>;

// Three evidence types the adjudicator can cite:
//   network — step has 4xx/5xx or net::ERR (oracle-backed via lifter)
//   console — step has console.error/warn (oracle-backed via lifter)
//   action  — step is a semantic or pixel-level action the agent took
export const EvidenceTypeSchema = z.enum(['network', 'console', 'action']);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const StepCiteSchema = z.object({
  stepId: z.string().regex(STEP_ID_RE),
  evidenceType: EvidenceTypeSchema,
});
export type StepCite = z.infer<typeof StepCiteSchema>;

export const IssueSchema = z.object({
  source: IssueSourceSchema,
  severity: SeveritySchema,
  summary: z.string().min(1),
  details: z.string(),
  cites: z.array(StepCiteSchema).min(1),
});
export type Issue = z.infer<typeof IssueSchema>;

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  observation: 4,
};
const MEDIUM_OR_WORSE: ReadonlyArray<Severity> = ['critical', 'high', 'medium'];

export const ReviewSchema = z
  .object({
    verdict: VerdictSchema,
    summary: z.string().min(1),
    diagnostic: DiagnosticSchema.optional(),
    tested: z.array(z.string()).default([]),
    worked: z.array(z.string()).default([]),
    issues: z.array(IssueSchema).default([]),
    suggestions: z.array(z.string()).default([]),
  })
  .superRefine((r, ctx) => {
    if (r.verdict === 'works') {
      if (r.tested.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tested'],
          message: "verdict 'works' requires >=1 entry in tested[]",
        });
      }
      if (r.issues.some((i) => MEDIUM_OR_WORSE.includes(i.severity))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['issues'],
          message: "verdict 'works' cannot coexist with medium+ severity issues",
        });
      }
    }
    if (r.verdict === 'broken') {
      if (!r.issues.some((i) => MEDIUM_OR_WORSE.includes(i.severity))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['issues'],
          message: "verdict 'broken' requires >=1 issue with severity >= medium",
        });
      }
    }
    if (r.diagnostic !== undefined && r.verdict !== 'unclear') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['diagnostic'],
        message: "diagnostic field only valid when verdict === 'unclear'",
      });
    }
  });
export type Review = z.infer<typeof ReviewSchema>;

// Comparator: sort issues by severity then source (agent first).
export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    if (a.source === b.source) return 0;
    return a.source === 'agent' ? -1 : 1;
  });
}
