// .last-target file — gitignored, persists last-used target URL as the
// prompt default for "Target URL" when none is passed via --target.
//
// Atomic write to handle the race between two parallel monkey invocations
// from the same shell.

import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = '.last-target';

export async function readLastTarget(dir: string): Promise<string | null> {
  const p = join(dir, FILE);
  if (!existsSync(p)) return null;
  const text = (await readFile(p, 'utf-8')).trim();
  return text || null;
}

export async function writeLastTarget(dir: string, url: string): Promise<void> {
  const p = join(dir, FILE);
  const tmp = `${p}.tmp`;
  await writeFile(tmp, url + '\n');
  await rename(tmp, p);
}
