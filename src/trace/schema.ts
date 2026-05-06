// V1 trace schema. Append-only NDJSON: 1 header line + N step lines.
//
// What's IN the trace:
//   - The actions Stagehand emitted in hybrid mode (semantic acts +
//     pixel-level clicks/types/etc.), each with reasoning + page URL +
//     timestamp.
//   - Console errors + 4xx/5xx network events, bucketed into the step
//     whose timestamp window covers them (best-effort correlation).
//
// V1 evidence types the adjudicator can cite:
//   network, console → oracle-backed; the deterministic lifter promotes
//                      these into Issues directly.
//   action           → the agent's recorded action at this step (semantic
//                      via `act()` reasoning, or pixel-level args).

import { z } from 'zod';

// ─── Step ID convention ──────────────────────────────────────────────────────
//
// Zero-padded to 4 digits at write time (`makeStepId`) so step IDs sort by
// string compare and are easy to grep / debug. Regex permits ≥4 digits so
// padding doesn't have to grow on long missions; today's maxSteps=60 is well
// inside 4-digit range.

export const STEP_ID_RE = /^step_\d{4,}$/;
export const StepIdSchema = z.string().regex(STEP_ID_RE);

export function makeStepId(index: number): string {
  return `step_${String(index).padStart(4, '0')}`;
}

// ─── Console + network events (zodified counterparts of types.ts) ────────────

export const ConsoleEventSchema = z.object({
  level: z.enum(['error', 'warn']),
  message: z.string(),
  source: z
    .object({
      url: z.string(),
      line: z.number().int().nonnegative(),
      column: z.number().int().nonnegative(),
    })
    .optional(),
  timestamp: z.string(), // ISO
});

export const NetworkEventSchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number().int().optional(),
  failure: z.string().optional(),
  timestamp: z.string(), // ISO
});

// ─── Action variants ─────────────────────────────────────────────────────────
//
// Stagehand's Action shape is loose (`description`, `method?`, `arguments?`).
// We don't try to discriminate by kind — V1 trace captures the description
// + method as-is and lets the adjudicator read English.

export const ActionRecordSchema = z.object({
  description: z.string(),
  method: z.string().optional(),
  reasoning: z.string().optional(),
});

// ─── TraceStep — discriminated union by `type` ───────────────────────────────

const TraceStepBaseSchema = z.object({
  id: StepIdSchema,
  index: z.number().int().nonnegative(),
  timestamp: z.string(), // ISO; from Stagehand's action.timestamp or the observation moment
  url: z.string(),       // captured fresh; URL is best-effort (may be empty if action had no pageUrl)
});

export const ActionStepSchema = TraceStepBaseSchema.extend({
  type: z.literal('action'),
  action: ActionRecordSchema,
  // Console/network events whose timestamp falls within this step's window.
  // Bucketed best-effort by `src/pipeline/build-trace.ts`.
  consoleEvents: z.array(ConsoleEventSchema).default([]),
  networkEvents: z.array(NetworkEventSchema).default([]),
});

// Today the trace only contains action steps. The discriminated union over
// `type` is preserved (single variant) so future step kinds plug in without
// reshaping consumers.
export const TraceStepSchema = z.discriminatedUnion('type', [ActionStepSchema]);

export type TraceStep = z.infer<typeof TraceStepSchema>;
export type ActionStep = z.infer<typeof ActionStepSchema>;

// ─── Trace header (line 0 of trace.ndjson) ───────────────────────────────────

export const TraceHeaderSchema = z.object({
  type: z.literal('header'),
  schemaVersion: z.literal(1),
  missionId: z.string(),    // matches the mission directory name
  mission: z.string(),
  target: z.string(),
  startedAt: z.string(),
  agentModel: z.string(),
});

export type TraceHeader = z.infer<typeof TraceHeaderSchema>;

// ─── In-memory Trace shape (post-load) ───────────────────────────────────────

export interface Trace {
  header: TraceHeader;
  steps: TraceStep[];
}
