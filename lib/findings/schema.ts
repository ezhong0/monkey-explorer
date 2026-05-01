// Findings schema for Stagehand extract().
//
// Lenient by design: the LLM tends to use natural field names ("description"
// instead of "details", or "warn" for severity). Preprocessing aliases
// common variants so a slightly-off-model output still parses cleanly
// instead of dumping the whole extraction.

import { z } from 'zod';

export const SeveritySchema = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.toLowerCase().trim();
  if (s === 'warn' || s === 'warning') return 'low';
  if (s === 'error' || s === 'err') return 'high';
  if (s === 'info' || s === 'note') return 'observation';
  return s;
}, z.enum(['critical', 'high', 'medium', 'low', 'observation']));

// Preprocess: alias common LLM-output field names before strict-validating.
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
