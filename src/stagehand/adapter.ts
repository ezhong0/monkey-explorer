// Anti-corruption boundary: only file in the framework that imports the
// Stagehand SDK directly.
//
// Verified during Phase 0 spike:
// - Constructor field is `browserbaseSessionID` (capital ID)
// - Page access is `stagehand.context.activePage()` or `context.newPage(url)`
//   — no top-level `stagehand.page` accessor
// - Logger callback signature: `(line: LogLine) => void`
// - Agent factory needs `model: { modelName, apiKey }` separately

import { Stagehand, type LogLine } from '@browserbasehq/stagehand';
import type { Page } from 'playwright-core';

export interface StagehandHandle {
  stagehand: Stagehand;
  /** Get or create the active page. */
  page(): Promise<Page>;
  close(): Promise<void>;
}

export interface CreateStagehandOpts {
  apiKey: string;
  projectId: string;
  sessionId: string;
  modelName: string;
  modelApiKey: string;
  /** Prefix every log line, e.g., "[1/3]". Empty for single-mission runs. */
  logPrefix: string;
}

// Filter Stagehand log categories. Suppress noisy internals; surface
// meaningful agent / extract / act events.
const SUPPRESSED_CATEGORIES = new Set([
  'init',
  'browserbase',
  'cdp',
  'observation',
]);

function shouldLog(line: LogLine): boolean {
  const cat = line.category ?? '';
  return !SUPPRESSED_CATEGORIES.has(cat);
}

function formatLogLine(line: LogLine, prefix: string): string {
  const cat = line.category ?? '?';
  const msg = (line.message ?? '').toString();
  // Multi-line log content: prefix every continuation line so parallel
  // sessions don't lose the [N/M] tag mid-message.
  const prefixed = prefix ? `${prefix} ` : '';
  const continuationPrefix = prefix ? `\n${prefix}     ` : '\n     ';
  const safeMsg = msg.replace(/\n/g, continuationPrefix);
  return `${prefixed}[${cat}] ${safeMsg}`;
}

export async function createStagehand(opts: CreateStagehandOpts): Promise<StagehandHandle> {
  // V3Options accepts `model: ModelConfiguration` where ModelConfiguration is
  // `AvailableModel | (ClientOptions & { modelName: AvailableModel })`.
  // For OpenAI, ClientOptions accepts apiKey; we pass it through there.
  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: opts.apiKey,
    projectId: opts.projectId,
    browserbaseSessionID: opts.sessionId,
    // Required for custom tools / MCP integrations on the agent path.
    experimental: true,
    model: {
      modelName: opts.modelName,
      apiKey: opts.modelApiKey,
    } as never, // ModelConfiguration's ClientOptions union doesn't expose apiKey on the public type but is present at runtime
    verbose: 1,
    // Disable Stagehand's separate pino backend so noisy DEBUG lines don't
    // bypass our logger filter and clutter stderr.
    disablePino: true,
    logger: (line: LogLine) => {
      if (!shouldLog(line)) return;
      process.stderr.write(formatLogLine(line, opts.logPrefix) + '\n');
    },
  });

  await stagehand.init();

  return {
    stagehand,
    async page(): Promise<Page> {
      let p = stagehand.context.activePage();
      if (!p) p = await stagehand.context.newPage();
      return p as unknown as Page;
    },
    async close(): Promise<void> {
      // Capped at 15s: if Stagehand's underlying CDP transport is broken
      // (e.g. the wallclock timer just torched the BB session mid-step),
      // stagehand.close() can hang. A hung close in finalize blocks the
      // whole runMissions Promise.all.
      try {
        await Promise.race([
          stagehand.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('stagehand.close timed out after 15s')), 15_000),
          ),
        ]);
      } catch {
        // Best-effort.
      }
    },
  };
}

export type { LogLine };
