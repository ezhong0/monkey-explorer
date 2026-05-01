// Detect signed-in state without requiring a configured marker string.
// Heuristic first (free): URL not on sign-in path AND no visible password
// input. AI fallback: ask Stagehand `extract()` with a yes/no schema.
//
// Phase 0 finding: heuristic timeout bumped to 3000ms (was 1000ms) since
// Clerk/Auth0 render password inputs lazily ~1.5s after navigation.
//
// Q5 from open questions: if both heuristic and AI fallback fail, default
// to "treat as signed-out" — fail-safe (re-auths unnecessarily but never
// runs as wrong identity).

import type { Page } from 'playwright-core';
import type { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

const SIGN_IN_PATH_RE = /\/sign-?in|\/login|\/auth/i;

const PASSWORD_INPUT_TIMEOUT_MS = 3000;

const SignedInSchema = z.object({
  signedIn: z.boolean(),
  reasoning: z.string().optional(),
});

export async function isSignedIn(opts: {
  page: Page;
  stagehand: Stagehand;
}): Promise<boolean | 'unknown'> {
  // Heuristic: URL on sign-in path → not signed in.
  const url = opts.page.url();
  if (SIGN_IN_PATH_RE.test(url)) return false;

  // Heuristic: visible password input → not signed in (or part-way through).
  let hasPasswordInput: boolean;
  try {
    hasPasswordInput = await opts.page
      .locator('input[type="password"]')
      .first()
      .isVisible({ timeout: PASSWORD_INPUT_TIMEOUT_MS });
  } catch {
    // Timeout / locator error → ambiguous, defer to AI fallback
    return aiCheckSignedIn(opts.stagehand);
  }
  if (hasPasswordInput) return false;

  // Heuristic passed but doesn't *prove* signed-in (could be a public page).
  // Defer to AI fallback for the conclusive answer.
  return aiCheckSignedIn(opts.stagehand);
}

async function aiCheckSignedIn(stagehand: Stagehand): Promise<boolean | 'unknown'> {
  try {
    const result = await stagehand.extract(
      'Look at this page and determine if a user is currently signed in to the application. Indicators of signed-in: a user menu, account avatar, "Sign out" button, dashboard content. Indicators of not-signed-in: sign-in/login form, "Sign up" or "Sign in" buttons in navigation, marketing landing page.',
      SignedInSchema,
    );
    return result.signedIn;
  } catch {
    return 'unknown';
  }
}
