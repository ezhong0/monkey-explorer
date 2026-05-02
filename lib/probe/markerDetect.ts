// Detect signed-in state without requiring a configured marker string.
// Heuristic first (free): URL not on sign-in path AND no visible password
// input. AI fallback: ask Stagehand `extract()` with a yes/no schema.
//
// Phase 0 finding: heuristic timeout bumped to 3000ms (was 1000ms) since
// Clerk/Auth0 render password inputs lazily ~1.5s after navigation.
//
// Auth-provider refresh race (2026-05-01): cookie-jar mode injects cookies
// whose JWTs may already have expired (Clerk uses 5-min JWTs but the
// refresh token is good for weeks). On navigation, Clerk's frontend SDK
// refreshes the JWT *after* DOMContentLoaded — so calling isSignedIn too
// eagerly observes the pre-refresh state. Mitigation:
//   - callers should `waitForAuthSettled(page)` after page.goto
//   - this function retries once on negative result with a short delay
//
// Q5 from open questions: if both heuristic and AI fallback fail, default
// to "treat as signed-out" — fail-safe (re-auths unnecessarily but never
// runs as wrong identity).

import type { Page } from 'playwright-core';
import type { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

const SIGN_IN_PATH_RE = /\/sign-?in|\/login|\/auth/i;

const PASSWORD_INPUT_TIMEOUT_MS = 3000;
// Wait up to 10s for the URL to leave a sign-in path. Replaces the older
// `networkidle` wait which was too eager — Clerk's submit-redirect-set-cookie
// chain can briefly idle the network mid-flight, so isSignedIn fired before
// the redirect actually happened.
const URL_TRANSITION_TIMEOUT_MS = 10_000;
// 2500ms (was 1500ms): Clerk's frontend refresh dance is sometimes slower
// than networkidle suggests (background polling can fire before refresh
// settles). The longer delay catches the residual race at the cost of
// 1s more latency on negative outcomes only.
const RETRY_ON_NEGATIVE_DELAY_MS = 2500;

const SignedInSchema = z.object({
  signedIn: z.boolean(),
  reasoning: z.string().optional(),
});

/** Wait for the post-sign-in URL transition. Returns when the page's URL
 *  is no longer on a sign-in path, or after URL_TRANSITION_TIMEOUT_MS.
 *
 *  This is the right signal for "auth completed" — networkidle was too
 *  eager (Clerk's submit→redirect→set-cookie chain can briefly idle the
 *  network mid-flight) and DOM heuristics are slow + probabilistic. Url
 *  transition is the framework-built-in signal: `page.waitForURL` returns
 *  immediately if the predicate already matches (cookie-jar happy path)
 *  and waits for the actual navigation otherwise (password submit path). */
export async function waitForAuthSettled(page: Page): Promise<void> {
  try {
    await page.waitForURL((url) => !SIGN_IN_PATH_RE.test(url.toString()), {
      timeout: URL_TRANSITION_TIMEOUT_MS,
    });
  } catch {
    // Timeout: URL never left the sign-in path. The downstream isSignedIn
    // check / health check will report the failure. Don't throw here —
    // bootstrap-auth's caller decides what to do with a not-signed-in state.
  }
}

export async function isSignedIn(opts: {
  page: Page;
  stagehand: Stagehand;
}): Promise<boolean | 'unknown'> {
  const first = await checkSignedInOnce(opts);
  if (first === true) return true;

  // Negative on first attempt — could be a transient pre-refresh state.
  // One retry after a short delay catches the auth-provider refresh race
  // without doubling the latency for happy-path checks.
  await new Promise((r) => setTimeout(r, RETRY_ON_NEGATIVE_DELAY_MS));
  return checkSignedInOnce(opts);
}

async function checkSignedInOnce(opts: {
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
