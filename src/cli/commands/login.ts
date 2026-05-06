// `monkey login` — set or update global credentials (BB key + at least one
// of OpenAI/Anthropic). Per-machine. Mode 0600.
//
// Two flows:
//
//  - Interactive: prompts for each field, with current values as defaults if
//    state already exists (key rotation flow). OpenAI and Anthropic are both
//    optional individually; at least one must be provided.
//  - Non-interactive: --browserbase-key required, plus at least one of
//    --openai-key / --anthropic-key. --bb-project picks an explicit BB
//    project ID; if absent, we auto-discover (single project) or error
//    (multiple, ambiguous in non-interactive mode).
//
// Run-time enforces that the configured (stagehandModel, agentModel,
// adjudicatorModel) all have a matching key — see lib/stagehand/modelKey.ts
// and the preflight in commands/run.ts.
//
// "Fully succeed or fully fail": partial flags do NOT fall back to prompts.

import { input, password, select } from '../../prompts/index.js';
import * as log from '../../log/stderr.js';
import { createClient } from '../../bb/client.js';
import { listProjects } from '../../bb/projects.js';
import { loadGlobalState } from '../../state/load.js';
import { saveGlobalState } from '../../state/save.js';
import { getConfigPath } from '../../state/path.js';
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_DEFAULTS,
  type Credentials,
  type GlobalState,
} from '../../state/schema.js';

export interface LoginOpts {
  // Flags. When all required are present, prompts are skipped.
  browserbaseKey?: string;
  openaiKey?: string;
  bbProject?: string;
  anthropicKey?: string;
  /** When set, error rather than prompt if non-flag fields are missing. */
  nonInteractive?: boolean;
}

export async function runLogin(opts: LoginOpts): Promise<number> {
  const existing = await loadGlobalState();
  const existingCreds = existing?.credentials;

  // Required for non-interactive: --browserbase-key + at least one of
  // --openai-key/--anthropic-key.
  const hasFlagDriven = !!(opts.browserbaseKey && (opts.openaiKey || opts.anthropicKey));

  let bbKey: string;
  let openaiKey: string | undefined;
  let bbProjectId: string;
  let anthropicKey: string | undefined;

  if (hasFlagDriven) {
    // Non-interactive path: validate flags, no prompts.
    bbKey = opts.browserbaseKey!;
    if (!bbKey.startsWith('bb_')) {
      log.fail('--browserbase-key must start with "bb_".');
      return 1;
    }
    if (opts.openaiKey && !opts.openaiKey.startsWith('sk-')) {
      log.fail('--openai-key must start with "sk-".');
      return 1;
    }
    openaiKey = opts.openaiKey || undefined;

    // Validate BB key.
    let bbProjects: Awaited<ReturnType<typeof listProjects>>;
    try {
      const bb = createClient(bbKey);
      bbProjects = await listProjects(bb);
    } catch (err) {
      log.fail(`Browserbase API key validation failed: ${(err as Error).message}`);
      return 1;
    }

    if (opts.bbProject) {
      // Explicit project — verify it exists for this key.
      const found = bbProjects.find((p) => p.id === opts.bbProject);
      if (!found) {
        log.fail(`--bb-project "${opts.bbProject}" not found for this BB key.`);
        log.info(`  Available: ${bbProjects.map((p) => `${p.id} (${p.name})`).join(', ')}`);
        return 1;
      }
      bbProjectId = found.id;
    } else if (bbProjects.length === 1) {
      bbProjectId = bbProjects[0].id;
    } else if (bbProjects.length === 0) {
      log.fail('No Browserbase projects found for this API key.');
      return 1;
    } else {
      log.fail(
        `Multiple Browserbase projects found (${bbProjects.length}); ` +
          `pass --bb-project <id> in non-interactive mode.`,
      );
      log.info(`  Available: ${bbProjects.map((p) => `${p.id} (${p.name})`).join(', ')}`);
      return 1;
    }

    // Validate OpenAI key if provided.
    if (openaiKey) {
      try {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${openaiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          log.fail(`OpenAI API key validation failed: HTTP ${res.status}`);
          return 1;
        }
      } catch (err) {
        log.fail(`OpenAI API key validation failed: ${(err as Error).message}`);
        return 1;
      }
    }

    anthropicKey = opts.anthropicKey || undefined;
  } else {
    // Interactive path. Partial-flags rule: if any flag was passed but BB key
    // is missing, OR neither LLM key was provided, error rather than prompt.
    const partialFlagsProvided = !!(
      opts.browserbaseKey ||
      opts.openaiKey ||
      opts.bbProject ||
      opts.anthropicKey
    );
    if (partialFlagsProvided) {
      log.fail('Partial flags provided. Either pass all required flags or none.');
      log.info('  Required for non-interactive: --browserbase-key + at least one of --openai-key/--anthropic-key.');
      log.info('  Optional: --bb-project.');
      return 1;
    }
    if (opts.nonInteractive) {
      log.fail('--non-interactive set but no credential flags provided.');
      log.info('  Required: --browserbase-key + at least one of --openai-key/--anthropic-key.');
      return 1;
    }

    log.step(existingCreds ? 'Updating credentials.' : 'Setting up credentials.');
    log.blank();

    bbKey = await password({
      message: 'Browserbase API key:',
      mask: '*',
      validate: (v) => (v.startsWith('bb_') ? true : 'Expected key to start with bb_'),
    });

    let bbProjects: Awaited<ReturnType<typeof listProjects>>;
    try {
      const bb = createClient(bbKey);
      bbProjects = await listProjects(bb);
    } catch (err) {
      log.fail(`Browserbase API key validation failed: ${(err as Error).message}`);
      return 1;
    }

    if (bbProjects.length === 0) {
      log.fail('No Browserbase projects found for this API key.');
      return 1;
    } else if (bbProjects.length === 1) {
      bbProjectId = bbProjects[0].id;
      log.ok(`Found project "${bbProjects[0].name}" — using it.`);
    } else {
      bbProjectId = await select({
        message: 'Multiple Browserbase projects found. Which to use?',
        choices: bbProjects.map((p) => ({ name: p.name, value: p.id })),
        default: existingCreds?.browserbaseProjectId,
      });
    }

    log.blank();
    log.info('At least one LLM key is required (OpenAI and/or Anthropic). Leave blank to skip either.');

    const openaiInput = await input({
      message: 'OpenAI API key (leave blank if Anthropic-only):',
      default: existingCreds?.openaiApiKey,
    });
    openaiKey = openaiInput?.trim() || undefined;
    if (openaiKey && !openaiKey.startsWith('sk-')) {
      log.fail('OpenAI API key must start with "sk-".');
      return 1;
    }
    if (openaiKey) {
      try {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${openaiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          log.fail(`OpenAI API key validation failed: HTTP ${res.status}`);
          return 1;
        }
      } catch (err) {
        log.fail(`OpenAI API key validation failed: ${(err as Error).message}`);
        return 1;
      }
    }

    const anthropicInput = await input({
      message: 'Anthropic API key (leave blank if OpenAI-only):',
      default: existingCreds?.anthropicApiKey,
    });
    anthropicKey = anthropicInput?.trim() || undefined;

    if (!openaiKey && !anthropicKey) {
      log.fail('At least one of OpenAI or Anthropic key is required.');
      return 1;
    }
  }

  // Build + save state. Preserve existing defaults + targets if present.
  const credentials: Credentials = {
    browserbaseApiKey: bbKey,
    browserbaseProjectId: bbProjectId,
    openaiApiKey: openaiKey,
    anthropicApiKey: anthropicKey,
  };

  const next: GlobalState = existing
    ? { ...existing, credentials }
    : {
        $schema_version: CURRENT_SCHEMA_VERSION,
        credentials,
        defaults: DEFAULT_DEFAULTS,
        targets: {},
      };

  await saveGlobalState(next);
  log.ok(`Wrote credentials to ${getConfigPath()}`);

  if (Object.keys(next.targets).length === 0) {
    log.blank();
    log.info('Next: `monkey target add <name>` to add an app to test.');
  }

  return 0;
}
