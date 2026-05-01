// `monkey target list` — show all targets, with * marking current.

import * as out from '../../lib/log/stdout.js';
import * as log from '../../lib/log/stderr.js';
import { loadGlobalState } from '../../lib/state/load.js';

export async function runTargetList(): Promise<number> {
  const state = await loadGlobalState();
  if (!state) {
    log.fail('No global config yet. Run `monkey login` first.');
    return 1;
  }
  const names = Object.keys(state.targets);
  if (names.length === 0) {
    log.info('No targets configured. Run `monkey target add <name>` to add one.');
    return 0;
  }

  for (const name of names) {
    const t = state.targets[name];
    const marker = name === state.currentTarget ? '*' : ' ';
    const auth = t.authMode.kind;
    const ctx = t.contextId ? 'bootstrapped' : 'not bootstrapped';
    out.out(`${marker} ${name.padEnd(24)} ${t.url.padEnd(40)} ${auth.padEnd(11)} ${ctx}`);
  }
  return 0;
}
