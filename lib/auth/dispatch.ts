// Dispatch on AuthMode discriminator. Each mode gets its own module;
// this just routes.
//
// v2: testEmail/testPassword live inside AuthMode now (for ai-form they're
// required by the schema; for custom they're optional). dispatch reads them
// straight off authMode rather than from a separate Target.testCredentials
// field — the asymmetry that bit Bug #1 is gone by construction.

import type { Page } from 'playwright-core';
import type { Stagehand } from '@browserbasehq/stagehand';
import type { AuthMode } from '../state/schema.js';
import { aiFormSignIn } from './aiForm.js';
import { interactiveSignIn } from './interactive.js';
import { noneSignIn } from './none.js';
import { customSignIn } from './custom.js';

export async function dispatchSignIn(opts: {
  authMode: AuthMode;
  page: Page;
  stagehand: Stagehand;
  liveViewUrl: string;
  signal: AbortSignal;
  nonInteractive: boolean;
}): Promise<void> {
  switch (opts.authMode.kind) {
    case 'none':
      return noneSignIn();
    case 'ai-form':
      return aiFormSignIn({
        stagehand: opts.stagehand,
        page: opts.page,
        signInUrl: opts.authMode.signInUrl,
        email: opts.authMode.testEmail,
        password: opts.authMode.testPassword,
        signal: opts.signal,
      });
    case 'interactive':
      return interactiveSignIn({
        page: opts.page,
        stagehand: opts.stagehand,
        signInUrl: opts.authMode.signInUrl,
        liveViewUrl: opts.liveViewUrl,
        signal: opts.signal,
      });
    case 'custom':
      return customSignIn({
        page: opts.page,
        signInUrl: 'about:blank', // custom files supply their own
        email: opts.authMode.testEmail,
        password: opts.authMode.testPassword,
        customSignInPath: opts.authMode.path,
        signal: opts.signal,
        nonInteractive: opts.nonInteractive,
      });
    default: {
      const _: never = opts.authMode;
      void _;
      throw new Error(`Unhandled AuthMode`);
    }
  }
}
