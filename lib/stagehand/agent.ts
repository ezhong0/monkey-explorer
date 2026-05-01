// Wraps Stagehand's `agent.execute` with our internal AgentResult type.
//
// Note: Stagehand v3's agent.execute does NOT accept AbortSignal (verified
// Phase 0). The `signal` parameter here is for the framework's own
// bookkeeping (e.g., propagating SIGINT to other phases of runMission);
// we do NOT pass it to Stagehand. Cancellation propagates via session
// close → CDP disconnect → agent.execute throws.
//
// Findings are extracted via a SECOND LLM call after agent.execute returns —
// see lib/stagehand/extract.ts. This depends on the BB session's CDP WS
// staying alive across the gap. Inline tool emission (via AgentConfig.tools)
// would close that gap, but Stagehand v3.0.0's compiled handler at
// dist/index.js:10315 ignores user-provided tools — the type-def field is
// aspirational. When upstream fixes that, switch to a `report_finding` tool.

import type { Stagehand } from '@browserbasehq/stagehand';

export interface AgentResult {
  success: boolean;
  message: string;
  stepsTaken: number;
  tokensUsed?: number;
  error?: { kind: 'timeout' | 'rate_limit' | 'other'; message: string };
}

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
  // Build a guardrail-prefixed instruction. Defense against prompt injection
  // (S2 finding): refuse cross-domain navigation and destructive actions
  // unless the mission explicitly directs them.
  const guardedInstruction = [
    'You are an exploratory testing agent. Constraints:',
    '- Stay within the target app domain. Do not navigate to external URLs.',
    '- Do not perform destructive actions (delete account, deactivate, transfer funds, etc.) unless the mission explicitly directs them.',
    '- When the mission is complete or you have run out of useful actions, stop.',
    '',
    'Mission:',
    opts.instruction.trim(),
  ].join('\n');

  const agent = opts.stagehand.agent({
    model: { modelName: opts.agentModel, apiKey: opts.agentApiKey },
  });

  if (opts.signal.aborted) {
    return {
      success: false,
      message: 'Aborted before agent started',
      stepsTaken: 0,
      error: { kind: 'timeout', message: 'aborted' },
    };
  }

  try {
    const result = await agent.execute({
      instruction: guardedInstruction,
      maxSteps: opts.maxSteps,
    });

    // Stagehand v3 AgentResult.usage shape is { input_tokens, output_tokens,
    // inference_time_ms } per the d.ts (verified during smoke test).
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
      ? ((result as { actions: unknown[] }).actions.length)
      : 0;

    return {
      success: result.success ?? false,
      message: result.message ?? '',
      stepsTaken: actionsLen,
      tokensUsed: typeof tokensUsed === 'number' ? tokensUsed : undefined,
    };
  } catch (err) {
    return {
      success: false,
      message: '',
      stepsTaken: 0,
      error: classifyError(err),
    };
  }
}
