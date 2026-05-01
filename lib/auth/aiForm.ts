// "ai-form" auth mode — Stagehand `act()`-driven form fill. Works for
// the majority of password-form apps (including Clerk's two-step flow)
// without per-app configuration.
//
// If form-fill repeatedly fails for an app, the user falls back to
// `custom` auth mode (their own JS file).

import type { Page } from 'playwright-core';
import type { Stagehand } from '@browserbasehq/stagehand';
import { aiSignIn } from '../stagehand/actSignIn.js';

export async function aiFormSignIn(opts: {
  stagehand: Stagehand;
  page: Page;
  signInUrl: string;
  email: string;
  password: string;
  signal: AbortSignal;
}): Promise<void> {
  if (opts.signal.aborted) return;
  await aiSignIn({
    stagehand: opts.stagehand,
    page: opts.page,
    signInUrl: opts.signInUrl,
    email: opts.email,
    password: opts.password,
  });
}
