// Report filename generation. Disambiguates parallel-mission filenames
// with a session-id suffix.

import { join } from 'node:path';

export function reportFilename(startedAt: Date, sessionId: string): string {
  const ts = startedAt.toISOString().replace(/[:.]/g, '-');
  const suffix = sessionId.slice(0, 6);
  return `${ts}_${suffix}.md`;
}

export function reportPath(reportsDir: string, filename: string): string {
  return join(reportsDir, filename);
}

export function tmpPath(filePath: string): string {
  return `${filePath}.tmp`;
}
