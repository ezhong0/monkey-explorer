// `monkey target rm <name>` — delete a target. Confirms first.
//
// Does NOT delete the BB context on Browserbase's side (contexts auto-expire).
// Reports for this target are kept on disk under reports/<target>/ — user can
// delete manually if desired.

import { confirm } from '../../../prompts/index.js';
import * as log from '../../../log/stderr.js';
import { requireGlobalState } from '../../../state/load.js';
import { saveGlobalState } from '../../../state/save.js';

export async function runTargetRm(
  name: string,
  opts: { nonInteractive: boolean },
): Promise<number> {
  const state = await requireGlobalState();
  if (!state.targets[name]) {
    log.fail(`Target "${name}" not found.`);
    return 1;
  }

  if (opts.nonInteractive) {
    // Skip confirmation — non-interactive users explicitly opted in.
    log.info(`--non-interactive: removing "${name}" without confirmation.`);
  } else {
    const proceed = await confirm({
      message: `Remove target "${name}"? (Reports under reports/${name}/ are kept; BB context will auto-expire.)`,
      default: false,
    });
    if (!proceed) {
      log.info('Cancelled.');
      return 0;
    }
  }

  const { [name]: _removed, ...rest } = state.targets;
  void _removed;
  const currentTarget = state.currentTarget === name ? undefined : state.currentTarget;

  await saveGlobalState({ ...state, targets: rest, currentTarget });
  log.ok(`Removed "${name}".`);
  if (state.currentTarget === name) {
    log.warn('That was the current target. Set a new one with `monkey target use <name>`.');
  }
  return 0;
}
