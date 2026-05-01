// XDG-aware path resolution for monkey-explorer's global state.
//
// Layout under the chosen base:
//   <base>/config.json          — the global state file (mode 0600)
//   <base>/reports/<target>/    — per-target run reports
//
// Base resolution: $XDG_CONFIG_HOME/monkey-explorer if set, else
// ~/.config/monkey-explorer. Matches gh, wrangler, vercel — Node CLI convention
// across macOS/Linux/Windows-with-WSL.

import { homedir } from 'node:os';
import { join } from 'node:path';

export function getBaseDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.startsWith('/')) {
    return join(xdg, 'monkey-explorer');
  }
  return join(homedir(), '.config', 'monkey-explorer');
}

export function getConfigPath(): string {
  return join(getBaseDir(), 'config.json');
}

export function getReportsBaseDir(): string {
  return join(getBaseDir(), 'reports');
}

export function getReportsDirForTarget(targetName: string): string {
  return join(getReportsBaseDir(), targetName);
}
