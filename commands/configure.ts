// `monkey configure` — re-prompts every field with current values as defaults.
// Press enter to accept unchanged. If credentials change, wipes .context-id
// and re-runs bootstrap-auth.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { input, password, select, confirm } from '../lib/prompts/index.js';
import * as log from '../lib/log/stderr.js';
import { loadConfig } from '../lib/config/load.js';
import { loadEnv } from '../lib/env/loadEnv.js';
import { createClient } from '../lib/bb/client.js';
import { listProjects } from '../lib/bb/projects.js';
import { wipeContextId } from '../lib/bb/context.js';
import { saveConfigAndEnv, type EnvLocal } from '../lib/config/save.js';
import { CURRENT_SCHEMA_VERSION, type MonkeyConfig } from '../lib/config/schema.js';
import type { AuthMode } from '../lib/types.js';
import { runBootstrapAuth } from './bootstrap-auth.js';

const AUTH_MODE_CHOICES = [
  { name: 'Email + password (AI-driven form fill)', value: 'ai-form' as const },
  { name: 'Interactive (sign in via Browserbase live view)', value: 'interactive' as const },
  { name: 'None (public app, no auth)', value: 'none' as const },
  { name: 'Custom (point at your own signIn JS file)', value: 'custom' as const },
];

export async function runConfigure(projectDir: string): Promise<number> {
  const cwd = resolve(projectDir);

  if (!existsSync(join(cwd, 'monkey.config.json'))) {
    log.fail('No monkey.config.json in this directory.');
    log.info('  Run `monkey init` to create a new project.');
    return 1;
  }

  const { config: existingConfig } = await loadConfig(cwd);
  const existingEnv = (() => {
    try {
      return loadEnv(cwd);
    } catch {
      return null; // .env.local malformed or missing — treat as fresh
    }
  })();

  log.step('Reconfiguring monkey-explorer. Press enter on any prompt to keep the current value.');
  log.blank();

  // ─── Infrastructure
  log.info('▸ Infrastructure credentials');
  const browserbaseApiKey = await password({
    message: 'Browserbase API key:',
    mask: '*',
    validate: (v) => (v.startsWith('bb_') ? true : 'Expected key to start with bb_'),
  });

  let projectId = existingEnv?.BROWSERBASE_PROJECT_ID ?? '';
  const credsChanged = browserbaseApiKey !== existingEnv?.BROWSERBASE_API_KEY;

  if (credsChanged) {
    try {
      const bb = createClient(browserbaseApiKey);
      const projects = await listProjects(bb);
      if (projects.length === 1) {
        projectId = projects[0].id;
        log.ok(`Found project "${projects[0].name}" — using it.`);
      } else if (projects.length > 1) {
        projectId = await select({
          message: 'Multiple projects. Which to use?',
          choices: projects.map((p) => ({ name: p.name, value: p.id })),
          default: projectId,
        });
      } else {
        log.fail('No projects found for this API key.');
        return 1;
      }
    } catch (err) {
      log.fail(`Browserbase API key validation failed: ${(err as Error).message}`);
      return 1;
    }
  }

  const openaiApiKey = await password({
    message: 'OpenAI API key:',
    mask: '*',
    validate: (v) => (v.startsWith('sk-') ? true : 'Expected key to start with sk-'),
  });

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
    default: existingConfig.authMode.kind,
  });

  let authMode: AuthMode;
  let testEmail: string | undefined = existingEnv?.TEST_EMAIL;
  let testPassword: string | undefined = existingEnv?.TEST_PASSWORD;

  switch (authKind) {
    case 'ai-form':
    case 'interactive': {
      const existingSignInUrl =
        existingConfig.authMode.kind === 'ai-form' ||
        existingConfig.authMode.kind === 'interactive'
          ? existingConfig.authMode.signInUrl
          : '';
      const signInUrl = await input({
        message: 'Sign-in URL:',
        default: existingSignInUrl || undefined,
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
          default: existingEnv?.TEST_EMAIL,
          validate: (v) => (/^.+@.+\..+$/.test(v) ? true : 'Must be a valid email'),
        });
        testPassword = await password({
          message: 'Test user password (leave blank to keep current):',
          mask: '*',
        });
        if (!testPassword) testPassword = existingEnv?.TEST_PASSWORD;
      }
      authMode = { kind: authKind, signInUrl };
      break;
    }
    case 'none':
      authMode = { kind: 'none' };
      testEmail = undefined;
      testPassword = undefined;
      break;
    case 'custom': {
      const existingPath =
        existingConfig.authMode.kind === 'custom' ? existingConfig.authMode.path : './signin.mjs';
      const customPath = await input({
        message: 'Path to your signIn JS file:',
        default: existingPath,
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
    default: existingConfig.stagehandModel,
  });
  const agentModel = await input({
    message: 'Agent model:',
    default: existingConfig.agentModel,
  });
  log.blank();

  // Build + write
  const config: MonkeyConfig = {
    $schema_version: CURRENT_SCHEMA_VERSION,
    authMode,
    stagehandModel,
    agentModel,
    caps: existingConfig.caps,
  };
  const env: EnvLocal = {
    BROWSERBASE_API_KEY: browserbaseApiKey,
    BROWSERBASE_PROJECT_ID: projectId,
    OPENAI_API_KEY: openaiApiKey,
    ANTHROPIC_API_KEY: anthropicApiKey || existingEnv?.ANTHROPIC_API_KEY,
    TEST_EMAIL: testEmail,
    TEST_PASSWORD: testPassword,
  };

  await saveConfigAndEnv({ dir: cwd, config, env });
  log.ok('Config + env updated.');
  log.blank();

  // Decide whether to wipe context + re-bootstrap
  const credsChangedFinal =
    browserbaseApiKey !== existingEnv?.BROWSERBASE_API_KEY ||
    openaiApiKey !== existingEnv?.OPENAI_API_KEY ||
    testEmail !== existingEnv?.TEST_EMAIL ||
    testPassword !== existingEnv?.TEST_PASSWORD ||
    authMode.kind !== existingConfig.authMode.kind ||
    (authMode.kind === 'ai-form' &&
      existingConfig.authMode.kind === 'ai-form' &&
      authMode.signInUrl !== existingConfig.authMode.signInUrl);

  if (credsChangedFinal) {
    log.warn('Credentials changed — wiping .context-id and re-bootstrapping.');
    await wipeContextId(cwd);
    return runBootstrapAuth({ projectDir: cwd });
  }

  log.info('Credentials unchanged — keeping existing context.');
  const reBootstrap = await confirm({
    message: 'Run bootstrap-auth anyway (e.g., to refresh an expired cookie)?',
    default: false,
  });
  if (reBootstrap) {
    return runBootstrapAuth({ projectDir: cwd });
  }
  return 0;
}
