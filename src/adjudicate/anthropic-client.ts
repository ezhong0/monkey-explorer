// Anti-corruption boundary: only file in the adjudicate module that
// imports the Anthropic SDK directly. Future routing logic (Vercel AI
// Gateway, multi-provider failover, fallback to OpenAI) lands here so
// run.ts stays focused on the adjudicator's prompt + retry loop.
//
// Today's responsibilities are minimal — construct an Anthropic client
// with optional baseURL override (Azure Foundry routing).
//
// Why the official Anthropic SDK and not @ai-sdk/anthropic? The adjudicator
// is a one-shot tool-use call; the official SDK has cleaner support for
// `tool_choice: { type: 'tool', name }` and the cache_control format.
// The agent (src/stagehand/agent.ts) goes through Stagehand's AI-SDK path
// for a different reason (hybrid mode + executionModel split).

import Anthropic from '@anthropic-ai/sdk';

export type AnthropicClient = Anthropic;
export type AnthropicMessage = Anthropic.Message;
export type AnthropicToolInputSchema = Anthropic.Tool.InputSchema;

export interface CreateAnthropicClientOpts {
  apiKey: string;
  /** Optional baseURL — e.g., Azure Foundry endpoint
   *  (https://<resource>.services.ai.azure.com/anthropic). The official
   *  Anthropic SDK auto-appends `/v1/messages` to baseURL, so users store
   *  the bare `.../anthropic` form. (The Stagehand AI-SDK path needs the
   *  `/v1` suffix appended explicitly — handled in src/stagehand/agent.ts.) */
  baseURL?: string;
}

export function createAnthropicClient(opts: CreateAnthropicClientOpts): AnthropicClient {
  return new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
}
