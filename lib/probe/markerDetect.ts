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
const SETTLE_NETWORK_IDLE_TIMEOUT_MS = 5000;
// 2500ms (was 1500ms): Clerk's frontend refresh dance is sometimes slower
// than networkidle suggests (background polling can fire before refresh
// settles). The longer delay catches the residual race at the cost of
// 1s more latency on negative outcomes only.
const RETRY_ON_NEGATIVE_DELAY_MS = 2500;

const SignedInSchema = z.object({
  signedIn: z.boolean(),
  reasoning: z.string().optional(),
});

/** After page.goto(), wait for the network to settle so any auth-provider
 *  refresh dance (Clerk, Auth0) has time to complete before isSignedIn is
 *  called. Capped because some apps have constant background polling that
 *  would otherwise prevent networkidle from ever firing. */
export async function waitForAuthSettled(page: Page): Promise<void> {
  await page
    .waitForLoadState('networkidle', { timeout: SETTLE_NETWORK_IDLE_TIMEOUT_MS })
    .catch(() => {
      // Idle never reached within the budget — fine, we tried. Continue.
    });
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
