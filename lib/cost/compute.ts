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
