// Read-side of the global state file. Returns null if not yet provisioned.
//
// On schema-version mismatch, throws helpfully — we don't try to auto-migrate
// across major versions in v0.1.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ZodError } from 'zod';
import { getConfigPath } from './path.js';
import { GlobalStateSchema, type GlobalState, CURRENT_SCHEMA_VERSION } from './schema.js';

export async function loadGlobalState(): Promise<GlobalState | null> {
  const path = getConfigPath();
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    const text = await readFile(path, 'utf-8');
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse ${path}: ${(err as Error).message}\n` +
        `If the file is corrupted, remove it and run \`monkey login\` again.`,
    );
  }

  // Schema version check before Zod parsing — gives a clearer error if a future
  // schema is being read by an older monkey.
  const versionField = (raw as { $schema_version?: unknown }).$schema_version;
  if (typeof versionField === 'number' && versionField > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `${path} was written by a newer monkey-explorer version (schema v${versionField}). ` +
        `Upgrade monkey-explorer or remove the file and re-run \`monkey login\`.`,
    );
  }

  try {
    return GlobalStateSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.errors.map((e) => `  - ${e.path.join('.')}: ${e.message}`);
      throw new Error(
        [`${path} failed schema validation:`, ...lines, '', 'Remove the file and re-run `monkey login`.'].join(
          '\n',
        ),
      );
    }
    throw err;
  }
}

/**
 * Throw if global state is missing or has no credentials. Used by every
 * command that needs to talk to BB or OpenAI.
 */
export async function requireGlobalState(): Promise<GlobalState> {
  const state = await loadGlobalState();
  if (!state) {
    throw new Error(
      `No global config found at ${getConfigPath()}.\n` +
        `Run \`monkey login\` to set up your Browserbase + OpenAI keys first.`,
    );
  }
  if (!state.credentials) {
    throw new Error(
      `Global config exists but has no credentials.\n` +
        `Run \`monkey login\` to set up your Browserbase + OpenAI keys.`,
    );
  }
  return state;
}
