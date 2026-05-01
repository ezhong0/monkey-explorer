// Build an in-memory Trace from Stagehand's outputs + post-hoc collected events.
//
// V1 keeps the trace in memory only — no on-disk NDJSON yet (deferred to V2).
// The adjudicator reads from this Trace; the validation pipeline checks
// adjudicator-cited stepIds against trace.steps[*].id.
//
// Step IDs:
//   - Action steps: `step_NNNN` from action index (Stagehand's actions[] order)
//   - Observation steps: `step_NNNN` continuing from action count
//   - Lifter event steps: `step_console_NNNN` / `step_network_NNNN` (introduced
//     by lib/observe/promote.ts, NOT here — they exist on the deterministic
//     findings' provenance directly without a corresponding trace step entry)
//
// Best-effort timestamp correlation: console/network events are bucketed
// into the action step whose timestamp window covers them. If no action
// covers an event, it floats unattached (still cited via lifter stepIds).

import { z } from 'zod';
import type {
  RecordedObservation,
} from '../stagehand/agent.js';
import * as log from '../log/stderr.js';
import type { ConsoleEvent, NetworkFailure } from '../types.js';
import {
  buildStepIndex,
  makeStepId,
  type ActionStep,
  type ObservationStep,
  type Trace,
  type TraceHeader,
  type TraceStep,
} from './schema.js';

// Defensive Zod schema for the action shape Stagehand v3.3.0 emits. We only
// read a few fields; anything else is allowed (`.passthrough()`) so a
// future Stagehand minor doesn't break trace building. If a runtime action
// fails this loose schema, it's dropped with a warning rather than poisoning
// the trace.
const StagehandActionRawSchema = z
  .object({
    description: z.string().optional(),
    method: z.string().optional(),
    reasoning: z.string().optional(),
    pageUrl: z.string().optional(),
    timestamp: z.number().optional(), // Stagehand sets via Date.now()
  })
  .passthrough();

type StagehandActionRaw = z.infer<typeof StagehandActionRawSchema>;

export interface BuildTraceInput {
  header: Omit<TraceHeader, 'type' | 'schemaVersion'>;
  rawActions: unknown[];
  observations: RecordedObservation[];
  consoleErrors: ConsoleEvent[];
  networkFailures: NetworkFailure[];
}

export function buildTrace(input: BuildTraceInput): Trace {
  const header: TraceHeader = {
    type: 'header',
    schemaVersion: 1,
    ...input.header,
  };

  // Convert Stagehand actions to ActionSteps. Each raw action goes through
  // Zod parse first; failures are dropped with a warning rather than
  // poisoning the trace. Then bucket events into each step's window
  // (timestamp ≥ this.timestamp AND < next.timestamp).
  const validatedActions: StagehandActionRaw[] = [];
  let rejectedActionCount = 0;
  for (const a of input.rawActions) {
    const parsed = StagehandActionRawSchema.safeParse(a);
    if (parsed.success) {
      validatedActions.push(parsed.data);
    } else {
      rejectedActionCount++;
    }
  }
  if (rejectedActionCount > 0) {
    log.warn(
      `trace builder: dropped ${rejectedActionCount} Stagehand action(s) that failed schema validation. Stagehand SDK shape may have drifted.`,
    );
  }
  const sortedActions: StagehandActionRaw[] = validatedActions
    .slice()
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  const actionSteps: ActionStep[] = [];
  for (let i = 0; i < sortedActions.length; i++) {
    const a = sortedActions[i];
    const tsMs = a.timestamp ?? Date.now();
    const tsIso = new Date(tsMs).toISOString();
    const nextTsMs = sortedActions[i + 1]?.timestamp ?? Number.POSITIVE_INFINITY;

    const consoleInWindow = input.consoleErrors.filter((e) => {
      const t = Date.parse(e.timestamp);
      return Number.isFinite(t) && t >= tsMs && t < nextTsMs;
    });
    const networkInWindow = input.networkFailures.filter((e) => {
      const t = Date.parse(e.timestamp);
      return Number.isFinite(t) && t >= tsMs && t < nextTsMs;
    });

    actionSteps.push({
      id: makeStepId(i),
      index: i,
      timestamp: tsIso,
      url: a.pageUrl ?? '',
      type: 'action',
      action: {
        description: a.description ?? '(no description)',
        method: a.method,
        reasoning: a.reasoning,
      },
      consoleEvents: consoleInWindow.map((e) => ({
        level: e.level,
        message: e.message,
        source: e.source,
        timestamp: e.timestamp,
      })),
      networkEvents: networkInWindow.map((e) => ({
        url: e.url,
        method: e.method,
        status: e.status,
        failure: e.failure,
        timestamp: e.timestamp,
      })),
    });
  }

  // Observations get appended as separate steps after action steps. They
  // could be interleaved by timestamp, but since they fire from inside the
  // explorer's tool callback, we don't always know which Stagehand step they
  // pair with. Appending preserves the data without forcing a wrong ordering.
  const observationSteps: ObservationStep[] = input.observations.map((o, i) => ({
    id: makeStepId(actionSteps.length + i),
    index: actionSteps.length + i,
    timestamp: o.recordedAt,
    url: '', // unknown; observation didn't capture the URL
    type: 'observation',
    text: o.text,
  }));

  const steps: TraceStep[] = [...actionSteps, ...observationSteps];
  return { header, steps };
}

export { buildStepIndex };
