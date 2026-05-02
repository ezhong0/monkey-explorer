// "cookie-jar" auth mode — capture a Playwright storageState (cookies + per-
// origin localStorage), inject it into the BB context via CDP, and navigate
// the BB session so the post-check probe sees a signed-in page.
//
// Two sources for the storageState, tried in order:
//   1. Silent extract from the user's persistent local Chrome profile
//      (~/.config/monkey-explorer/chrome-profile/). Headless launch +
//      navigate triggers Clerk's frontend to refresh the JWT, so we capture
//      genuinely fresh cookies. Zero UI; ~3-5s overhead per run.
//   2. Jar JSON file fallback (last-known-good captured by `monkey auth`'s
//      visible ceremony). Used when the profile is locked, missing, or
//      cookies are too stale for headless refresh.
//
// If both fail, the caller's post-check (URL still on sign-in) reports
// the failure and tells the user to run `monkey auth <name>` interactively.
//
// Security: cookies are filtered to the target's eTLD+1 (plus a small
// allow-list of auth-provider domains: clerk.accounts.dev, vercel.live,
// accounts.google.com, auth0.com, okta.com) to avoid leaking unrelated
// session credentials.

import { existsSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ZodError } from 'zod';
import type { Stagehand } from '@browserbasehq/stagehand';
import type { Page } from 'playwright-core';
import {
  StorageStateSchema,
  type StorageState,
  type StorageStateCookie,
} from '../state/schema.js';
import { getChromeProfileDir } from '../state/path.js';
import { silentProfileExtract, ProfileExtractError } from './profileExtract.js';
import * as log from '../log/stderr.js';

export class CookieJarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CookieJarError';
  }
}

export interface CookieJarSignInOpts {
  page: Page;
  stagehand: Stagehand;
  jarPath: string;
  /** The target's URL — used to filter cookies to the matching eTLD+1. */
  targetUrl: string;
  /** Target name — used in error messages so the re-export hint is copyable. */
  targetName: string;
  signal: AbortSignal;
}

export async function cookieJarSignIn(opts: CookieJarSignInOpts): Promise<void> {
  // Try silent refresh from the persistent Chrome profile first. If it
  // succeeds, write the result to the jar file (so the file stays useful
  // as a fallback) and use the fresh cookies. If it fails — profile locked,
  // missing, or stale — fall back to whatever's in the jar file.
  let jar: StorageState;
  try {
    log.step('Refreshing cookies from local Chrome profile…');
    const fresh = await silentProfileExtract({
      profileDir: getChromeProfileDir(opts.targetName),
      targetUrl: opts.targetUrl,
    });
    log.ok(`Captured ${fresh.cookies.length} cookies from profile (fresh JWT).`);
    // Persist as new last-known-good for the next-run jar fallback.
    await writeJar(opts.jarPath, fresh).catch((err) => {
      log.warn(`  Could not write jar to ${opts.jarPath}: ${(err as Error).message}`);
    });
    jar = fresh;
  } catch (err) {
    if (err instanceof ProfileExtractError) {
      log.info(`  Silent refresh skipped (${err.kind}); using jar file.`);
    } else {
      log.warn(`  Silent refresh errored: ${(err as Error).message}; using jar file.`);
    }
    jar = await loadAndValidate(opts.jarPath, opts.targetName);
  }

  // Pre-flight: are ALL cookies expired? Cheap to check before spending
  // BB session time.
  const liveCookies = jar.cookies.filter(isLive);
  if (liveCookies.length === 0) {
    const latestExpiry = Math.max(...jar.cookies.map((c) => c.expires));
    const latestDate =
      latestExpiry > 0
        ? new Date(latestExpiry * 1000).toISOString().slice(0, 10)
        : 'all were session-only (no persisted cookies in jar)';
    throw new CookieJarError(
      `All ${jar.cookies.length} cookies in ${opts.jarPath} are expired (latest: ${latestDate}).\n` +
        `  Refresh with:\n` +
        `    monkey export-cookies ${opts.targetName}`,
    );
  }

  // Warn if cookies are close to expiry (< 24h left).
  const closeToExpiry = liveCookies.filter((c) => {
    if (c.expires <= 0) return false;
    const secondsLeft = c.expires - Math.floor(Date.now() / 1000);
    return secondsLeft < 24 * 60 * 60;
  });
  if (closeToExpiry.length > 0) {
    log.warn(
      `${closeToExpiry.length} of ${liveCookies.length} cookies expire within 24h. ` +
        `Consider running \`monkey export-cookies ${opts.targetName}\` soon.`,
    );
  }

  // Filter to target's eTLD+1 PLUS known auth-provider domains. Red Team
  // finding: avoid leaking unrelated session credentials into the BB context.
  // But the strict eTLD+1 filter strips Vercel preview-bypass cookies
  // (vercel.live), Clerk-hosted sessions (clerk.accounts.dev), and Google
  // OAuth state (accounts.google.com) — without those, multi-domain auth
  // (Google OAuth, Vercel previews) silently fails after the app's own
  // session JWT expires (~1h for Clerk).
  const AUTH_PROVIDER_ETLDS_PLUS_1 = [
    'clerk.accounts.dev',  // Clerk-hosted session cookies (Auth0-style provider)
    'vercel.live',         // Vercel preview-deploy bypass cookies
    'accounts.google.com', // Google OAuth state
    'auth0.com',           // Auth0-hosted sessions
    'okta.com',            // Okta-hosted sessions
  ];

  const targetHost = (() => {
    try {
      return new URL(opts.targetUrl).hostname;
    } catch {
      throw new CookieJarError(`Target URL is invalid: ${opts.targetUrl}`);
    }
  })();
  const targetEtldPlus1 = etldPlus1(targetHost);

  const allowedEtlds = new Set([targetEtldPlus1, ...AUTH_PROVIDER_ETLDS_PLUS_1]);
  const matchesAllowed = (host: string): boolean => {
    const bare = host.replace(/^\./, '');
    for (const allowed of allowedEtlds) {
      if (bare === allowed || bare.endsWith(`.${allowed}`)) return true;
    }
    return false;
  };

  const matchingCookies = liveCookies.filter((c) => matchesAllowed(c.domain));
  const matchingOrigins = jar.origins.filter((o) => {
    try {
      return matchesAllowed(new URL(o.origin).hostname);
    } catch {
      return false;
    }
  });

  log.step(
    `Loaded cookie jar: ${jar.cookies.length} cookies, ${jar.origins.length} origins`,
  );
  log.info(
    `  ${matchingCookies.length} cookies + ${matchingOrigins.length} origins match target ${targetEtldPlus1} (others filtered for security)`,
  );

  if (matchingCookies.length === 0) {
    const presentDomains = [...new Set(jar.cookies.map((c) => c.domain))].slice(0, 5);
    throw new CookieJarError(
      `No live cookies in the jar match target domain ${targetEtldPlus1}.\n` +
        `  Did you export from the right app? Jar has cookies for: ${presentDomains.join(', ')}\n` +
        `  Re-export with: monkey export-cookies ${opts.targetName}`,
    );
  }

  // Inject via CDP Storage.setCookies (browser-wide, no session attach needed).
  const cdpCookies = matchingCookies.map(toCdpCookie);
  try {
    await opts.stagehand.context.conn.send('Storage.setCookies', { cookies: cdpCookies });
  } catch (err) {
    throw new CookieJarError(
      `Failed to inject cookies via CDP Storage.setCookies: ${(err as Error).message}`,
    );
  }
  log.ok(`Injected ${cdpCookies.length} cookies into the BB context`);

  // Seed localStorage per matching origin. Each requires a navigation.
  for (const origin of matchingOrigins) {
    if (opts.signal.aborted) return;
    if (origin.localStorage.length === 0) continue;
    try {
      await opts.page.goto(origin.origin, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      // Stagehand v3 page.evaluate(fn, arg) doesn't forward the arg, so we
      // serialize the kv pairs into a string expression.
      const setStmts = origin.localStorage
        .map(
          (kv) =>
            `try { localStorage.setItem(${JSON.stringify(kv.name)}, ${JSON.stringify(kv.value)}); } catch(e) {}`,
        )
        .join('\n');
      await opts.page.evaluate(`(function(){\n${setStmts}\n})()`);
      log.info(
        `  Seeded ${origin.localStorage.length} localStorage entries for ${origin.origin}`,
      );
    } catch (err) {
      log.warn(
        `  localStorage seeding failed for ${origin.origin}: ${(err as Error).message}`,
      );
    }
  }

  // Navigate to target.url so the post-check probe in bootstrap-auth has a
  // real page to inspect. Auth-state-settle wait is owned by bootstrap-auth
  // (between dispatchSignIn and isSignedIn) — common to all auth modes.
  if (opts.signal.aborted) return;
  try {
    await opts.page.goto(opts.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    log.warn(`Navigation to ${opts.targetUrl} failed: ${(err as Error).message}`);
  }
  log.ok(`Navigated to ${opts.targetUrl}`);
}

// ─── internals ───

async function loadAndValidate(jarPath: string, targetName: string): Promise<StorageState> {
  if (!jarPath.startsWith('/')) {
    throw new CookieJarError(
      `Cookie jar path must be absolute: got ${jarPath}. (target add resolves to absolute; this should not happen in normal use.)`,
    );
  }
  if (!existsSync(jarPath)) {
    throw new CookieJarError(
      `Cookie jar not found at ${jarPath}.\n` +
        `  Run \`monkey export-cookies ${targetName}\` to create it.`,
    );
  }

  // Permission warning — cookies are session credentials.
  try {
    const st = statSync(jarPath);
    if ((st.mode & 0o077) !== 0) {
      log.warn(
        `Cookie jar at ${jarPath} is world/group-readable (mode ${(st.mode & 0o777).toString(8)}). Cookies are session credentials — recommend \`chmod 0600\`.`,
      );
    }
  } catch {
    // ignore
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(jarPath, 'utf-8'));
  } catch (err) {
    throw new CookieJarError(
      `Cookie jar JSON parse failed: ${(err as Error).message}. Re-export — the file must be valid JSON.`,
    );
  }

  let jar: StorageState;
  try {
    jar = StorageStateSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.errors.map((e) => `  - ${e.path.join('.')}: ${e.message}`);
      throw new CookieJarError(
        [
          `Cookie jar shape doesn't match Playwright storageState:`,
          ...lines,
          '',
          `Re-export using Playwright's storageState API or a compatible browser extension.`,
        ].join('\n'),
      );
    }
    throw err;
  }

  if (jar.cookies.length === 0) {
    throw new CookieJarError(
      `Cookie jar at ${jarPath} has no cookies. Re-export — the file should contain a "cookies" array with at least one entry.`,
    );
  }

  return jar;
}

/** Persist a freshly-captured storageState to the jar file (atomic + 0600).
 *  Used to keep the file useful as a fallback when silent refresh works. */
async function writeJar(jarPath: string, state: StorageState): Promise<void> {
  mkdirSync(dirname(jarPath), { recursive: true });
  const tmp = `${jarPath}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  chmodSync(tmp, 0o600);
  await rename(tmp, jarPath);
}

function isLive(c: StorageStateCookie): boolean {
  if (c.expires <= 0) return true; // session cookie — counts as live
  const now = Math.floor(Date.now() / 1000);
  return c.expires > now;
}

/**
 * Naive eTLD+1: take the last two dot-separated segments. Works for typical
 * SaaS hosts (`app.example.com` → `example.com`). Doesn't handle public-suffix
 * list edge cases like `*.co.uk` or `*.vercel.app`. For monkey's use case
 * (filtering injected cookies to the target's domain), this is the safe-side
 * trade-off — narrower-than-perfect filtering is fine; it just means cookies
 * for `staging.example.app` and `prod.example.app` would both share the same
 * "etldPlus1" of `example.app`, which is probably what the user wants.
 *
 * If real users hit edge cases, swap for `tldts` (~30 KB dep).
 */
function etldPlus1(hostname: string): string {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join('.');
}

function toCdpCookie(c: StorageStateCookie): Record<string, unknown> {
  const cdp: Record<string, unknown> = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
  };
  // -1 / 0 means session cookie; omit `expires` so CDP treats as session.
  if (c.expires > 0) {
    cdp.expires = c.expires;
  }
  return cdp;
}
