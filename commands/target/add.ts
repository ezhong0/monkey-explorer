// `monkey target add <name>` — register a new target (URL + auth + creds).
//
// Two flows mirror `monkey login`:
//
//  - Interactive: prompts.
//  - Non-interactive: --url + --auth-mode + (kind-dependent fields) → no prompts.
//
// Auto-runs bootstrap-auth at the end unless --no-bootstrap is set. This is
// the "fully succeed or fully fail" rule for CI: one command provisions a
// target end-to-end (state + cookie).

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
  authMode?: string; // 'ai-form' | 'interactive' | 'none' | 'custom'
  signInUrl?: string;
  testEmail?: string;
  testPassword?: string;
  customPath?: string;
  noBootstrap?: boolean;
  nonInteractive?: boolean;
}

const VALID_AUTH_MODES = ['ai-form', 'interactive', 'none', 'custom'] as const;

const AUTH_MODE_CHOICES = [
  {
    name: 'Email + password (AI-driven form fill)',
    value: 'ai-form' as const,
    description: 'Stagehand fills the sign-in form for you. Works for most password-form apps.',
  },
  {
    name: 'Interactive (sign in via Browserbase live view)',
    value: 'interactive' as const,
    description: 'You sign in manually in your browser. Covers magic link, OAuth, SSO, MFA.',
  },
  {
    name: 'None (public app, no auth)',
    value: 'none' as const,
  },
  {
    name: 'Custom (point at your own signIn JS file)',
    value: 'custom' as const,
    description: 'For unusual flows. The framework will prompt for trust on first use.',
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
    if (authModeFlag === 'ai-form') {
      return !!(opts.signInUrl && opts.testEmail && opts.testPassword);
    }
    if (authModeFlag === 'interactive') {
      return !!opts.signInUrl;
    }
    if (authModeFlag === 'custom') {
      return !!opts.customPath;
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
      case 'ai-form':
        authMode = {
          kind: 'ai-form',
          signInUrl: opts.signInUrl!,
          testEmail: opts.testEmail!,
          testPassword: opts.testPassword!,
        };
        break;
      case 'interactive':
        authMode = { kind: 'interactive', signInUrl: opts.signInUrl! };
        break;
      case 'none':
        authMode = { kind: 'none' };
        break;
      case 'custom':
        // Resolve to absolute now so the path is unambiguous regardless of
        // the cwd at later runs.
        authMode = {
          kind: 'custom',
          path: resolve(process.cwd(), opts.customPath!),
          // testEmail / testPassword are optional for custom — pass through
          // if provided.
          testEmail: opts.testEmail,
          testPassword: opts.testPassword,
        };
        break;
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
      opts.customPath
    );
    if (partialFlags) {
      log.fail('Partial flags provided for non-interactive mode. Either pass all required or none.');
      log.info('  Required: --url, --auth-mode.');
      log.info('  --auth-mode ai-form also needs: --sign-in-url, --test-email, --test-password.');
      log.info('  --auth-mode interactive also needs: --sign-in-url.');
      log.info('  --auth-mode custom also needs: --custom-path. Optional: --test-email, --test-password.');
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
      default: 'ai-form',
    });

    switch (authKind) {
      case 'ai-form': {
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
        authMode = { kind: 'ai-form', signInUrl, testEmail, testPassword };
        break;
      }
      case 'interactive': {
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
        authMode = { kind: 'interactive', signInUrl };
        break;
      }
      case 'none':
        authMode = { kind: 'none' };
        break;
      case 'custom': {
        const customPath = await input({
          message: 'Path to your signIn JS file (relative to this directory):',
          default: './signin.mjs',
        });
        const wantsCreds = await select({
          message: 'Does your custom signIn need test credentials?',
          choices: [
            { name: 'No', value: 'no' as const },
            { name: 'Yes — provide email + password', value: 'yes' as const },
          ],
          default: 'no',
        });
        let testEmail: string | undefined;
        let testPassword: string | undefined;
        if (wantsCreds === 'yes') {
          testEmail = await input({
            message: 'Test user email:',
            validate: (v) => (/^.+@.+\..+$/.test(v) ? true : 'Must be a valid email'),
          });
          testPassword = await password({
            message: 'Test user password:',
            mask: '*',
          });
        }
        authMode = {
          kind: 'custom',
          path: resolve(process.cwd(), customPath),
          testEmail,
          testPassword,
        };
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

  // Auto-bootstrap unless --no-bootstrap or auth mode is 'none'.
  if (opts.noBootstrap) {
    log.info('Skipping bootstrap (--no-bootstrap).');
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
