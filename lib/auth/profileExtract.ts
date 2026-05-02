// Silent cookie refresh from the persistent Chrome profile.
//
// `monkey auth` writes cookies to a profile dir at
// ~/.config/monkey-explorer/chrome-profile/. Subsequent runs can pull
// fresh cookies from there without re-prompting the user, as long as:
//   - the profile exists (user has run `monkey auth` for any target)
//   - Chrome isn't currently running with the same profile (lock conflict)
//   - the auth provider's refresh token is still valid (Clerk: ~7 days,
//     longer with rotation; refreshed every visit)
//
// Headless launch + navigate + storageState. ~3-5s overhead. The visit
// triggers Clerk's frontend to refresh the JWT via its refresh-token
// cookie, so we capture genuinely fresh cookies, not whatever was last
// persisted to disk.

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import type { StorageState } from '../state/schema.js';
import { waitForAuthSettled } from '../probe/markerDetect.js';

const NAVIGATION_TIMEOUT_MS = 15_000;

const SIGN_IN_PATH_RE = /\/sign-?in|\/login|\/auth/i;

export class ProfileExtractError extends Error {
  constructor(message: string, public readonly kind: 'no_profile' | 'profile_locked' | 'stale' | 'other') {
    super(message);
    this.name = 'ProfileExtractError';
  }
}

/**
 * Silently launch headless Chrome against the persistent profile and capture
 * fresh storageState for the target URL. Throws ProfileExtractError on
 * failure with a kind discriminator so callers can fall back appropriately.
 *
 * Returns the full storageState (cookies + origins) — caller filters to
 * target eTLD+1 before injecting into BB.
 */
export async function silentProfileExtract(opts: {
  profileDir: string;
  targetUrl: string;
}): Promise<StorageState> {
  if (!existsSync(opts.profileDir)) {
    throw new ProfileExtractError(
      `No persistent Chrome profile at ${opts.profileDir}. Run \`monkey auth <name>\` to create one.`,
      'no_profile',
    );
  }

  let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  try {
    browser = await chromium.launchPersistentContext(opts.profileDir, {
      headless: true,
      channel: 'chrome',
      viewport: { width: 1280, height: 800 },
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (/profile.*in use|SingletonLock/i.test(msg)) {
      throw new ProfileExtractError(
        `Chrome profile is locked (close your Chrome browser, or run with --reset).`,
        'profile_locked',
      );
    }
    throw new ProfileExtractError(`Failed to launch headless Chrome: ${msg}`, 'other');
  }

  try {
    const page = browser.pages()[0] ?? (await browser.newPage());
    try {
      await page.goto(opts.targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch (err) {
      throw new ProfileExtractError(
        `Headless navigation to ${opts.targetUrl} failed: ${(err as Error).message}`,
        'other',
      );
    }

    // Give the auth provider's frontend SDK time to use the refresh token
    // and mint a new JWT (Clerk does this client-side after navigation).
    await waitForAuthSettled(page);

    // If the URL is still on a sign-in path after settling, profile cookies
    // are too stale (refresh token expired, app revoked the session, etc.).
    if (SIGN_IN_PATH_RE.test(page.url())) {
      throw new ProfileExtractError(
        `Profile cookies appear stale: post-navigation URL is still on a sign-in path (${page.url()}).`,
        'stale',
      );
    }

    return (await browser.storageState()) as StorageState;
  } finally {
    await browser.close().catch(() => {});
  }
}
