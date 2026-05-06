// `monkey configure` — edit user-level defaults (models, caps).
//
// For credential rotation, use `monkey login`.
// For target-specific changes, use `monkey target add` (re-add) or
// `monkey target rm` + `monkey target add`.

import { input } from '../src/prompts/index.js';
import * as log from '../src/log/stderr.js';
import { requireGlobalState } from '../src/state/load.js';
import { saveGlobalState } from '../src/state/save.js';
import type { Defaults } from '../src/state/schema.js';

export async function runConfigure(): Promise<number> {
  const state = await requireGlobalState();

  log.step('Editing defaults. Press enter on any prompt to keep the current value.');
  log.info('  (To rotate credentials: `monkey login`. To edit a target: `monkey target add` after `rm`.)');
  log.blank();

  const stagehandModel = await input({
    message: 'Stagehand model:',
    default: state.defaults.stagehandModel,
  });
  const agentModel = await input({
    message: 'Agent model:',
    default: state.defaults.agentModel,
  });
  const wallClockMs = await input({
    message: 'Wall-clock cap per mission (ms):',
    default: String(state.defaults.caps.wallClockMs),
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? true : 'Must be a positive integer'),
  });
  const maxSteps = await input({
    message: 'Max agent steps per mission:',
    default: String(state.defaults.caps.maxSteps),
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? true : 'Must be a positive integer'),
  });
  const sessionTimeoutSec = await input({
    message: 'BB session outer cap (seconds):',
    default: String(state.defaults.caps.sessionTimeoutSec),
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? true : 'Must be a positive integer'),
  });

  const defaults: Defaults = {
    stagehandModel,
    agentModel,
    caps: {
      wallClockMs: Number(wallClockMs),
      maxSteps: Number(maxSteps),
      sessionTimeoutSec: Number(sessionTimeoutSec),
    },
  };

  await saveGlobalState({ ...state, defaults });
  log.ok('Defaults updated.');
  return 0;
}
