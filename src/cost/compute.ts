// Cost estimation. Phase 0 spike confirmed AgentResult.usage is exposed
// (Q3 closed: cost tracking is feasible).
//
// Browserbase: ~$0.10 per session-minute (Developer plan). Approximate.
// LLM: per-model price table. CUA pattern is heavy input (screenshots) /
// brief output (action calls); we use a 90/10 input/output weighting to
// derive an effective $/M rate for back-of-the-envelope display.

const BB_DOLLARS_PER_MINUTE = 0.10;

// Per-model pricing as of 2026-05. From Anthropic/OpenAI public price pages.
// Add new models here as they launch.
const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  // Anthropic — current
  'anthropic/claude-opus-4-7': { inputPerM: 5, outputPerM: 25 },
  'anthropic/claude-opus-4-6': { inputPerM: 5, outputPerM: 25 },
  'anthropic/claude-opus-4-5': { inputPerM: 5, outputPerM: 25 },
  'anthropic/claude-opus-4-5-20251101': { inputPerM: 5, outputPerM: 25 },
  'anthropic/claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
  'anthropic/claude-sonnet-4-5': { inputPerM: 3, outputPerM: 15 },
  'anthropic/claude-sonnet-4-5-20250929': { inputPerM: 3, outputPerM: 15 },
  'anthropic/claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
  'anthropic/claude-haiku-4-5-20251001': { inputPerM: 1, outputPerM: 5 },
  // Anthropic — legacy
  'anthropic/claude-opus-4-1': { inputPerM: 15, outputPerM: 75 },
  'anthropic/claude-opus-4-1-20250805': { inputPerM: 15, outputPerM: 75 },
  // OpenAI — approximate
  'openai/gpt-5.5': { inputPerM: 5, outputPerM: 15 },
  'openai/gpt-5.4': { inputPerM: 3, outputPerM: 12 },
};

const DEFAULT_PRICING = { inputPerM: 5, outputPerM: 25 }; // Opus-tier fallback for unknown models

/** CUA-typical 90/10 input/output split. Browser agents send heavy
 *  screenshot context (input) and brief action calls (output). Adjust if
 *  the workload changes shape (e.g., long text-extraction pulls). */
function effectiveTokenRate(modelName: string | undefined): number {
  if (!modelName) return 10; // legacy fallback
  const p = MODEL_PRICING[modelName] ?? DEFAULT_PRICING;
  return p.inputPerM * 0.9 + p.outputPerM * 0.1;
}

export interface CostBreakdown {
  bbMinutes: number;
  bbDollars: number;
  tokens: number | null;
  llmDollars: number | null;
  totalDollars: number;
  /** Effective $/M rate used for the calc, for callers that want to display it. */
  effectiveRate: number;
}

export function computeCost(opts: {
  ranForMs: number;
  tokensUsed: number | undefined;
  /** Agent model used; determines the effective $/M rate. Falls back to
   *  the legacy $10/M constant if not provided (preserves existing behavior
   *  for callsites that haven't been threaded through yet). */
  agentModel?: string;
}): CostBreakdown {
  const bbMinutes = opts.ranForMs / 60_000;
  const bbDollars = bbMinutes * BB_DOLLARS_PER_MINUTE;
  const tokens = opts.tokensUsed ?? null;
  const effectiveRate = effectiveTokenRate(opts.agentModel);
  const llmDollars =
    tokens != null ? (tokens / 1_000_000) * effectiveRate : null;
  const totalDollars = bbDollars + (llmDollars ?? 0);
  return { bbMinutes, bbDollars, tokens, llmDollars, totalDollars, effectiveRate };
}

export function formatCostSummary(c: CostBreakdown): string {
  // The displayed LLM cost is the AGENT model only. Stagehand's hybrid mode
  // routes in-agent grounding (act/extract internals) through a separate
  // executionModel — those tokens aren't in the agent's `result.usage` and
  // aren't tracked here. The grounding model is typically cheaper per token,
  // so the actual total is somewhat higher than displayed but close to the
  // same order of magnitude.
  const parts: string[] = [];
  if (c.tokens != null && c.llmDollars != null) {
    parts.push(
      `~$${c.llmDollars.toFixed(2)} LLM agent (${c.tokens.toLocaleString()} tokens @ $${c.effectiveRate.toFixed(2)}/M, grounding not counted)`,
    );
  } else {
    parts.push('LLM cost: n/a (tokens not surfaced)');
  }
  parts.push(`${c.bbMinutes.toFixed(1)}m × $${BB_DOLLARS_PER_MINUTE}/min Browserbase`);
  parts.push(`≈ $${c.totalDollars.toFixed(2)} total`);
  return `Cost: ${parts.join(' + ').replace(' + ≈', ' ≈')}`;
}

// ─── Preflight estimate ─────────────────────────────────────────────────────
//
// Per-mission token bands by mission shape. Empirically derived from observed
// runs — quick smoke missions ~10-30k tokens; complex multi-tool-use chains
// or maxSteps-bound missions ~150-300k tokens.

const TOKENS_PER_MISSION_LOW = 30_000;
const TOKENS_PER_MISSION_HIGH = 300_000;

export interface CostEstimate {
  bbDollarsMax: number;
  llmDollarsLow: number;
  llmDollarsHigh: number;
  totalLow: number;
  totalHigh: number;
  effectiveRate: number;
}

export function estimateCostRange(opts: {
  missionCount: number;
  wallClockMs: number;
  agentModel?: string;
}): CostEstimate {
  const minutesPerMission = opts.wallClockMs / 60_000;
  const bbDollarsMax = opts.missionCount * minutesPerMission * BB_DOLLARS_PER_MINUTE;
  const effectiveRate = effectiveTokenRate(opts.agentModel);
  const llmDollarsLow =
    opts.missionCount * (TOKENS_PER_MISSION_LOW / 1_000_000) * effectiveRate;
  const llmDollarsHigh =
    opts.missionCount * (TOKENS_PER_MISSION_HIGH / 1_000_000) * effectiveRate;
  return {
    bbDollarsMax,
    llmDollarsLow,
    llmDollarsHigh,
    totalLow: llmDollarsLow, // BB is pay-per-actual-minute; floor is just LLM
    totalHigh: bbDollarsMax + llmDollarsHigh,
    effectiveRate,
  };
}

export function formatCostEstimate(e: CostEstimate, missionCount: number): string {
  return (
    `Estimated cost: $${e.totalLow.toFixed(2)}–$${e.totalHigh.toFixed(2)} ` +
    `(up to $${e.bbDollarsMax.toFixed(2)} Browserbase + $${e.llmDollarsLow.toFixed(2)}–$${e.llmDollarsHigh.toFixed(2)} LLM at $${e.effectiveRate.toFixed(2)}/M, ` +
    `${missionCount} mission${missionCount === 1 ? '' : 's'}).`
  );
}
