// SIGINT handler — owns the root AbortController. Subcommands register
// cleanup callbacks; SIGINT fires them in parallel before exiting 130.

import * as log from '../log/stderr.js';

let installed = false;
const rootController = new AbortController();
const cleanups: Array<() => Promise<void>> = [];

export function getRootSignal(): AbortSignal {
  return rootController.signal;
}

export function registerCleanup(fn: () => Promise<void>): void {
  cleanups.push(fn);
}

export function installSigintHandler(): void {
  if (installed) return;
  installed = true;
  process.on('SIGINT', async () => {
    log.fail('Aborting…');
    rootController.abort();
    await Promise.all(cleanups.map((fn) => fn().catch(() => {})));
    process.exit(130);
  });
}
