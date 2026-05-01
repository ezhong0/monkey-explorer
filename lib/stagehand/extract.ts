// Stagehand `extract()` wrapper. Lives on the Stagehand instance directly
// (verified Phase 0 — not on Page).
//
// Note: this is a SECOND LLM call AFTER agent.execute returns. It depends on
// the BB session's CDP WebSocket still being alive. If the WS closed during
// or just after the agent loop (BB rate limit, idle timeout, agent.done
// teardown), this throws StagehandNotInitializedError. runMission catches
// that and degrades gracefully — see the catch block there.
//
// Future: when Stagehand v3 actually threads user-provided tools through to
// the agent runtime (as the AgentConfig.tools type def implies but
// dist/index.js:10315 ignores), monkey can switch to inline tool emission
// via a `report_finding` tool — eliminates this whole post-hoc call.

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

/**
 * Returns true if `err` looks like a Stagehand handle-closed-out-from-under-us
 * error, vs a genuine extract failure (bad schema, model error, etc.).
 * Used by runMission to decide whether to fail the mission or degrade
 * gracefully with `findings: []`.
 */
export function isStagehandHandleClosedError(err: unknown): boolean {
  const message = (err as Error)?.message ?? String(err);
  return /StagehandNotInitialized|uninitialized.*Stagehand|CDP.*closed|socket-close|disconnected|transport.*closed/i.test(
    message,
  );
}
