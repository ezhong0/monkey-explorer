// Run-agent stage: execute the agent loop, return its raw outputs +
// classify any failure into a FailureCause.
//
// The agent's classifyError emits 'timeout' | 'rate_limit' | 'other' kinds;
// this stage maps those into the FailureCause taxonomy plus a wallclock
// override (when the wallclock timer fired before the agent finished, the
// underlying error is usually a "session was closed" — but the right cause
// is 'wallclock', not whatever the SDK threw).

import type { Stagehand } from '@browserbasehq/stagehand';
import { executeAgent } from '../stagehand/agent.js';
import type { StageResult } from './types.js';
import { ok, fail } from './types.js';

export interface RunAgentStageOpts {
  stagehand: Stagehand;
  agentModel: string;
  agentApiKey: string;
  agentBaseURL?: string;
  executionModel?: string;
  executionApiKey?: string;
  instruction: string;
  maxSteps: number;
  signal: AbortSignal;
  /** Snapshot of timer state taken AFTER agent.execute returns. If true,
   *  the wallclock cap fired during the agent loop — the FailureCause is
   *  'wallclock' regardless of what the SDK threw. */
  timerFired: () => boolean;
}

export interface RunAgentValue {
  rawActions: unknown[];
  tokensUsed?: number;
}

export async function runAgent(opts: RunAgentStageOpts): Promise<StageResult<RunAgentValue>> {
  const result = await executeAgent({
    stagehand: opts.stagehand,
    agentModel: opts.agentModel,
    agentApiKey: opts.agentApiKey,
    agentBaseURL: opts.agentBaseURL,
    executionModel: opts.executionModel,
    executionApiKey: opts.executionApiKey,
    instruction: opts.instruction,
    maxSteps: opts.maxSteps,
    signal: opts.signal,
  });

  // Even on agent error, surface partial outputs (rawActions/tokensUsed
  // can carry signal — Stagehand returns rawActions: [] on throw, but in
  // partial-failure paths it can hold pre-throw actions).
  const value: RunAgentValue = {
    rawActions: result.rawActions,
    tokensUsed: result.tokensUsed,
  };

  if (!result.error) return ok(value);

  // Classify. Wallclock-fire trumps everything else — the agent's
  // "session closed" error is collateral damage from our session.close()
  // wallclock callback.
  if (opts.timerFired()) return fail('wallclock', result.error.message);
  if (result.error.kind === 'rate_limit') return fail('rate_limited', result.error.message);
  return fail('agent_errored', result.error.message);
}
