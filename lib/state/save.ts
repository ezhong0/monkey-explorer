// Atomic write of the global state file. Whole-file rewrite via .tmp + rename.
// Mode 0600 enforced because the file holds live API keys.

import { mkdir, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getBaseDir, getConfigPath } from './path.js';
import { GlobalStateSchema, type GlobalState } from './schema.js';

export async function saveGlobalState(state: GlobalState): Promise<void> {
  // Validate before writing — schema bugs catch here, not at next read.
  const validated = GlobalStateSchema.parse(state);

  const path = getConfigPath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const tmp = `${path}.tmp`;
  const json = JSON.stringify(validated, null, 2) + '\n';

  try {
    await writeFile(tmp, json);
    // Set 0600 BEFORE rename so the final file is never readable by others
    // even briefly. On platforms where chmod is a no-op (Windows), this is
    // best-effort.
    try {
      await chmod(tmp, 0o600);
    } catch {
      // Best-effort.
    }
    await rename(tmp, path);
  } catch (err) {
    // Clean up tmp if rename failed.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Make sure the base dir exists (no state file yet). */
export async function ensureBaseDir(): Promise<void> {
  await mkdir(getBaseDir(), { recursive: true });
}

/**
 * Read-modify-write helper for updating a single target's fields. Loads,
 * applies the mutator, saves. NOT lock-protected — last write wins on
 * concurrent updates per the design's concurrency semantics (see
 * design-monkey-global-state-2026-04-30.md).
 */
export async function updateTarget(
  name: string,
  mutator: (target: import('./schema.js').Target) => import('./schema.js').Target,
): Promise<void> {
  const { loadGlobalState } = await import('./load.js');
  const state = await loadGlobalState();
  if (!state) {
    throw new Error('Cannot updateTarget: no global state.');
  }
  const target = state.targets[name];
  if (!target) {
    throw new Error(`Cannot updateTarget: target "${name}" not found.`);
  }
  const updated = mutator(target);
  await saveGlobalState({
    ...state,
    targets: { ...state.targets, [name]: updated },
  });
}
