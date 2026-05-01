// Pre-flight probe: navigate to target URL, classify the result.
//
// Returns a discriminated ProbeResult. Caller (runMission) decides what
// to do — auto-reauth on `sign-in-page`, surface error otherwise.

import type { Page } from 'playwright-core';
import type { Stagehand } from '@browserbasehq/stagehand';
import { isSignedIn } from './markerDetect.js';
import type { ProbeResult } from '../types.js';

export async function probe(opts: {
  page: Page;
  stagehand: Stagehand;
  target: string;
  /** When 'none', skips the auth marker check — there's no auth to verify. */
  authModeKind?: string;
}): Promise<ProbeResult> {
  // Stage 1: HTTP reachability via fetch (fast, no browser overhead).
  try {
    const res = await fetch(opts.target, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 || res.status >= 500) {
      return { kind: 'unreachable', details: `HTTP ${res.status}` };
    }
  } catch (e) {
    return { kind: 'unreachable', details: `network: ${(e as Error).message}` };
  }

  // Stage 2: navigate the actual session.
  try {
    await opts.page.goto(opts.target, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  } catch (e) {
    return { kind: 'unknown', details: `navigation failed: ${(e as Error).message}` };
  }

  // Stage 3: auth state — skipped for auth-mode=none targets (no auth to check).
  if (opts.authModeKind === 'none') return { kind: 'ok' };

  const signedIn = await isSignedIn({ page: opts.page, stagehand: opts.stagehand });

  if (signedIn === true) return { kind: 'ok' };

  // signedIn === false → sign-in-page (cookie expired)
  // signedIn === 'unknown' → fail-safe: treat as needing auth (will trigger
  // auto-reauth which either fixes it or surfaces a clear error)
  if (signedIn === false) return { kind: 'sign-in-page' };
  return { kind: 'unknown', details: 'auth state could not be determined; assuming signed-out' };
}
