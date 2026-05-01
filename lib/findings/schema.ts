// Findings schema. v1 was the lenient post-hoc extract() shape with just
// severity/summary/details. v2 adds provenance + tier + validation_failed
// for the explorer/adjudicator architecture (see
// design-monkey-explorer-trace-adjudicator-2026-05-01.md).
//
// Lenient by design: the LLM tends to use natural field names ("description"
// instead of "details", or "warn" for severity). Preprocessing aliases
// common variants so a slightly-off-model output still parses cleanly
// instead of dumping the whole extraction.

import { z } from 'zod';
import * as log from '../log/stderr.js';

// Provenance can cite either a trace step (step_NNNN) OR a synthetic lifter
// step (step_console_NNNN, step_network_NNNN). The Zod schema accepts both
// so toJsonSchema() produces a JSON Schema the adjudicator can use as-is.
const PROVENANCE_STEP_ID_RE = /^(step_\d{4,}|step_(console|network)_\d{4,})$/;
const ProvenanceStepIdSchema = z.string().regex(PROVENANCE_STEP_ID_RE);

export const SeveritySchema = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.toLowerCase().trim();
  if (s === 'warn' || s === 'warning') return 'low';
  if (s === 'error' || s === 'err') return 'high';
  if (s === 'info' || s === 'note') return 'observation';
  return s;
}, z.enum(['critical', 'high', 'medium', 'low', 'observation']));

// ─── v2 — adjudicator-emitted findings with provenance ───────────────────────

export const EvidenceTypeSchema = z.enum([
  'network',
  'console',
  'observation',
  'screenshot',
  'dom',
  'diff',
]);

export const ProvenanceSchema = z.object({
  stepId: ProvenanceStepIdSchema,
  evidenceType: EvidenceTypeSchema,
});

export const TierSchema = z.enum(['verified', 'speculative']);

// Shape the adjudicator LLM emits via tool({inputSchema}). NB: no `tier`,
// no `validation_failed` — those are assigned by monkey post-parse, not
// by the model. The model just emits the claim + provenance.
export const AdjudicatedFindingSchema = z.preprocess(
  (v) => {
    if (v === null || typeof v !== 'object') return v;
    const obj = v as Record<string, unknown>;
    const aliases: string[] = [];
    if (obj.severity == null && (obj.level != null || obj.priority != null)) {
      aliases.push(obj.level != null ? 'level→severity' : 'priority→severity');
    }
    if (obj.summary == null && (obj.title != null || obj.name != null)) {
      aliases.push(obj.title != null ? 'title→summary' : 'name→summary');
    }
    if (obj.details == null) {
      if (obj.description != null) aliases.push('description→details');
      else if (obj.explanation != null) aliases.push('explanation→details');
      else if (obj.text != null) aliases.push('text→details');
    }
    if (obj.provenance == null && (obj.evidence != null || obj.cites != null)) {
      aliases.push(obj.evidence != null ? 'evidence→provenance' : 'cites→provenance');
    }
    if (aliases.length > 0) {
      log.warn(`AdjudicatedFinding: model emitted alias key(s) ${aliases.join(', ')}; check whether prompt or schema needs updating.`);
    }
    return {
      severity: obj.severity ?? obj.level ?? obj.priority,
      summary: obj.summary ?? obj.title ?? obj.name ?? '',
      details: obj.details ?? obj.description ?? obj.explanation ?? obj.text ?? '',
      provenance: obj.provenance ?? obj.evidence ?? obj.cites ?? [],
    };
  },
  z.object({
    severity: SeveritySchema,
    summary: z.string().min(1),
    details: z.string(),
    provenance: z.array(ProvenanceSchema).min(1),
  }),
);

export const AdjudicatedFindingsListSchema = z.object({
  findings: z.array(AdjudicatedFindingSchema),
});

export type AdjudicatedFinding = z.infer<typeof AdjudicatedFindingSchema>;
export type AdjudicatedFindingsList = z.infer<typeof AdjudicatedFindingsListSchema>;

// ─── v1 (legacy) — pure extract() shape, used by the soon-to-be-retired
//     post-hoc extract path. Keep until step 5 of migration. ──────────────────

export const FindingSchema = z.preprocess(
  (v) => {
    if (v === null || typeof v !== 'object') return v;
    const obj = v as Record<string, unknown>;
    return {
      severity: obj.severity ?? obj.level ?? obj.priority,
      summary: obj.summary ?? obj.title ?? obj.name ?? '',
      details: obj.details ?? obj.description ?? obj.explanation ?? obj.text ?? '',
    };
  },
  z.object({
    severity: SeveritySchema,
    summary: z.string().min(1),
    details: z.string(),
  }),
);

export const FindingsListSchema = z.object({
  findings: z.array(FindingSchema),
});

export type FindingsList = z.infer<typeof FindingsListSchema>;
