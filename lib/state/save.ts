// Atomic write of the global state file. Whole-file rewrite via .tmp + rename.
// Mode 0600 enforced because the file holds live API keys.
//
// Cross-process locking: parallel monkey invocations can race on read-modify-
// write of the same config file (load → mutate → save), losing updates.
// `proper-lockfile` provides a `.lock` sentinel directory with stale-lock
// detection. Fix landed 2026-05-01 after the audit flagged a lost-update
// race that could clobber `contextId` (critical for auth survival).

import { mkdir, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import { getBaseDir, getConfigPath } from './path.js';
import { GlobalStateSchema, type GlobalState } from './schema.js';

const LOCK_OPTS = {
  // Treat a held lock as stale after 30s — long enough for a reasonable
  // bootstrap-auth round-trip, short enough that a crashed process doesn't
  // block the next run forever.
  stale: 30_000,
  retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
};

/** Acquire an exclusive lock on the config file for the duration of `fn`.
 *  Lock file lives at `<configPath>.lock` (managed by proper-lockfile). */
async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const path = getConfigPath();
  // proper-lockfile requires the file to exist; if it doesn't, lock the
  // parent dir instead (initial-setup race is benign — only one writer).
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const lockTarget = (await fileExists(path)) ? path : dir;
  const release = await lockfile.lock(lockTarget, LOCK_OPTS);
  try {
    return await fn();
  } finally {
    await release().catch(() => {
      // Lock may already be released if the file was renamed under us.
    });
  }
}

async function fileExists(path: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

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
 * applies the mutator, saves — all under a file lock so concurrent
 * `monkey` invocations don't lose each other's writes.
 */
export async function updateTarget(
  name: string,
  mutator: (target: import('./schema.js').Target) => import('./schema.js').Target,
): Promise<void> {
  await withConfigLock(async () => {
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
  });
}
