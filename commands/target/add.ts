// `monkey target add <name>` — register a new target (URL + auth + creds).
//
// Two flows mirror `monkey login`:
//
//  - Interactive: prompts.
//  - Non-interactive: --url + --auth-mode + (kind-dependent fields) → no prompts.
//
// Auto-runs bootstrap-auth at the end unless --skip-bootstrap is set. This is
// the "fully succeed or fully fail" rule for CI: one command provisions a
// target end-to-end (state + cookie).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { input, password, select } from '../../lib/prompts/index.js';
import * as log from '../../lib/log/stderr.js';
import { requireGlobalState } from '../../lib/state/load.js';
import { saveGlobalState } from '../../lib/state/save.js';
import { isValidTargetName, TARGET_NAME_PATTERN } from '../../lib/state/path.js';
import type { AuthMode, GlobalState, Target } from '../../lib/state/schema.js';
import { runBootstrapAuth } from '../bootstrap-auth.js';

export interface TargetAddOpts {
  name?: string;
  url?: string;
  authMode?: string; // 'ai-form' | 'interactive' | 'none' | 'custom' | 'cookie-jar'
  signInUrl?: string;
  testEmail?: string;
  testPassword?: string;
  customPath?: string;
  cookieJarPath?: string;
  skipBootstrap?: boolean;
  nonInteractive?: boolean;
}

const VALID_AUTH_MODES = ['password', 'cookie-jar', 'none'] as const;

const AUTH_MODE_CHOICES = [
  {
    name: 'Password (AI-driven form fill)',
    value: 'password' as const,
    description: 'Email + password. Stagehand fills the sign-in form. Works for Clerk, Auth0, plain HTML forms.',
  },
  {
    name: 'Cookie jar (import storageState from your real browser)',
    value: 'cookie-jar' as const,
    description: 'For Google OAuth / SSO / MFA. Sign in once locally with `monkey export-cookies`, monkey injects.',
  },
  {
    name: 'None (public app, no auth)',
    value: 'none' as const,
  },
];

export async function runTargetAdd(opts: TargetAddOpts): Promise<number> {
  const name = opts.name!;
  if (!isValidTargetName(name)) {
    log.fail(`Invalid target name "${name}".`);
    log.info(`  Names must match ${TARGET_NAME_PATTERN.source} (alphanumerics, "_", "-").`);
    return 1;
  }

  const state = await requireGlobalState();

  if (state.targets[name]) {
    log.fail(`Target "${name}" already exists. Run \`monkey target rm ${name}\` first to replace it.`);
    return 1;
  }

  // Decide flow: non-interactive iff all required flags for the chosen
  // authMode are present.
  const authModeFlag = opts.authMode;
  const allFlagsForNonInteractive = (() => {
    if (!opts.url || !authModeFlag) return false;
    if (!VALID_AUTH_MODES.includes(authModeFlag as (typeof VALID_AUTH_MODES)[number])) return false;
    if (authModeFlag === 'password') {
      return !!(opts.signInUrl && opts.testEmail && opts.testPassword);
    }
    if (authModeFlag === 'cookie-jar') {
      return !!opts.cookieJarPath;
    }
    // 'none' has no further required flags
    return true;
  })();

  let url: string;
  let authMode: AuthMode;

  if (allFlagsForNonInteractive) {
    url = opts.url!;
    try {
      new URL(url);
    } catch {
      log.fail('--url must be a valid URL.');
      return 1;
    }

    switch (authModeFlag) {
      case 'password':
        authMode = {
          kind: 'password',
          signInUrl: opts.signInUrl!,
          testEmail: opts.testEmail!,
          testPassword: opts.testPassword!,
        };
        break;
      case 'none':
        authMode = { kind: 'none' };
        break;
      case 'cookie-jar': {
        const absPath = resolve(process.cwd(), opts.cookieJarPath!);
        if (!existsSync(absPath)) {
          log.fail(`--cookie-jar-path "${absPath}" does not exist.`);
          return 1;
        }
        authMode = { kind: 'cookie-jar', path: absPath };
        break;
      }
      default:
        log.fail(`Unknown --auth-mode "${authModeFlag}". Valid: ${VALID_AUTH_MODES.join(', ')}.`);
        return 1;
    }
  } else {
    // Interactive path. Reject partial flags per "fully succeed or fully fail".
    const partialFlags = !!(
      opts.url ||
      opts.authMode ||
      opts.signInUrl ||
      opts.testEmail ||
      opts.testPassword ||
      opts.customPath ||
      opts.cookieJarPath
    );
    if (partialFlags) {
      log.fail('Partial flags provided for non-interactive mode. Either pass all required or none.');
      log.info('  Required: --url, --auth-mode.');
      log.info('  --auth-mode password also needs: --sign-in-url, --test-email, --test-password.');
      log.info('  --auth-mode cookie-jar also needs: --cookie-jar-path.');
      return 1;
    }
    if (opts.nonInteractive) {
      log.fail('--non-interactive set but no provisioning flags provided.');
      log.info('  Pass --url, --auth-mode, and any auth-mode-specific flags.');
      log.info('  See `monkey target add --help` for required flags per auth mode.');
      return 1;
    }

    log.step(`Adding target "${name}".`);
    log.blank();

    url = await input({
      message: 'App URL:',
      validate: (v) => {
        try {
          new URL(v);
          return true;
        } catch {
          return 'Must be a valid URL';
        }
      },
    });

    const authKind = await select({
      message: 'Auth type:',
      choices: AUTH_MODE_CHOICES,
      default: 'password',
    });

    switch (authKind) {
      case 'password': {
        const signInUrl = await input({
          message: 'Sign-in URL:',
          validate: (v) => {
            try {
              new URL(v);
              return true;
            } catch {
              return 'Must be a valid URL';
            }
          },
        });
        const testEmail = await input({
          message: 'Test user email:',
          validate: (v) => (/^.+@.+\..+$/.test(v) ? true : 'Must be a valid email'),
        });
        const testPassword = await password({
          message: 'Test user password:',
          mask: '*',
        });
        authMode = { kind: 'password', signInUrl, testEmail, testPassword };
        break;
      }
      case 'none':
        authMode = { kind: 'none' };
        break;
      case 'cookie-jar': {
        const jarPath = await input({
          message: 'Path to the storageState JSON file (relative to this directory):',
          validate: (v) => {
            const abs = resolve(process.cwd(), v);
            return existsSync(abs) ? true : `File does not exist: ${abs}`;
          },
        });
        authMode = { kind: 'cookie-jar', path: resolve(process.cwd(), jarPath) };
        break;
      }
      default:
        throw new Error(`Unhandled auth kind: ${authKind}`);
    }
  }

  // Build target.
  const target: Target = {
    url,
    authMode,
    contextId: '',
    lastSignedInAt: '',
    lastUsed: '',
  };

  // Save with new target. First-ever target → also sets currentTarget.
  const next: GlobalState = {
    ...state,
    targets: { ...state.targets, [name]: target },
    currentTarget: state.currentTarget ?? name,
  };

  await saveGlobalState(next);
  log.ok(`Added target "${name}".`);
  if (state.currentTarget == null) {
    log.ok(`Set "${name}" as current target.`);
  }

  // Auto-bootstrap unless --skip-bootstrap or auth mode is 'none'.
  if (opts.skipBootstrap) {
    log.info('Skipping bootstrap (--skip-bootstrap).');
    log.info(`  Run \`monkey bootstrap-auth --target ${name}\` later to provision the cookie.`);
    return 0;
  }
  if (authMode.kind === 'none') {
    log.info('Auth mode "none" — no bootstrap needed.');
    return 0;
  }

  log.blank();
  return runBootstrapAuth({ targetName: name, nonInteractive: opts.nonInteractive });
}
