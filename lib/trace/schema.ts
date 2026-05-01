// V1 trace schema. Append-only NDJSON: 1 header line + N step lines.
//
// What's IN the trace:
//   - The actions Stagehand executed (with fresh page URL + timestamp)
//   - Observations recorded by the explorer's `record_observation` tool
//   - Console errors + 4xx/5xx network events, bucketed into the step
//     whose timestamp window covers them (best-effort correlation)
//
// What's NOT in the V1 trace (and why):
//   - Per-step screenshots: Stagehand v3.3.0's CUA mode doesn't expose a
//     stable per-action screenshot hook. They live inside Stagehand's
//     internal loop. Adding them is V2 work.
//   - Per-step DOM snapshots: same reason. The a11y-tree capture lives
//     inside Stagehand's extract path.
//
// V1 evidence types the adjudicator can cite credibly:
//   network, console (oracle-backed) → verified
//   observation                       → speculative
//   screenshot, dom, diff             → V2 placeholder; cross-reference
//                                       fails in V1, finding demoted

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
  // Bucketed best-effort by `lib/trace/correlate.ts`.
  consoleEvents: z.array(ConsoleEventSchema).default([]),
  networkEvents: z.array(NetworkEventSchema).default([]),
});

export const ObservationStepSchema = TraceStepBaseSchema.extend({
  type: z.literal('observation'),
  text: z.string(),
});

export const TraceStepSchema = z.discriminatedUnion('type', [
  ActionStepSchema,
  ObservationStepSchema,
]);

export type TraceStep = z.infer<typeof TraceStepSchema>;
export type ActionStep = z.infer<typeof ActionStepSchema>;
export type ObservationStep = z.infer<typeof ObservationStepSchema>;

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

export function buildStepIndex(trace: Trace): Set<string> {
  return new Set(trace.steps.map((s) => s.id));
}
