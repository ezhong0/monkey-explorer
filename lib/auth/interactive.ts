// "interactive" auth mode — for any flow that needs a human (magic link,
// OAuth, SSO, MFA). Print Browserbase live-view URL; user signs in
// manually; we poll for sign-in confirmation via the marker check.
//
// Tries to auto-open the URL via macOS `open` / Linux `xdg-open`;
// falls through to print-only if neither is available.

import type { Page } from 'playwright-core';
import type { Stagehand } from '@browserbasehq/stagehand';
import { spawn } from 'node:child_process';
import { isSignedIn } from '../probe/markerDetect.js';
import * as log from '../log/stderr.js';

const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 min

function tryOpenInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // No `open`/`xdg-open` available; user will copy-paste from terminal
  }
}

export async function interactiveSignIn(opts: {
  page: Page;
  stagehand: Stagehand;
  signInUrl: string;
  liveViewUrl: string;
  signal: AbortSignal;
}): Promise<void> {
  if (opts.signal.aborted) return;

  await opts.page.goto(opts.signInUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

  log.blank();
  log.step('Interactive sign-in required.');
  log.info('  Open this URL in your browser to sign in:');
  log.info(`  ${opts.liveViewUrl}`);
  log.info('');
  log.info('  monkey will poll every 3s and continue once you are signed in.');
  log.info('  (Times out after 5 minutes.)');
  log.blank();

  tryOpenInBrowser(opts.liveViewUrl);

  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    if (opts.signal.aborted) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const result = await isSignedIn({ page: opts.page, stagehand: opts.stagehand }).catch(
      () => 'unknown' as const,
    );
    if (result === true) {
      log.ok('Signed in.');
      return;
    }
  }
  throw new Error(`Interactive sign-in timed out after ${TIMEOUT_MS / 1000}s`);
}
