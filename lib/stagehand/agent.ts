// Wraps Stagehand's `agent.execute` with our internal AgentResult type.
//
// Two paths, picked by model:
//   - CUA-capable Anthropic model (claude-sonnet/opus/haiku-*): runs in
//     `mode: "cua"` with an inline `record_observation` tool. The model
//     emits NEUTRAL observations as it explores — it does NOT decide
//     severity. The post-mission adjudicator pass (lib/adjudicate/) reads
//     observations + actions + console/network events and produces actual
//     findings with cited provenance.
//   - Anything else (e.g. openai/gpt-5.5): runs in default `mode: "dom"`.
//     Stagehand's AISDK path doesn't advertise user tools in the prompt's
//     `<tools>` block, so observations would never be recorded. The
//     non-CUA path collects no observations; findings come solely from
//     the deterministic lifter (console/network) + adjudicator over
//     Stagehand's returned `actions[]`.
//
// Why Anthropic-only for the CUA path: Stagehand 3.3.0's OpenAICUAClient
// passes tool.inputSchema raw as `parameters` (no toJsonSchema conversion),
// so OpenAI receives a malformed tool definition.
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
import { sanitizeText } from '../findings/sanitize.js';

/** Neutral observation recorded by the explorer mid-mission. No severity,
 *  no judgment — adjudicator decides if it indicates a finding. */
export interface RecordedObservation {
  text: string;
  /** Best-effort: the action index closest to when this observation fired.
   *  Used to associate the observation to a step in the trace. */
  recordedAt: string; // ISO timestamp
}

export interface AgentResult {
  success: boolean;
  message: string;
  stepsTaken: number;
  tokensUsed?: number;
  /** Observations the explorer recorded via the `record_observation` tool. */
  observations: RecordedObservation[];
  /** Stagehand's raw actions[] from agent.execute. Used by the trace writer
   *  to build action steps; passed through opaquely. */
  rawActions: unknown[];
  error?: { kind: 'timeout' | 'rate_limit' | 'other'; message: string };
}

// Substring patterns rather than exact strings so newer point releases
// (e.g. claude-sonnet-4-5-20251215) work without us re-publishing.
const CUA_MODEL_PATTERNS = [/^anthropic\/claude-(sonnet|opus|haiku)-/];

function isCuaCapable(modelName: string): boolean {
  return CUA_MODEL_PATTERNS.some((re) => re.test(modelName));
}

const RECORD_OBSERVATION_DESCRIPTION =
  'Record a NEUTRAL observation about something you noticed during exploration. Use this to flag anything that might be worth a human reviewing — a bug, an empty state, a confusing UI, a slow response, an unexpected error, anything notable. Do NOT assign severity or label things as broken; just describe what you saw factually. Call this AS YOU EXPLORE — don\'t batch observations until the end. Calling it does not stop the mission. The post-mission adjudicator decides which observations represent real findings.';

const RECORD_OBSERVATION_SCHEMA = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      'Concrete factual description of what you observed. Examples: "The Save button shows a loading spinner for 8 seconds before responding"; "Clicking the avatar in the top-right opens a menu with Logout, Settings, Help"; "The search box accepted my input but returned no results for a query I expected to match". Avoid words like "broken", "bug", "high severity" — leave judgment to the adjudicator.',
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
  /** Optional Anthropic base URL override (e.g. Azure Foundry endpoint).
   *  When set, model name is sent unprefixed and provider is forced to
   *  'anthropic' (bypassing Stagehand's modelToAgentProviderMap lookup,
   *  which doesn't know Azure-deployed model names). */
  agentBaseURL?: string;
  instruction: string;
  maxSteps: number;
  /** Optional hard cost ceiling. After each step, cumulative LLM tokens are
   *  checked; exceeding this calls `onBudgetExceeded` (caller's job to actually
   *  stop the agent — typically by closing the BB session, which kills the
   *  CDP transport and forces the agent to throw). On natural exit, executeAgent
   *  detects the breach and returns 'rate_limit' error (→ RunStatus.exceeded_tokens). */
  tokenBudget?: number;
  /** Called once when tokenBudget is exceeded. Caller decides how to halt the
   *  agent (e.g., session.close()). Stagehand v3.3 doesn't accept AbortSignal
   *  in CUA mode, so killing the BB session is the only mid-flight stop. */
  onBudgetExceeded?: () => void;
  signal: AbortSignal;
}): Promise<AgentResult> {
  const useCua = isCuaCapable(opts.agentModel);
  const useAzure = !!opts.agentBaseURL;
  // Azure Foundry rejects prefixed model names ("anthropic/claude-..."),
  // it wants the raw deployment name. Direct Anthropic accepts the prefix.
  const apiModelName = useAzure
    ? opts.agentModel.replace(/^anthropic\//, '')
    : opts.agentModel;

  // Observations emitted via the inline tool (CUA path only). Closure-captured
  // and read after agent.execute returns.
  const observations: RecordedObservation[] = [];
  const recordObservation = tool({
    description: RECORD_OBSERVATION_DESCRIPTION,
    inputSchema: RECORD_OBSERVATION_SCHEMA,
    execute: async (input) => {
      observations.push({
        text: sanitizeText(input.text),
        recordedAt: new Date().toISOString(),
      });
      return { ok: true };
    },
  });

  const systemPrompt = [
    'You are an exploratory testing agent for a web app. Constraints:',
    '- Stay within the target app domain. Do not navigate to external URLs.',
    '- Do not perform destructive actions (delete account, deactivate, transfer funds, etc.) unless the mission explicitly directs them.',
    '- When the mission is complete or you have run out of useful actions, stop.',
    useCua
      ? '\nWhile exploring, call the `record_observation` tool whenever you notice something potentially interesting — even if you\'re not sure it\'s a bug. Describe what you saw factually; do NOT assign severity or label things as broken. The post-mission adjudicator will decide which observations represent real findings. Record observations AS YOU EXPLORE; don\'t batch them.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const agent = opts.stagehand.agent({
    model: {
      modelName: apiModelName,
      apiKey: opts.agentApiKey,
      ...(useAzure
        ? {
            baseURL: opts.agentBaseURL,
            provider: 'anthropic',
          }
        : {}),
    },
    systemPrompt,
    ...(useCua
      ? {
          mode: 'cua' as const,
          tools: { record_observation: recordObservation },
        }
      : {}),
  });

  if (opts.signal.aborted) {
    return {
      success: false,
      message: 'Aborted before agent started',
      stepsTaken: 0,
      observations: [],
      rawActions: [],
      error: { kind: 'timeout', message: 'aborted' },
    };
  }

  let runningTokens = 0;
  let budgetExceeded = false;
  const tokenBudget = opts.tokenBudget;

  try {
    const result = await agent.execute({
      instruction: opts.instruction.trim(),
      maxSteps: opts.maxSteps,
      // No `signal` — Stagehand v3.3 throws InvalidArgumentError for CUA
      // mode if signal is set. Budget enforcement uses the onBudgetExceeded
      // callback (caller closes the BB session, which kills the agent's CDP
      // transport and forces it to throw naturally).
      callbacks: {
        // Stagehand v3.3 fires this after every LLM step (CUA + DOM modes).
        // We use it for streaming token-budget enforcement.
        onStepFinish: ((step: unknown) => {
          const u = (step as { usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } })
            .usage;
          const stepTokens =
            u?.totalTokens ??
            ((u?.inputTokens ?? 0) + (u?.outputTokens ?? 0)) ??
            0;
          runningTokens += stepTokens;
          if (tokenBudget != null && runningTokens > tokenBudget && !budgetExceeded) {
            budgetExceeded = true;
            opts.onBudgetExceeded?.();
          }
        }) as never,
      },
    });

    const usage = (
      result as unknown as {
        usage?: { input_tokens?: number; output_tokens?: number };
      }
    ).usage;
    const tokensUsed =
      usage?.input_tokens != null && usage?.output_tokens != null
        ? usage.input_tokens + usage.output_tokens
        : runningTokens > 0
          ? runningTokens
          : undefined;

    const actions = Array.isArray((result as { actions?: unknown[] }).actions)
      ? (result as { actions: unknown[] }).actions
      : [];

    if (budgetExceeded) {
      return {
        success: false,
        message: result.message ?? '',
        stepsTaken: actions.length,
        tokensUsed,
        observations,
        rawActions: actions,
        error: {
          kind: 'rate_limit',
          message: `Token budget exceeded: ${runningTokens.toLocaleString()} > ${tokenBudget?.toLocaleString()}`,
        },
      };
    }

    return {
      success: result.success ?? false,
      message: result.message ?? '',
      stepsTaken: actions.length,
      tokensUsed: typeof tokensUsed === 'number' ? tokensUsed : undefined,
      observations,
      rawActions: actions,
    };
  } catch (err) {
    // If we triggered onBudgetExceeded (caller closed the BB session), the
    // agent will throw a CDP-transport-closed error. Classify as rate_limit
    // (→ RunStatus.exceeded_tokens) rather than 'other' so the user sees
    // the right reason.
    if (budgetExceeded) {
      return {
        success: false,
        message: '',
        stepsTaken: 0,
        tokensUsed: runningTokens > 0 ? runningTokens : undefined,
        observations,
        rawActions: [],
        error: {
          kind: 'rate_limit',
          message: `Token budget exceeded: ${runningTokens.toLocaleString()} > ${tokenBudget?.toLocaleString()}`,
        },
      };
    }
    return {
      success: false,
      message: '',
      stepsTaken: 0,
      tokensUsed: runningTokens > 0 ? runningTokens : undefined,
      observations, // surface anything captured before the failure
      rawActions: [],
      error: classifyError(err),
    };
  }
}
