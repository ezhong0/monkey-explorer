// `monkey current` — print the current target name + URL + auth mode in
// one line. Quick state inspection, like `kubectl config current-context`
// or `aws sts get-caller-identity`.

import * as out from '../lib/log/stdout.js';
import * as log from '../lib/log/stderr.js';
import { requireGlobalState } from '../lib/state/load.js';

export async function runCurrent(): Promise<number> {
  const state = await requireGlobalState();
  const name = state.currentTarget;
  if (!name) {
    log.fail('No current target set.');
    log.info('  Run `monkey target list` to see available targets, then `monkey target use <name>`.');
    return 1;
  }
  const target = state.targets[name];
  if (!target) {
    log.fail(`currentTarget "${name}" references a target that no longer exists.`);
    log.info('  Run `monkey target use <name>` to pick a valid one.');
    return 1;
  }
  const ctx = target.contextId ? 'bootstrapped' : 'not bootstrapped';
  out.out(`${name}  ${target.url}  ${target.authMode.kind}  ${ctx}`);
  return 0;
}
