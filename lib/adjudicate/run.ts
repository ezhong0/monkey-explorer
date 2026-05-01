// Adjudicator pass: post-mission LLM call that reads the trace and emits
// findings with cited provenance. Separate from the explorer — fresh
// context, different prompt, different role.
//
// Schema-bound output via Anthropic's tool API. Output gets parsed with
// AdjudicatedFindingsListSchema; cross-references checked by validate.ts.
//
// Failure modes:
//   - Zod parse error → ONE retry with the parse error injected as feedback
//   - Rate limit / 429   → no retry (don't burn quota); throws RateLimitError
//   - Other errors       → throw, runMission marks status=adjudicator_failed

import Anthropic from '@anthropic-ai/sdk';
import { toJsonSchema } from '@browserbasehq/stagehand';
import { z } from 'zod';
import {
  AdjudicatedFindingsListSchema,
  type AdjudicatedFindingsList,
} from '../findings/schema.js';
import type { Finding } from '../types.js';
import type { Trace } from '../trace/schema.js';
import { validateAdjudicatedFindings } from './validate.js';

export class AdjudicatorError extends Error {
  constructor(message: string, public readonly kind: 'rate_limit' | 'parse' | 'other') {
    super(message);
    this.name = 'AdjudicatorError';
  }
}

const ADJUDICATOR_TOOL_NAME = 'submit_findings';

const SYSTEM_PROMPT = [
  'You are an exploratory testing adjudicator. You are reading the trace of a mission an exploration agent just ran against a web app, and deciding which observations represent real findings worth flagging to a human reviewer.',
  '',
  'You are SKEPTICAL by default. The exploration agent is biased toward finding things; your job is to gate that bias.',
  '',
  'STRICT RULES:',
  '- Every finding you submit MUST cite at least one provenance entry: { stepId: "step_NNNN" or "step_console_NNNN" or "step_network_NNNN", evidenceType: one of "network"|"console"|"observation"|"screenshot"|"dom"|"diff" }',
  '- The stepId must reference a real step in the trace below. If you cite a stepId not in the trace, the finding is auto-demoted to speculative.',
  '- The evidenceType must match what that step actually contains. Cited "network" → step has a network event. Cited "console" → step has a console event. Cited "observation" → step is an observation. Otherwise auto-demoted.',
  '- DO NOT cite "screenshot" or "dom" — V1 trace does not capture per-step screenshots or DOM snapshots; those citations will fail cross-reference.',
  '- DO NOT speculate about HTML element types (anchor tags, click handlers, routing) you cannot confirm. The trace gives you actions + observations + network/console — judge by what the trace shows, not by visual styling priors.',
  '',
  'NETWORK + CONSOLE FINDINGS HAVE ALREADY BEEN LIFTED automatically (see below). Do NOT re-emit findings for the same console errors / 4xx / 5xx events that the lifter already produced. Build on them: e.g. if the lifter flagged a 500 on /api/foo, you might add a finding describing the user-visible impact, citing both the lifter\'s network stepId AND a relevant action stepId where the 500 was triggered.',
  '',
  'Severity rubric:',
  '  critical = blocks core flows or causes data corruption / loss',
  '  high = significant bug; prevents user goal',
  '  medium = workaround exists but UX clearly degraded',
  '  low = visual / polish issue',
  '  observation = not a bug, but worth noting',
  '',
  'If nothing in the trace warrants a finding beyond what the lifter already produced, return findings: []. An empty result is correct and valuable when the mission found nothing.',
].join('\n');

function summarizeStep(step: Trace['steps'][number]): string {
  if (step.type === 'action') {
    const events = [
      step.consoleEvents.length > 0 ? `console:${step.consoleEvents.length}` : null,
      step.networkEvents.length > 0 ? `network:${step.networkEvents.length}` : null,
    ]
      .filter(Boolean)
      .join(',');
    const eventsSuffix = events ? ` [${events}]` : '';
    return `${step.id} @ ${step.url}: ${step.action.method ?? 'action'} — ${step.action.description}${eventsSuffix}`;
  }
  return `${step.id} (observation): ${step.text}`;
}

function summarizeTrace(trace: Trace): string {
  const lines: string[] = [];
  lines.push(`Mission: ${trace.header.mission}`);
  lines.push(`Target: ${trace.header.target}`);
  lines.push(`Started: ${trace.header.startedAt}`);
  lines.push(`Steps: ${trace.steps.length}`);
  lines.push('');
  lines.push('--- TRACE ---');
  for (const s of trace.steps) {
    lines.push(summarizeStep(s));
    if (s.type === 'action') {
      for (const e of s.consoleEvents) {
        lines.push(`    [console.${e.level}] ${e.message.slice(0, 200)}${e.message.length > 200 ? '…' : ''}`);
      }
      for (const e of s.networkEvents) {
        lines.push(`    [network ${e.method} ${e.status ?? e.failure ?? '?'}] ${e.url}`);
      }
    }
  }
  return lines.join('\n');
}

function summarizeLiftedFindings(lifted: Finding[]): string {
  if (lifted.length === 0) return '(none)';
  return lifted
    .map((f, i) => {
      const provIds = f.provenance?.map((p) => p.stepId).join(',') ?? '';
      return `[${i}] ${f.severity} (verified, provenance=${provIds}): ${f.summary}`;
    })
    .join('\n');
}

function buildUserPrompt(trace: Trace, liftedFindings: Finding[]): string {
  return [
    summarizeTrace(trace),
    '',
    '--- ALREADY-LIFTED FINDINGS (deterministic, oracle-backed) ---',
    summarizeLiftedFindings(liftedFindings),
    '',
    `Now use the ${ADJUDICATOR_TOOL_NAME} tool to submit any additional findings. If there are none beyond the lifter's, submit findings: [].`,
  ].join('\n');
}

// Derived from the Zod schema so the two can't drift. The post-parse
// cross-reference (validate.ts) still verifies the cited step actually
// exists in the trace / lifter set — schema enforces shape, validator
// enforces references.
const ADJUDICATOR_TOOL_INPUT_SCHEMA = toJsonSchema(AdjudicatedFindingsListSchema);

interface AdjudicatorOptions {
  apiKey: string;
  baseURL?: string;
  model: string;          // e.g. "claude-opus-4-6" (no "anthropic/" prefix for direct SDK)
  trace: Trace;
  liftedFindings: Finding[];
  liftedStepIds: ReadonlySet<string>;
}

function unwrapToolUseFindings(message: Anthropic.Message): unknown {
  for (const block of message.content) {
    if (block.type === 'tool_use' && block.name === ADJUDICATOR_TOOL_NAME) {
      return block.input;
    }
  }
  throw new AdjudicatorError(
    `Adjudicator did not call ${ADJUDICATOR_TOOL_NAME}; got: ${message.content.map((b) => b.type).join(', ')}`,
    'parse',
  );
}

async function callAdjudicator(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<AdjudicatedFindingsList> {
  const message = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    tools: [
      {
        name: ADJUDICATOR_TOOL_NAME,
        description: 'Submit the final adjudicated findings list.',
        input_schema: ADJUDICATOR_TOOL_INPUT_SCHEMA as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: 'tool', name: ADJUDICATOR_TOOL_NAME },
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = unwrapToolUseFindings(message);
  return AdjudicatedFindingsListSchema.parse(raw);
}

/** Run the adjudicator. Returns the validated, tier-assigned findings.
 *  Does NOT include the lifted findings — caller concatenates. */
export async function runAdjudicator(opts: AdjudicatorOptions): Promise<Finding[]> {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });

  const systemPrompt = SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(opts.trace, opts.liftedFindings);

  let parsed: AdjudicatedFindingsList;
  try {
    parsed = await callAdjudicator(client, opts.model, systemPrompt, userPrompt);
  } catch (err) {
    // Detect rate limit cleanly (no retry — don't burn quota)
    if (isRateLimit(err)) {
      throw new AdjudicatorError((err as Error).message ?? 'rate limited', 'rate_limit');
    }
    // Zod parse failure → ONE retry with the error as feedback
    if (err instanceof z.ZodError) {
      const feedback = `Your previous response failed schema validation: ${err.message}\n\nPlease retry; ensure findings is an array and every finding has severity, summary, details, and provenance (≥1 entry).`;
      try {
        parsed = await callAdjudicator(
          client,
          opts.model,
          systemPrompt,
          `${userPrompt}\n\n${feedback}`,
        );
      } catch (retryErr) {
        throw new AdjudicatorError(
          `Adjudicator parse failed twice: ${(retryErr as Error).message}`,
          'parse',
        );
      }
    } else if (err instanceof AdjudicatorError) {
      throw err;
    } else {
      throw new AdjudicatorError((err as Error).message ?? String(err), 'other');
    }
  }

  return validateAdjudicatedFindings(parsed.findings, opts.trace, opts.liftedStepIds);
}

function isRateLimit(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 429 || /rate.limit|429/i.test(e?.message ?? '');
}
