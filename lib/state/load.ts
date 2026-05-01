// Read-side of the global state file. Returns null if not yet provisioned.
//
// On schema-version mismatch, throws helpfully — we don't try to auto-migrate
// across major versions in v0.1.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ZodError } from 'zod';
import { getConfigPath } from './path.js';
import { GlobalStateSchema, type GlobalState, CURRENT_SCHEMA_VERSION } from './schema.js';

/**
 * Migrate a raw v1 config into v2 shape. v1 had testCredentials at Target
 * level; v2 has them inside AuthMode variants. lastSignedInAt is new; we
 * conservatively set it to empty (forces a re-bootstrap on next run).
 */
function migrateV1ToV2(raw: Record<string, unknown>): Record<string, unknown> {
  const targets = (raw.targets ?? {}) as Record<string, Record<string, unknown>>;
  const migratedTargets: Record<string, Record<string, unknown>> = {};
  for (const [name, t] of Object.entries(targets)) {
    const authMode = (t.authMode ?? {}) as Record<string, unknown>;
    const testCreds = (t.testCredentials ?? null) as { email: string; password: string } | null;
    const newAuthMode: Record<string, unknown> = { ...authMode };
    if (authMode.kind === 'ai-form' && testCreds) {
      newAuthMode.testEmail = testCreds.email;
      newAuthMode.testPassword = testCreds.password;
    } else if (authMode.kind === 'custom' && testCreds) {
      newAuthMode.testEmail = testCreds.email;
      newAuthMode.testPassword = testCreds.password;
    }
    migratedTargets[name] = {
      url: t.url,
      authMode: newAuthMode,
      contextId: t.contextId ?? '',
      lastSignedInAt: '', // unknown; force re-bootstrap to populate
      lastUsed: t.lastUsed ?? '',
    };
  }
  return {
    ...raw,
    $schema_version: 2,
    targets: migratedTargets,
  };
}

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

  // Schema version check before Zod parsing.
  const versionField = (raw as { $schema_version?: unknown }).$schema_version;
  if (typeof versionField === 'number' && versionField > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `${path} was written by a newer monkey-explorer version (schema v${versionField}). ` +
        `Upgrade monkey-explorer or remove the file and re-run \`monkey login\`.`,
    );
  }

  // v1 → v2 migration: testCredentials moved from Target into AuthMode.
  if (versionField === 1) {
    raw = migrateV1ToV2(raw as Record<string, unknown>);
    // Save the migrated state back so future loads are clean.
    const migrated = GlobalStateSchema.parse(raw);
    const { saveGlobalState } = await import('./save.js');
    await saveGlobalState(migrated);
    return migrated;
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
