// `monkey init` — interactive setup. Writes monkey.config.json + .env.local.
//
// Validates each credential at entry (BB key via projects.list, OpenAI via
// chat-completion test). After successful write, runs bootstrap-auth.
//
// If config already exists, errors with "run configure instead" — never
// silently overwrites.

import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { input, password, select, confirm } from '../lib/prompts/index.js';
import * as log from '../lib/log/stderr.js';
import { createClient } from '../lib/bb/client.js';
import { listProjects } from '../lib/bb/projects.js';
import { saveConfigAndEnv, type EnvLocal } from '../lib/config/save.js';
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_CAPS,
  DEFAULT_MODELS,
  type MonkeyConfig,
} from '../lib/config/schema.js';
import type { AuthMode } from '../lib/types.js';
import { runBootstrapAuth } from './bootstrap-auth.js';

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

export async function runInit(projectDir: string): Promise<number> {
  const cwd = resolve(projectDir);
  const cfgPath = join(cwd, 'monkey.config.json');

  if (existsSync(cfgPath)) {
    log.fail(`monkey.config.json already exists in ${cwd}.`);
    log.info('  Run `monkey configure` to update fields, or remove the file to start fresh.');
    return 1;
  }

  log.step('Setting up monkey-explorer.');
  log.blank();

  // ─── Infrastructure
  log.info('▸ Infrastructure credentials');
  const browserbaseApiKey = await password({
    message: 'Browserbase API key:',
    mask: '*',
    validate: (v) => (v.startsWith('bb_') ? true : 'Expected key to start with bb_'),
  });

  // Auto-discover BB project
  let projectId = '';
  try {
    const bb = createClient(browserbaseApiKey);
    const projects = await listProjects(bb);
    if (projects.length === 0) {
      log.fail('No Browserbase projects found for this API key.');
      return 1;
    } else if (projects.length === 1) {
      projectId = projects[0].id;
      log.ok(`Found project "${projects[0].name}" — using it.`);
    } else {
      projectId = await select({
        message: 'Multiple Browserbase projects found. Which to use?',
        choices: projects.map((p) => ({ name: p.name, value: p.id })),
      });
    }
  } catch (err) {
    log.fail(`Browserbase API key validation failed: ${(err as Error).message}`);
    log.info('  The key may be invalid or expired. Re-run init.');
    return 1;
  }

  const openaiApiKey = await password({
    message: 'OpenAI API key:',
    mask: '*',
    validate: (v) => (v.startsWith('sk-') ? true : 'Expected key to start with sk-'),
  });

  // Validate OpenAI key with a cheap models-list call.
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${openaiApiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log.fail(`OpenAI API key validation failed: HTTP ${res.status}`);
      return 1;
    }
  } catch (err) {
    log.fail(`OpenAI API key validation failed: ${(err as Error).message}`);
    return 1;
  }

  const anthropicApiKey = await password({
    message: 'Anthropic API key (optional, leave blank to skip):',
    mask: '*',
  });
  log.blank();

  // ─── Authentication
  log.info('▸ Authentication');
  const authKind = await select({
    message: 'Auth type:',
    choices: AUTH_MODE_CHOICES,
    default: 'ai-form',
  });

  let authMode: AuthMode;
  let testEmail: string | undefined;
  let testPassword: string | undefined;

  switch (authKind) {
    case 'ai-form':
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
      if (authKind === 'ai-form') {
        testEmail = await input({
          message: 'Test user email:',
          validate: (v) => (/^.+@.+\..+$/.test(v) ? true : 'Must be a valid email'),
        });
        testPassword = await password({
          message: 'Test user password:',
          mask: '*',
        });
      }
      authMode = { kind: authKind, signInUrl };
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
      authMode = { kind: 'custom', path: customPath };
      break;
    }
    default:
      throw new Error(`Unhandled auth kind: ${authKind}`);
  }
  log.blank();

  // ─── Models
  log.info('▸ Models');
  const stagehandModel = await input({
    message: 'Stagehand model:',
    default: DEFAULT_MODELS.stagehandModel,
  });
  const agentModel = await input({
    message: 'Agent model:',
    default: DEFAULT_MODELS.agentModel,
  });
  log.blank();

  // ─── Build + write
  const config: MonkeyConfig = {
    $schema_version: CURRENT_SCHEMA_VERSION,
    authMode,
    stagehandModel,
    agentModel,
    caps: DEFAULT_CAPS,
  };

  const env: EnvLocal = {
    BROWSERBASE_API_KEY: browserbaseApiKey,
    BROWSERBASE_PROJECT_ID: projectId,
    OPENAI_API_KEY: openaiApiKey,
    ANTHROPIC_API_KEY: anthropicApiKey || undefined,
    TEST_EMAIL: testEmail,
    TEST_PASSWORD: testPassword,
  };

  await saveConfigAndEnv({ dir: cwd, config, env });
  log.ok('Wrote monkey.config.json + .env.local');
  log.blank();

  // ─── Auto-bootstrap
  if (authMode.kind === 'none') {
    log.info('▸ Skipping bootstrap-auth (auth mode is "none").');
    log.ok('Ready. Try: monkey "test the homepage"');
    return 0;
  }

  const proceed = await confirm({
    message: 'Bootstrap auth context now? (Creates a Browserbase context and signs in once.)',
    default: true,
  });
  if (!proceed) {
    log.info('Skipping bootstrap. Run `monkey bootstrap-auth` when ready.');
    return 0;
  }

  return runBootstrapAuth({ projectDir: cwd });
}
