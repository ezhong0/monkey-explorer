// `monkey target add <name>` — register a new target.
//
// Two-knob CLI: a URL, optionally credentials. monkey infers the strategy:
//
//   --email --password   → password mode (Stagehand form-fill at runtime)
//   --no-auth            → public app, skip auth
//   neither              → ceremony mode (Chrome opens once, you sign in,
//                          monkey captures cookies; cookies live in the BB
//                          context for the lifetime of the auth provider's
//                          refresh token — no human in the loop after that)
//
// Sign-in URL for password mode defaults to `${origin}/sign-in`; override
// with --sign-in-url for apps that put it elsewhere.

import { input, password as passwordPrompt, select } from '../../lib/prompts/index.js';
import * as log from '../../lib/log/stderr.js';
import { requireGlobalState } from '../../lib/state/load.js';
import { saveGlobalState } from '../../lib/state/save.js';
import {
  isValidTargetName,
  TARGET_NAME_PATTERN,
  getCookieJarPathForTarget,
} from '../../lib/state/path.js';
import type { AuthMode, GlobalState, Target } from '../../lib/state/schema.js';
import { runBootstrapAuth } from '../bootstrap-auth.js';

export interface TargetAddOpts {
  name?: string;
  url?: string;
  /** Email for password-mode form-fill. Pair with --password. */
  testEmail?: string;
  /** Password for password-mode form-fill. Pair with --email. */
  testPassword?: string;
  /** Optional override; defaults to `${origin}/sign-in`. Password mode only. */
  signInUrl?: string;
  /** Public app — skip auth entirely. */
  noAuth?: boolean;
  /** Skip the auto-bootstrap / Chrome ceremony at the end (CI use). */
  skipBootstrap?: boolean;
  nonInteractive?: boolean;
}

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

  // Resolve URL — flag, otherwise prompt (interactive only).
  let url = opts.url;
  if (!url) {
    if (opts.nonInteractive) {
      log.fail('--url is required.');
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
  } else {
    try {
      new URL(url);
    } catch {
      log.fail(`--url is not a valid URL: ${url}`);
      return 1;
    }
  }

  // Decide auth strategy from what the user gave us.
  let authMode: AuthMode;
  if (opts.noAuth) {
    authMode = { kind: 'none' };
  } else if (opts.testEmail && opts.testPassword) {
    const signInUrl = opts.signInUrl ?? deriveSignInUrl(url);
    authMode = {
      kind: 'password',
      signInUrl,
      testEmail: opts.testEmail,
      testPassword: opts.testPassword,
    };
  } else if (opts.nonInteractive) {
    // Non-interactive with no creds and no --no-auth: default to ceremony.
    // Caller should have passed --skip-bootstrap if they want to defer the
    // Chrome ceremony to a later interactive session.
    authMode = { kind: 'cookie-jar', path: getCookieJarPathForTarget(name) };
  } else {
    // Interactive, no creds. Ask what kind of auth.
    const choice = await select<'ceremony' | 'password' | 'none'>({
      message: 'How does this app handle sign-in?',
      choices: [
        {
          name: 'Open a browser, I\'ll sign in once (works for OAuth, MFA, anything)',
          value: 'ceremony',
        },
        {
          name: 'Plain password form — fill it for me (give me email + password)',
          value: 'password',
        },
        {
          name: 'No sign-in (public app)',
          value: 'none',
        },
      ],
      default: 'ceremony',
    });
    if (choice === 'none') {
      authMode = { kind: 'none' };
    } else if (choice === 'password') {
      const testEmail = await input({
        message: 'Test user email:',
        validate: (v) => (/^.+@.+\..+$/.test(v) ? true : 'Must be a valid email'),
      });
      const testPassword = await passwordPrompt({
        message: 'Test user password:',
        mask: '*',
      });
      const signInUrl = deriveSignInUrl(url);
      authMode = { kind: 'password', signInUrl, testEmail, testPassword };
    } else {
      authMode = { kind: 'cookie-jar', path: getCookieJarPathForTarget(name) };
    }
  }

  // Save the target.
  const target: Target = {
    url,
    authMode,
    contextId: '',
    lastUsed: '',
  };
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

  if (opts.skipBootstrap) {
    log.info('Skipped bootstrap (--skip-bootstrap).');
    if (authMode.kind === 'cookie-jar') {
      log.info(`  Run \`monkey auth ${name}\` later to capture cookies.`);
    }
    return 0;
  }

  if (authMode.kind === 'none') {
    log.info('Public app — no auth ceremony needed.');
    return 0;
  }

  // For ceremony mode, delegate to runAuth (Chrome ceremony + bootstrap).
  // For password mode, run bootstrap-auth directly (Stagehand form-fill).
  log.blank();
  if (authMode.kind === 'cookie-jar') {
    const { runAuth } = await import('../auth.js');
    return runAuth({ targetName: name, nonInteractive: opts.nonInteractive });
  }
  return runBootstrapAuth({ targetName: name, nonInteractive: opts.nonInteractive });
}

/** Default sign-in URL: same origin as target, path `/sign-in`.
 *  Works for Clerk's Next.js convention; users with non-default paths
 *  can pass --sign-in-url explicitly. */
function deriveSignInUrl(targetUrl: string): string {
  const u = new URL(targetUrl);
  return `${u.origin}/sign-in`;
}
