// `monkey login` — set or update global credentials (BB key, OpenAI key,
// optional Anthropic key). Per-machine. Mode 0600.
//
// Two flows:
//
//  - Interactive: prompts for each field, with current values as defaults if
//    state already exists (key rotation flow).
//  - Non-interactive: all required flags present → no prompts. Required flags
//    are --browserbase-key and --openai-key. --bb-project picks an explicit
//    BB project ID; if absent, we auto-discover (single project) or error
//    (multiple, ambiguous in non-interactive mode).
//
// "Fully succeed or fully fail": partial flags do NOT fall back to prompts.
// Either the user provides everything required for non-interactive, or runs
// interactively.

import { input, password, select } from '../lib/prompts/index.js';
import * as log from '../lib/log/stderr.js';
import { createClient } from '../lib/bb/client.js';
import { listProjects } from '../lib/bb/projects.js';
import { loadGlobalState } from '../lib/state/load.js';
import { saveGlobalState } from '../lib/state/save.js';
import { getConfigPath } from '../lib/state/path.js';
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_DEFAULTS,
  type Credentials,
  type GlobalState,
} from '../lib/state/schema.js';

export interface LoginOpts {
  // Flags. When all required are present, prompts are skipped.
  browserbaseKey?: string;
  openaiKey?: string;
  bbProject?: string;
  anthropicKey?: string;
}

export async function runLogin(opts: LoginOpts): Promise<number> {
  const existing = await loadGlobalState();
  const existingCreds = existing?.credentials;

  const allRequiredFlagsPresent = !!(opts.browserbaseKey && opts.openaiKey);

  let bbKey: string;
  let openaiKey: string;
  let bbProjectId: string;
  let anthropicKey: string | undefined;

  if (allRequiredFlagsPresent) {
    // Non-interactive path: validate flags, no prompts.
    bbKey = opts.browserbaseKey!;
    if (!bbKey.startsWith('bb_')) {
      log.fail('--browserbase-key must start with "bb_".');
      return 1;
    }
    openaiKey = opts.openaiKey!;
    if (!openaiKey.startsWith('sk-')) {
      log.fail('--openai-key must start with "sk-".');
      return 1;
    }

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

    // Validate OpenAI key.
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

    anthropicKey = opts.anthropicKey || undefined;
  } else {
    // Interactive path. If any flag is provided but not all required, that's
    // a partial-flags error per the "fully succeed or fully fail" rule.
    const partialFlagsProvided = !!(
      opts.browserbaseKey ||
      opts.openaiKey ||
      opts.bbProject ||
      opts.anthropicKey
    );
    if (partialFlagsProvided) {
      log.fail('Partial flags provided. Either pass all required flags or none.');
      log.info('  Required for non-interactive: --browserbase-key, --openai-key.');
      log.info('  Optional: --bb-project, --anthropic-key.');
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

    openaiKey = await password({
      message: 'OpenAI API key:',
      mask: '*',
      validate: (v) => (v.startsWith('sk-') ? true : 'Expected key to start with sk-'),
    });

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

    anthropicKey = await input({
      message: 'Anthropic API key (optional, leave blank to skip):',
      default: existingCreds?.anthropicApiKey,
    });
    anthropicKey = anthropicKey?.trim() || undefined;
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
