// "password" auth mode — Stagehand `act()`-driven form fill.
//
// Works for the majority of password-form apps (Clerk two-step flow,
// Auth0, plain HTML forms). The AI act() call adapts to whatever shape
// the sign-in form takes without per-app configuration.
//
// If form-fill repeatedly fails for a specific app, fall back to
// `cookie-jar` mode (export storageState from your real Chrome).

import type { Page } from 'playwright-core';
import type { Stagehand } from '@browserbasehq/stagehand';
import { aiSignIn } from '../stagehand/actSignIn.js';

export async function passwordSignIn(opts: {
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
