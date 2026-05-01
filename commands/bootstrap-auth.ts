// `monkey bootstrap-auth` — create or refresh the Browserbase context's cookie.
//
// Idempotent: reuses the existing .context-id if present, creates a new one
// if missing. Always runs the configured signIn flow (so a re-run after
// cookie expiry refreshes it).

import { resolve } from 'node:path';
import * as log from '../lib/log/stderr.js';
import { loadConfig } from '../lib/config/load.js';
import { loadEnv, validateEnvForConfig } from '../lib/env/loadEnv.js';
import { createClient } from '../lib/bb/client.js';
import { getOrCreateContextId } from '../lib/bb/context.js';
import { createSession } from '../lib/bb/session.js';
import { createStagehand } from '../lib/stagehand/adapter.js';
import { dispatchSignIn } from '../lib/auth/dispatch.js';
import { isSignedIn } from '../lib/probe/markerDetect.js';
import { randomUUID } from 'node:crypto';

export interface BootstrapAuthOpts {
  projectDir: string;
  /** Skip the user-facing logs (used when called from init). */
  quiet?: boolean;
}

export async function runBootstrapAuth(opts: BootstrapAuthOpts): Promise<number> {
  const projectDir = resolve(opts.projectDir);
  const { config, configDir } = await loadConfig(projectDir);
  const env = loadEnv(projectDir);
  validateEnvForConfig(env, config);

  if (config.authMode.kind === 'none') {
    log.info('Auth mode is "none"; nothing to bootstrap.');
    return 0;
  }

  const bb = createClient(env.BROWSERBASE_API_KEY);
  const { id: contextId, fresh } = await getOrCreateContextId(
    bb,
    env.BROWSERBASE_PROJECT_ID,
    projectDir,
  );

  if (!opts.quiet) {
    log.step(fresh ? `Created new context: ${contextId}` : `Reusing existing context: ${contextId}`);
  }

  // Spin up a session that uses this context. signIn writes the cookie into it.
  log.step('Creating Browserbase session…');
  const session = await createSession({
    bb,
    projectId: env.BROWSERBASE_PROJECT_ID,
    contextId,
    mission: 'bootstrap_auth',
    invocationId: randomUUID().slice(0, 8),
    sessionTimeoutSec: config.caps.sessionTimeoutSec,
  });
  log.info(`  session=${session.id}`);

  let stagehandHandle: Awaited<ReturnType<typeof createStagehand>> | null = null;
  try {
    stagehandHandle = await createStagehand({
      apiKey: env.BROWSERBASE_API_KEY,
      projectId: env.BROWSERBASE_PROJECT_ID,
      sessionId: session.id,
      modelName: config.stagehandModel,
      modelApiKey: env.OPENAI_API_KEY,
      logPrefix: '',
    });

    const page = await stagehandHandle.page();

    log.step('Signing in…');
    await dispatchSignIn({
      authMode: config.authMode,
      page,
      stagehand: stagehandHandle.stagehand,
      email: env.TEST_EMAIL,
      password: env.TEST_PASSWORD,
      liveViewUrl: session.liveViewUrl,
      configDir,
      signal: new AbortController().signal,
    });

    // Sanity check
    const signedIn = await isSignedIn({ page, stagehand: stagehandHandle.stagehand });
    if (signedIn === true) {
      log.ok('Signed in.');
    } else if (signedIn === false) {
      log.warn(
        'Sign-in flow completed but post-check says "not signed in". Cookie may not have persisted.',
      );
    } else {
      log.warn('Could not confirm signed-in state. Inspect the replay if needed.');
      log.info(`  Replay: ${session.replayUrl}`);
    }
  } catch (err) {
    log.fail(`Bootstrap-auth failed: ${(err as Error).message}`);
    return 1;
  } finally {
    if (stagehandHandle) await stagehandHandle.close();
    await session.close();
  }

  log.ok(`Context ID: ${contextId}`);
  log.ok('Ready. Subsequent monkey runs will reuse this context until the cookie expires.');
  return 0;
}
