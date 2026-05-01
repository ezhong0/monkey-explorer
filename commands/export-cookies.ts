// `monkey export-cookies <name>` — open a monkey-owned local Chrome,
// navigate to a cookie-jar target's URL, wait for the user to sign in
// (or detect they already are), dump the resulting storageState as JSON.
//
// Why local Chrome (not Browserbase's Chrome): Google's bot detection is
// hostile to data-center IPs. Signing in from your real Chrome with your
// real IP just works — the cookies it produces are valid for use in
// Browserbase via cookie-jar mode. This is the standard Playwright
// `storageState` recipe.
//
// Persistent profile: monkey owns a Chrome profile dir at
// ~/.config/monkey-explorer/chrome-profile/. After your first sign-in
// there, subsequent re-exports reuse the same Chrome session — you don't
// re-do OAuth every export. Use --reset to wipe the profile (e.g. to
// sign in as a different user).
//
// Auto-detect signed-in: after navigation, monkey checks the page state.
// If you're already signed in, it just asks you to confirm; no need to
// click around to "verify" you got in.
//
// Requires `playwright-core` (already a monkey dep) + system Chrome.

import { existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeFile, rename } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';
import * as log from '../lib/log/stderr.js';
import { requireGlobalState } from '../lib/state/load.js';
import { saveGlobalState } from '../lib/state/save.js';
import { getChromeProfileDir, getCookieJarPathForTarget } from '../lib/state/path.js';
import { isValidTargetName } from '../lib/state/path.js';
import type { GlobalState } from '../lib/state/schema.js';

export interface ExportCookiesOpts {
  targetName: string;
  /** Override the output path. Default: ~/.config/monkey-explorer/cookie-jars/<name>.json */
  out?: string;
  /** If the target doesn't exist, create it with this URL + cookie-jar auth-mode. */
  url?: string;
  /** Wipe the persistent Chrome profile dir before launching. Use this to
   *  sign in as a different user, or to recover from a stuck profile lock. */
  reset?: boolean;
}

export async function runExportCookies(opts: ExportCookiesOpts): Promise<number> {
  if (!isValidTargetName(opts.targetName)) {
    log.fail(`Invalid target name "${opts.targetName}".`);
    return 1;
  }

  const state = await requireGlobalState();
  let target = state.targets[opts.targetName];

  // Two flows:
  //  - existing cookie-jar target → refresh the file at its existing path
  //  - missing target + --url provided → create cookie-jar target after export
  //  - existing target with non-cookie-jar mode → error
  if (target && target.authMode.kind !== 'cookie-jar') {
    log.fail(
      `Target "${opts.targetName}" exists but uses ${target.authMode.kind} auth.\n` +
        `  export-cookies only refreshes cookie-jar targets. Run \`monkey target rm ${opts.targetName}\` first.`,
    );
    return 1;
  }

  let navigationUrl: string;
  let outPath: string;
  if (target) {
    if (target.authMode.kind !== 'cookie-jar') throw new Error('unreachable');
    navigationUrl = target.url;
    outPath = opts.out ?? target.authMode.path;
  } else {
    if (!opts.url) {
      log.fail(`Target "${opts.targetName}" doesn't exist. Pass --url to create one.`);
      log.info(`  Example: monkey export-cookies ${opts.targetName} --url https://app.example.com`);
      return 1;
    }
    try {
      new URL(opts.url);
    } catch {
      log.fail('--url must be a valid URL.');
      return 1;
    }
    navigationUrl = opts.url;
    outPath = opts.out
      ? resolve(process.cwd(), opts.out)
      : getCookieJarPathForTarget(opts.targetName);
  }

  const profileDir = getChromeProfileDir();
  if (opts.reset) {
    log.step(`--reset: wiping Chrome profile at ${profileDir}`);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(`Failed to remove profile dir: ${(err as Error).message}`);
    }
  }
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(dirname(outPath), { recursive: true });

  log.step(`Exporting cookies for target "${opts.targetName}"`);
  log.info(`  Navigation URL: ${navigationUrl}`);
  log.info(`  Output:         ${outPath}`);
  log.info(`  Chrome profile: ${profileDir}${opts.reset ? ' (just reset)' : ''}`);
  log.blank();

  // Launch Chrome with a PERSISTENT profile dir. After your first sign-in,
  // future runs reuse the same session — no re-OAuth every export.
  log.step('Launching Chrome…');
  let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  try {
    browser = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      channel: 'chrome',
      viewport: null, // use the window's natural size
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (/Chromium revision is not downloaded/i.test(msg)) {
      log.fail('Chromium is not installed AND Chrome is not available.');
      log.info('  Install Chrome (https://www.google.com/chrome/) OR run:');
      log.info('    npx playwright install chromium');
      return 1;
    }
    if (/profile.*in use|SingletonLock/i.test(msg)) {
      log.fail('Chrome profile is locked (likely from a previous crashed run).');
      log.info(`  Run \`monkey export-cookies ${opts.targetName} --reset\` to wipe and retry.`);
      log.info(`  Or remove the lock manually: ${profileDir}/SingletonLock`);
      return 1;
    }
    log.fail(`Failed to launch local browser: ${msg}`);
    return 1;
  }

  try {
    const page = browser.pages()[0] ?? (await browser.newPage());
    await page.goto(navigationUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

    // Auto-detect: if the page already shows a signed-in state, skip the
    // "click around to verify" ceremony. Heuristic: presence of a sign-in
    // form / button on the visible page indicates NOT signed-in.
    const alreadySignedIn = await detectSignedIn(page);

    log.blank();
    if (alreadySignedIn) {
      log.ok('Detected signed-in session in the Chrome window.');
      log.info('  Press Enter to capture cookies, or sign out / sign in as a different');
      log.info('  user first if you want to refresh the session.');
    } else {
      log.step('Sign in via the Chrome window.');
      log.info('  Use your real account — Google OAuth, MFA, anything works.');
      log.info('  When you reach a signed-in page, return here and press Enter.');
    }
    log.blank();

    await waitForEnter();

    log.step('Reading session state…');
    const stateData = await browser.storageState();
    const cookieCount = stateData.cookies.length;
    const originCount = stateData.origins.length;
    log.info(`  ${cookieCount} cookies, ${originCount} origins`);

    if (cookieCount === 0) {
      log.fail('No cookies captured. Did you sign in successfully?');
      return 1;
    }

    // Atomic write at 0600.
    const tmp = `${outPath}.tmp`;
    await writeFile(tmp, JSON.stringify(stateData, null, 2) + '\n');
    chmodSync(tmp, 0o600);
    await rename(tmp, outPath);

    log.ok(`Wrote ${cookieCount} cookies to ${outPath} (mode 0600).`);

    // If target didn't exist, create it now.
    if (!target) {
      const next: GlobalState = {
        ...state,
        targets: {
          ...state.targets,
          [opts.targetName]: {
            url: navigationUrl,
            authMode: { kind: 'cookie-jar', path: outPath },
            contextId: '',
            lastSignedInAt: '',
            lastUsed: '',
          },
        },
        currentTarget: state.currentTarget ?? opts.targetName,
      };
      await saveGlobalState(next);
      log.ok(`Created cookie-jar target "${opts.targetName}".`);
      log.info(`  Next: monkey bootstrap-auth --target ${opts.targetName}`);
    } else {
      log.info(`  Next: monkey bootstrap-auth --target ${opts.targetName}  # injects fresh cookies into BB context`);
    }

    return 0;
  } finally {
    await browser.close().catch(() => {});
    void existsSync; // silence unused-import warning on TS-side
  }
}

async function waitForEnter(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  return new Promise((resolve) => {
    rl.question('Press Enter to continue… ', () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Heuristic check: is this Playwright page showing a signed-in app, or a
 * sign-in / login screen? Pure DOM-based — no Stagehand, no LLM, no
 * network calls.
 *
 * Looks for sign-in tells (password input, common sign-in copy) and
 * signed-in tells (logout/account menu copy). Conservative:
 *   - sign-in tells present → false
 *   - signed-in tells present (and no sign-in tells) → true
 *   - neither → false (default conservative; assumes user needs to sign in)
 */
async function detectSignedIn(page: import('playwright-core').Page): Promise<boolean> {
  try {
    const result = await page.evaluate(() => {
      const text = (document.body?.innerText ?? '').toLowerCase();
      const hasPasswordInput = document.querySelector('input[type="password"]') !== null;
      const hasSignInCopy = /\b(sign in|log in|login|signin)\b/.test(text);
      const hasContinueWithGoogle = /\bcontinue with google\b/.test(text);
      const hasSignedInTells = /\b(log out|logout|sign out|signout|my account|profile)\b/.test(text);
      const looksLikeSignIn = hasPasswordInput || hasContinueWithGoogle || (hasSignInCopy && !hasSignedInTells);
      return { looksLikeSignIn, hasSignedInTells };
    });
    if (result.looksLikeSignIn) return false;
    return result.hasSignedInTells;
  } catch {
    return false;
  }
}
