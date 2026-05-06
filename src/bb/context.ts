// Browserbase context creation. The persistent cookie jar lives on BB's
// servers; the global state file holds a pointer to it (per-target.contextId).

import type { Browserbase } from './client.js';

export async function createContext(bb: Browserbase, projectId: string): Promise<string> {
  const ctx = await bb.contexts.create({ projectId });
  return ctx.id;
}
