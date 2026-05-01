// Browserbase project listing — used by init for auto-discovery.
// Single project → auto-pick. Multiple projects → caller renders a picker.

import type { Browserbase } from './client.js';

export interface BBProject {
  id: string;
  name: string;
}

export async function listProjects(bb: Browserbase): Promise<BBProject[]> {
  const projects = await bb.projects.list();
  return projects.map((p) => ({ id: p.id, name: p.name }));
}
