// Build an in-memory Trace from Stagehand's outputs + post-hoc collected events.
//
// V1 keeps the trace in memory only — no on-disk NDJSON yet (deferred to V2).
// The adjudicator reads from this Trace; the validation pipeline checks
// adjudicator-cited stepIds against trace.steps[*].id.
//
// Step IDs:
//   - Action steps: `step_NNNN` from action index (Stagehand's actions[] order)
//   - Lifter event steps: `step_console_NNNN` / `step_network_NNNN` (introduced
//     by lib/observe/promote.ts, NOT here — they exist on the deterministic
//     issues' cites directly without a corresponding trace step entry)
//
// In hybrid mode, each Stagehand action carries `type` + `reasoning` + tool-
// specific args + `pageUrl` + `timeMs`. summarizeAction prefers the model's
// `reasoning` text and falls back to a synthesized "type(args)" form for
// pixel-level actions.
//
// Best-effort timestamp correlation: console/network events are bucketed
// into the action step whose timestamp window covers them. If no action
// covers an event, it floats unattached (still cited via lifter stepIds).

import { z } from 'zod';
import * as log from '../log/stderr.js';
import type { ConsoleEvent, NetworkFailure } from '../types.js';
import {
  makeStepId,
  type ActionStep,
  type Trace,
  type TraceHeader,
  type TraceStep,
} from './schema.js';

// Defensive Zod schema for the action shape Stagehand v3.3 emits in hybrid
// mode. Hybrid populates `type`, `reasoning`, `pageUrl`, `timeMs`, plus
// tool-specific args (action for `act`, x/y for click, text for type, etc.).
// `passthrough()` so Stagehand minor bumps don't break trace building.
const StagehandActionRawSchema = z
  .object({
    type: z.string().optional(),
    description: z.string().optional(),
    method: z.string().optional(),
    reasoning: z.string().optional(),
    pageUrl: z.string().optional(),
    timeMs: z.number().optional(),
    timestamp: z.number().optional(), // legacy fallback
  })
  .passthrough();

type StagehandActionRaw = z.infer<typeof StagehandActionRawSchema>;

// Build a short, factual one-line description from the action's structured
// fields. Used by the adjudicator's trace summary, so this is the LLM's
// only window into what the agent did at each step.
function summarizeAction(a: StagehandActionRaw): string {
  // Hybrid mode populates `reasoning` for semantic actions (act, goto, extract).
  // Combine with the natural-language `action` arg when present.
  if (a.reasoning && a.reasoning.trim().length > 0) {
    const arg = (a as Record<string, unknown>).action;
    if (typeof arg === 'string' && arg.length > 0) {
      return `${a.type ?? 'action'}("${arg}"): ${a.reasoning}`;
    }
    return `${a.type ?? 'action'}: ${a.reasoning}`;
  }
  if (a.description && a.description.trim().length > 0) return a.description;

  // Pixel-level fallback: synthesize from type + args.
  const type = a.type ?? a.method ?? 'action';
  const args = formatActionArgs(type, a as Record<string, unknown>);
  return args ? `${type}(${args})` : `${type}()`;
}

function formatActionArgs(type: string, raw: Record<string, unknown>): string {
  switch (type) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      const x = raw.x;
      const y = raw.y;
      const button = raw.button;
      const xy = typeof x === 'number' && typeof y === 'number' ? `${x},${y}` : '';
      return [xy, button ? `button=${String(button)}` : ''].filter(Boolean).join(' ');
    }
    case 'type': {
      const text = typeof raw.text === 'string' ? raw.text : '';
      const truncated = text.length > 80 ? `${text.slice(0, 77)}…` : text;
      return JSON.stringify(truncated);
    }
    case 'dragAndDrop': {
      const fx = raw.fromX, fy = raw.fromY, tx = raw.toX, ty = raw.toY;
      if ([fx, fy, tx, ty].every((v) => typeof v === 'number')) {
        return `(${fx},${fy})→(${tx},${ty})`;
      }
      return '';
    }
    case 'goto': {
      const url = raw.url;
      return typeof url === 'string' ? JSON.stringify(url) : '';
    }
    case 'screenshot':
    case 'done':
      return '';
    default:
      return '';
  }
}

export interface BuildTraceInput {
  header: Omit<TraceHeader, 'type' | 'schemaVersion'>;
  rawActions: unknown[];
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
  // Sort by timeMs (or legacy timestamp) when present, else preserve order.
  // Tolerates undefined for the past-the-end lookup at the loop boundary.
  const actionTime = (a: StagehandActionRaw | undefined): number =>
    a?.timeMs ?? a?.timestamp ?? 0;
  const sortedActions: StagehandActionRaw[] = validatedActions
    .slice()
    .sort((a, b) => actionTime(a) - actionTime(b));

  const actionSteps: ActionStep[] = [];
  for (let i = 0; i < sortedActions.length; i++) {
    const a = sortedActions[i];
    const tsMs = actionTime(a) || Date.now();
    const tsIso = new Date(tsMs).toISOString();
    const nextTsMs = actionTime(sortedActions[i + 1]) || Number.POSITIVE_INFINITY;

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
        description: summarizeAction(a),
        method: a.type ?? a.method,
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

  const steps: TraceStep[] = actionSteps;
  return { header, steps };
}
