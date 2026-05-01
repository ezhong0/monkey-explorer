// Dispatch on AuthMode discriminator. Each mode gets its own module;
// this just routes.

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
  email: string | undefined;
  password: string | undefined;
  liveViewUrl: string;
  configDir: string;
  signal: AbortSignal;
}): Promise<void> {
  switch (opts.authMode.kind) {
    case 'none':
      return noneSignIn();
    case 'ai-form': {
      if (!opts.email || !opts.password) {
        throw new Error(
          'ai-form auth mode requires TEST_EMAIL and TEST_PASSWORD in .env.local. Run `monkey configure`.',
        );
      }
      return aiFormSignIn({
        stagehand: opts.stagehand,
        page: opts.page,
        signInUrl: opts.authMode.signInUrl,
        email: opts.email,
        password: opts.password,
        signal: opts.signal,
      });
    }
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
        email: opts.email,
        password: opts.password,
        configDir: opts.configDir,
        customSignInPath: opts.authMode.path,
        signal: opts.signal,
      });
    default: {
      const _: never = opts.authMode;
      void _;
      throw new Error(`Unhandled AuthMode`);
    }
  }
}
