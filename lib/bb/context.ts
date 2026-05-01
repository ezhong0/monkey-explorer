// .context-id lifecycle. Browserbase context is the persistent cookie jar;
// the local file just holds a pointer to it.

import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browserbase } from './client.js';

const FILE = '.context-id';

export async function readContextId(dir: string): Promise<string | null> {
  const p = join(dir, FILE);
  if (!existsSync(p)) return null;
  const text = (await readFile(p, 'utf-8')).trim();
  return text || null;
}

export async function writeContextId(dir: string, id: string): Promise<void> {
  const p = join(dir, FILE);
  const tmp = `${p}.tmp`;
  await writeFile(tmp, id);
  await rename(tmp, p);
}

export async function wipeContextId(dir: string): Promise<void> {
  const p = join(dir, FILE);
  await unlink(p).catch(() => {});
}

export async function createContext(bb: Browserbase, projectId: string): Promise<string> {
  const ctx = await bb.contexts.create({ projectId });
  return ctx.id;
}

export async function getOrCreateContextId(
  bb: Browserbase,
  projectId: string,
  dir: string,
): Promise<{ id: string; fresh: boolean }> {
  const existing = await readContextId(dir);
  if (existing) return { id: existing, fresh: false };
  const id = await createContext(bb, projectId);
  // Write IMMEDIATELY after creation, before any further setup that might
  // fail and leak the context.
  await writeContextId(dir, id);
  return { id, fresh: true };
}
