// Cost estimation. Phase 0 spike confirmed AgentResult.usage is exposed
// (Q3 closed: cost tracking is feasible).
//
// Browserbase: ~$0.10 per session-minute (Developer plan). Approximate.
// OpenAI: depends on model; gpt-5.5 estimated ~$5 per 1M input tokens,
// $15 per 1M output. We don't know the in/out split from `usage.totalTokens`
// alone, so estimate at ~$10 per 1M total tokens (rough midpoint).

const BB_DOLLARS_PER_MINUTE = 0.10;
const OPENAI_DOLLARS_PER_MILLION_TOKENS = 10;

export interface CostBreakdown {
  bbMinutes: number;
  bbDollars: number;
  tokens: number | null;
  llmDollars: number | null;
  totalDollars: number;
}

export function computeCost(opts: {
  ranForMs: number;
  tokensUsed: number | undefined;
}): CostBreakdown {
  const bbMinutes = opts.ranForMs / 60_000;
  const bbDollars = bbMinutes * BB_DOLLARS_PER_MINUTE;
  const tokens = opts.tokensUsed ?? null;
  const llmDollars =
    tokens != null ? (tokens / 1_000_000) * OPENAI_DOLLARS_PER_MILLION_TOKENS : null;
  const totalDollars = bbDollars + (llmDollars ?? 0);
  return { bbMinutes, bbDollars, tokens, llmDollars, totalDollars };
}

export function formatCostSummary(c: CostBreakdown): string {
  const parts: string[] = [];
  if (c.tokens != null && c.llmDollars != null) {
    parts.push(`~$${c.llmDollars.toFixed(2)} OpenAI (${c.tokens.toLocaleString()} tokens)`);
  } else {
    parts.push('OpenAI cost: n/a (tokens not surfaced)');
  }
  parts.push(`${c.bbMinutes.toFixed(1)}m × $${BB_DOLLARS_PER_MINUTE}/min Browserbase`);
  parts.push(`≈ $${c.totalDollars.toFixed(2)} total`);
  return `Cost: ${parts.join(' + ').replace(' + ≈', ' ≈')}`;
}

// Per-mission LLM-cost band — wide on purpose. Real cost depends on how many
// steps the agent takes and how big the page DOM is. The lower bound assumes
// the agent finishes in a few steps; the upper assumes it runs near maxSteps
// with large screenshots / DOM payloads.
const LLM_DOLLARS_PER_MISSION_LOW = 0.30;
const LLM_DOLLARS_PER_MISSION_HIGH = 3.00;

export interface CostEstimate {
  bbDollarsMax: number;
  llmDollarsLow: number;
  llmDollarsHigh: number;
  totalLow: number;
  totalHigh: number;
}

export function estimateCostRange(opts: {
  missionCount: number;
  wallClockMs: number;
}): CostEstimate {
  const minutesPerMission = opts.wallClockMs / 60_000;
  const bbDollarsMax = opts.missionCount * minutesPerMission * BB_DOLLARS_PER_MINUTE;
  const llmDollarsLow = opts.missionCount * LLM_DOLLARS_PER_MISSION_LOW;
  const llmDollarsHigh = opts.missionCount * LLM_DOLLARS_PER_MISSION_HIGH;
  return {
    bbDollarsMax,
    llmDollarsLow,
    llmDollarsHigh,
    totalLow: llmDollarsLow,           // BB is pay-per-actual-minute; floor is just LLM
    totalHigh: bbDollarsMax + llmDollarsHigh,
  };
}

export function formatCostEstimate(e: CostEstimate, missionCount: number): string {
  return (
    `Estimated cost: $${e.totalLow.toFixed(2)}–$${e.totalHigh.toFixed(2)} ` +
    `(up to $${e.bbDollarsMax.toFixed(2)} Browserbase + $${e.llmDollarsLow.toFixed(2)}–$${e.llmDollarsHigh.toFixed(2)} LLM, ` +
    `${missionCount} mission${missionCount === 1 ? '' : 's'}).`
  );
}
