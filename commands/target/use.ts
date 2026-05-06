// `monkey target use <name>` — switch the current target.

import * as log from '../../src/log/stderr.js';
import { requireGlobalState } from '../../src/state/load.js';
import { saveGlobalState } from '../../src/state/save.js';

export async function runTargetUse(name: string): Promise<number> {
  const state = await requireGlobalState();
  if (!state.targets[name]) {
    const available = Object.keys(state.targets);
    const list = available.length ? available.join(', ') : '(none)';
    log.fail(`Target "${name}" not found. Available: ${list}`);
    return 1;
  }
  await saveGlobalState({ ...state, currentTarget: name });
  log.ok(`Current target: ${name}`);
  return 0;
}
