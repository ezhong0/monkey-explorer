// AI-driven sign-in via Stagehand's `act()` primitive.
//
// Stagehand v3 exposes `act` on the Stagehand instance (same as extract),
// not on Page (verified at runtime — Page doesn't have an `act` method).
//
// Stagehand naturally handles the multi-step "type email → click continue →
// type password → click continue" pattern (Clerk, Auth0, etc.) when given
// step-by-step direction.

import type { Stagehand } from '@browserbasehq/stagehand';
import type { Page } from 'playwright-core';

export async function aiSignIn(opts: {
  stagehand: Stagehand;
  page: Page;
  signInUrl: string;
  email: string;
  password: string;
}): Promise<void> {
  await opts.page.goto(opts.signInUrl, { waitUntil: 'domcontentloaded' });

  // Step 1: fill email
  await opts.stagehand.act(
    `Find the email or username input field and type "${opts.email}" into it.`,
  );

  // Step 2: click continue / submit (or skip if password already visible)
  await opts.stagehand.act(
    `Click the button to continue or submit (commonly labeled "Continue", "Next", or "Sign in"). If a password field is already visible on this same page, skip this step.`,
  );

  // Step 3: fill password
  await opts.stagehand.act(
    `Find the password input field and type "${opts.password}" into it.`,
  );

  // Step 4: click submit
  await opts.stagehand.act(
    `Click the button to sign in or submit the form (commonly labeled "Sign in", "Continue", or "Submit").`,
  );
}
