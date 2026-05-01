// Stagehand `extract()` wrapper. Lives on the Stagehand instance directly
// (verified Phase 0 — not on Page).

import type { Stagehand } from '@browserbasehq/stagehand';
import { FindingsListSchema, type FindingsList } from '../findings/schema.js';

const EXTRACT_INSTRUCTION = [
  'Based on what you explored in this session, list every distinct finding you identified.',
  'Each finding is a concrete observation about the app:',
  '  - bug (broken interaction, unexpected error, data corruption)',
  '  - polish issue (typo, misalignment, inconsistent labels)',
  '  - notable observation (worth flagging for human review)',
  '',
  'Use field names: { severity, summary, details }.',
  'severity is one of: critical, high, medium, low, observation.',
  '  - critical: blocks core flows; data corruption',
  '  - high: significant bug; prevents user goal',
  '  - medium: workaround exists but UX clearly degraded',
  '  - low: visual / polish issue',
  '  - observation: not a bug, but worth noting',
  '',
  'If nothing notable was found, return an empty findings array.',
].join('\n');

export async function extractFindings(stagehand: Stagehand): Promise<FindingsList> {
  // Stagehand.extract overload: extract(instruction, schema, options?) returns z.infer<schema>.
  const result = await stagehand.extract(EXTRACT_INSTRUCTION, FindingsListSchema);
  return result;
}
