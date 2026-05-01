// Wraps Stagehand's `agent.execute` with our internal AgentResult type.
//
// Two paths, picked by model:
//   - CUA-capable Anthropic model (claude-sonnet/opus/haiku-*): runs in
//     `mode: "cua"` with an inline `report_finding` tool. The model emits
//     findings as it explores; no post-hoc extract LLM call needed.
//   - Anything else (e.g. openai/gpt-5.5): runs in default `mode: "dom"`
//     without inline tools. Findings come from the post-hoc extract
//     instead (see lib/stagehand/extract.ts). The AISDK/DOM path has a
//     hardcoded `<tools>` system-prompt block that doesn't advertise user
//     tools, so models reliably ignore them there.
//
// Why Anthropic-only for the CUA path: Stagehand 3.3.0's OpenAICUAClient
// passes tool.inputSchema raw as `parameters` (no toJsonSchema conversion),
// so OpenAI receives a malformed tool definition and the model calls
// report_finding with empty args. AnthropicCUAClient does run
// toJsonSchema(), so Zod schemas work correctly. We had a workaround for
// the OpenAI bug but committed to Anthropic for cleaner code; if upstream
// fixes OpenAICUAClient, it can be re-added by extending CUA_MODEL_PATTERNS.
//
// Stagehand v3's agent.execute does NOT accept AbortSignal. Our `signal`
// param propagates SIGINT to other phases of runMission only;
// agent-level cancellation goes through session close → CDP disconnect →
// agent.execute throws.
//
// `experimental: true` on Stagehand init is required for custom tools per
// the upstream example (packages/core/examples/agent-custom-tools.ts).

import { tool, type Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { sanitizeFinding } from '../findings/sanitize.js';
import type { Finding } from '../types.js';

export interface AgentResult {
  success: boolean;
  message: string;
  stepsTaken: number;
  tokensUsed?: number;
  /** Findings emitted by the model via the inline `report_finding` tool.
   *  Empty when running on the non-CUA path (extract picks them up there). */
  findings: Finding[];
  error?: { kind: 'timeout' | 'rate_limit' | 'other'; message: string };
}

// Substring patterns rather than exact strings so newer point releases
// (e.g. claude-sonnet-4-5-20251215) work without us re-publishing.
const CUA_MODEL_PATTERNS = [/^anthropic\/claude-(sonnet|opus|haiku)-/];

function isCuaCapable(modelName: string): boolean {
  return CUA_MODEL_PATTERNS.some((re) => re.test(modelName));
}

const REPORT_FINDING_DESCRIPTION =
  'Record a bug, polish issue, or notable observation discovered during exploration. Call this AS YOU EXPLORE — every time you notice something worth flagging — instead of waiting until the end. Calling it does not stop the mission. ALWAYS provide all three fields: severity, summary, details.';

const REPORT_FINDING_SCHEMA = z.object({
  severity: z
    .enum(['critical', 'high', 'medium', 'low', 'observation'])
    .describe(
      'critical = blocks core flows or data corruption; high = significant bug; medium = workaround exists but UX clearly degraded; low = visual / polish; observation = not a bug, worth noting',
    ),
  summary: z.string().min(1).describe('One-line headline. Concrete, not vague.'),
  details: z
    .string()
    .describe(
      'Reproduction steps, expected vs actual, any error messages observed. Concrete enough that a human can verify.',
    ),
});

function classifyError(err: unknown): NonNullable<AgentResult['error']> {
  const e = err as { error?: { type?: string }; status?: number; message?: string };
  if (
    e?.error?.type === 'rate_limit_error' ||
    e?.error?.type === 'overloaded_error' ||
    e?.status === 429 ||
    /token|rate.limit|context.length/i.test(e?.message ?? '')
  ) {
    return { kind: 'rate_limit', message: e?.message ?? String(err) };
  }
  if (/closed|disconnected|cancelled|aborted|timeout/i.test(e?.message ?? '')) {
    return { kind: 'timeout', message: e?.message ?? String(err) };
  }
  return { kind: 'other', message: e?.message ?? String(err) };
}

export async function executeAgent(opts: {
  stagehand: Stagehand;
  agentModel: string;
  agentApiKey: string;
  instruction: string;
  maxSteps: number;
  signal: AbortSignal;
}): Promise<AgentResult> {
  const useCua = isCuaCapable(opts.agentModel);

  // Findings emitted via the inline tool (CUA path only). Closure-captured
  // and read after agent.execute returns.
  const collected: Finding[] = [];
  const reportFinding = tool({
    description: REPORT_FINDING_DESCRIPTION,
    inputSchema: REPORT_FINDING_SCHEMA,
    execute: async (input) => {
      collected.push(sanitizeFinding(input as Finding));
      return { ok: true };
    },
  });

  // Custom system prompt. In Stagehand 3.3.0, agent.execute renders
  // `systemPrompt` inside a <customInstructions> block alongside the default
  // tool guidance — additive, not a replacement. We use it to make
  // report_finding visible at the prompt level (the default <tools> XML
  // block lists only built-in Stagehand tools).
  const systemPrompt = [
    'You are an exploratory testing agent for a web app. Constraints:',
    '- Stay within the target app domain. Do not navigate to external URLs.',
    '- Do not perform destructive actions (delete account, deactivate, transfer funds, etc.) unless the mission explicitly directs them.',
    '- When the mission is complete or you have run out of useful actions, stop.',
    useCua
      ? '\nWhile exploring, call the `report_finding` tool whenever you observe a bug, polish issue, or anything worth flagging for human review. Report findings as you find them — do not wait until the end. The mission only ends when you stop, not when you call report_finding.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const agent = opts.stagehand.agent({
    model: { modelName: opts.agentModel, apiKey: opts.agentApiKey },
    systemPrompt,
    ...(useCua
      ? {
          mode: 'cua' as const,
          tools: { report_finding: reportFinding },
        }
      : {}),
  });

  if (opts.signal.aborted) {
    return {
      success: false,
      message: 'Aborted before agent started',
      stepsTaken: 0,
      findings: [],
      error: { kind: 'timeout', message: 'aborted' },
    };
  }

  try {
    const result = await agent.execute({
      instruction: opts.instruction.trim(),
      maxSteps: opts.maxSteps,
    });

    const usage = (
      result as unknown as {
        usage?: { input_tokens?: number; output_tokens?: number };
      }
    ).usage;
    const tokensUsed =
      usage?.input_tokens != null && usage?.output_tokens != null
        ? usage.input_tokens + usage.output_tokens
        : undefined;

    const actionsLen = Array.isArray((result as { actions?: unknown[] }).actions)
      ? (result as { actions: unknown[] }).actions.length
      : 0;

    return {
      success: result.success ?? false,
      message: result.message ?? '',
      stepsTaken: actionsLen,
      tokensUsed: typeof tokensUsed === 'number' ? tokensUsed : undefined,
      findings: collected,
    };
  } catch (err) {
    return {
      success: false,
      message: '',
      stepsTaken: 0,
      findings: collected, // surface anything captured before the failure
      error: classifyError(err),
    };
  }
}
