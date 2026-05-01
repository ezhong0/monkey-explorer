// Domain predicates for global state. Named so callsites read declaratively
// and so logic doesn't drift between callsites.

import type { GlobalState, Target } from './schema.js';

export function targetExists(state: GlobalState, name: string): boolean {
  return name in state.targets;
}

export function targetIsBootstrapped(target: Target): boolean {
  return target.contextId.length > 0;
}

export function hasGlobalCredentials(state: GlobalState | null): boolean {
  return state?.credentials != null;
}

/**
 * Resolve which target a command should run against. `--target <name>` wins;
 * otherwise the `currentTarget`. Throws if neither resolves to a known target.
 */
export function resolveTarget(
  state: GlobalState,
  flagTarget: string | undefined,
): { name: string; target: Target } {
  const name = flagTarget ?? state.currentTarget;
  if (!name) {
    throw new Error(
      'No target specified and no current target set.\n' +
        '  Run `monkey target use <name>` to pick one, or pass `--target <name>`.\n' +
        '  Or `monkey target list` to see available targets.',
    );
  }
  const target = state.targets[name];
  if (!target) {
    const available = Object.keys(state.targets);
    const list = available.length ? available.join(', ') : '(none — run `monkey target add <name>`)';
    throw new Error(`Target "${name}" not found. Available: ${list}`);
  }
  return { name, target };
}
