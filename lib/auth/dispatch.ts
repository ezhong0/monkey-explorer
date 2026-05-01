// Dispatch on AuthMode discriminator. Each mode gets its own module;
// this just routes.
//
// v3: three modes — password (was ai-form), cookie-jar, none. interactive
// and custom are retired; legacy targets fail loud at schema parse time.

import type { Page } from 'playwright-core';
import type { Stagehand } from '@browserbasehq/stagehand';
import type { AuthMode } from '../state/schema.js';
import { passwordSignIn } from './password.js';
import { noneSignIn } from './none.js';
import { cookieJarSignIn } from './cookieJar.js';

export async function dispatchSignIn(opts: {
  authMode: AuthMode;
  page: Page;
  stagehand: Stagehand;
  /** Used by cookie-jar mode to filter injected cookies to target's eTLD+1. */
  targetUrl: string;
  /** Target name — used in cookie-jar error messages for re-export hints. */
  targetName: string;
  signal: AbortSignal;
}): Promise<void> {
  switch (opts.authMode.kind) {
    case 'none':
      return noneSignIn();
    case 'password':
      return passwordSignIn({
        stagehand: opts.stagehand,
        page: opts.page,
        signInUrl: opts.authMode.signInUrl,
        email: opts.authMode.testEmail,
        password: opts.authMode.testPassword,
        signal: opts.signal,
      });
    case 'cookie-jar':
      return cookieJarSignIn({
        page: opts.page,
        stagehand: opts.stagehand,
        jarPath: opts.authMode.path,
        targetUrl: opts.targetUrl,
        targetName: opts.targetName,
        signal: opts.signal,
      });
    default: {
      const _: never = opts.authMode;
      void _;
      throw new Error(`Unhandled AuthMode`);
    }
  }
}
