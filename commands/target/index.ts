// `monkey target <subcommand>` — dispatch to the right target sub-subcommand.

import * as log from '../../src/log/stderr.js';
import { runTargetAdd, type TargetAddOpts } from './add.js';
import { runTargetList } from './list.js';
import { runTargetUse } from './use.js';
import { runTargetRm } from './rm.js';
import { runTargetShow } from './show.js';

export interface TargetDispatchOpts {
  positional: string[]; // [subcommand, name?, ...rest]
  nonInteractive: boolean;
  addFlags: TargetAddOpts;
}

export async function runTargetDispatch(opts: TargetDispatchOpts): Promise<number> {
  const sub = opts.positional[0];
  const name = opts.positional[1];

  switch (sub) {
    case 'add':
      if (!name) {
        log.fail('Usage: monkey target add <name> [flags]');
        return 1;
      }
      return runTargetAdd({ ...opts.addFlags, name, nonInteractive: opts.nonInteractive });
    case 'list':
      return runTargetList();
    case 'use':
      if (!name) {
        log.fail('Usage: monkey target use <name>');
        return 1;
      }
      return runTargetUse(name);
    case 'rm':
      if (!name) {
        log.fail('Usage: monkey target rm <name>');
        return 1;
      }
      return runTargetRm(name, { nonInteractive: opts.nonInteractive });
    case 'show':
      return runTargetShow(name);
    case undefined:
      log.fail('Usage: monkey target <add|list|use|rm|show> [name]');
      return 1;
    default:
      log.fail(`Unknown target subcommand: "${sub}". Try add, list, use, rm, show.`);
      return 1;
  }
}
