// `monkey target show [<name>]` — print target details with secrets redacted.
// If <name> omitted, shows the current target.

import * as out from '../../lib/log/stdout.js';
import * as log from '../../lib/log/stderr.js';
import { requireGlobalState } from '../../lib/state/load.js';

export async function runTargetShow(name: string | undefined): Promise<number> {
  const state = await requireGlobalState();
  const resolvedName = name ?? state.currentTarget;
  if (!resolvedName) {
    log.fail('No target name given and no current target set.');
    return 1;
  }
  const target = state.targets[resolvedName];
  if (!target) {
    log.fail(`Target "${resolvedName}" not found.`);
    return 1;
  }

  out.out(`name:           ${resolvedName}${resolvedName === state.currentTarget ? ' (current)' : ''}`);
  out.out(`url:            ${target.url}`);
  out.out(`authMode:       ${target.authMode.kind}`);
  if (target.authMode.kind === 'ai-form' || target.authMode.kind === 'interactive') {
    out.out(`signInUrl:      ${target.authMode.signInUrl}`);
  }
  if (target.authMode.kind === 'custom') {
    out.out(`customPath:     ${target.authMode.path}`);
  }
  if (target.testCredentials) {
    out.out(`testEmail:      ${target.testCredentials.email}`);
    out.out(`testPassword:   ***`);
  }
  out.out(`contextId:      ${target.contextId || '(not bootstrapped)'}`);
  out.out(`lastUsed:       ${target.lastUsed || '(never)'}`);
  return 0;
}
