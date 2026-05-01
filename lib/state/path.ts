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

/**
 * Allowed target name shape: alphanumerics, underscores, hyphens. No path
 * separators, no `..`, no spaces. Tight by construction so reports paths
 * can't escape the reports base dir.
 */
export const TARGET_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidTargetName(name: string): boolean {
  return TARGET_NAME_PATTERN.test(name);
}

/**
 * Defensive: even if a malformed name slips past target/add.ts (e.g., direct
 * config edit), refuse to construct a path that could escape the base dir.
 */
export function getReportsDirForTarget(targetName: string): string {
  if (!isValidTargetName(targetName)) {
    throw new Error(
      `Invalid target name "${targetName}" — must match ${TARGET_NAME_PATTERN.source}`,
    );
  }
  return join(getReportsBaseDir(), targetName);
}
