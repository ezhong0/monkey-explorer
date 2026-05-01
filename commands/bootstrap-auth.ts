// `monkey bootstrap-auth [--target <name>]` — create or refresh the BB
// context's cookie for a target.
//
// Idempotent: reuses the target's existing contextId if present, creates a
// new one if missing. Always runs the configured signIn flow (so a re-run
// after cookie expiry refreshes it). lastSignedInAt is written ONLY after
// the post-signIn check confirms success — so `targetIsBootstrapped()` is
// accurate.

import { randomUUID } from 'node:crypto';
import * as log from '../lib/log/stderr.js';
import { requireGlobalState } from '../lib/state/load.js';
import { updateTarget } from '../lib/state/save.js';
import { resolveTarget } from '../lib/state/predicates.js';
import { createClient } from '../lib/bb/client.js';
import { createContext } from '../lib/bb/context.js';
import { createSession } from '../lib/bb/session.js';
import { createStagehand } from '../lib/stagehand/adapter.js';
import { dispatchSignIn } from '../lib/auth/dispatch.js';
import { isSignedIn } from '../lib/probe/markerDetect.js';
import { getRootSignal, installSigintHandler } from '../lib/signal/abort.js';

export interface BootstrapAuthOpts {
  /** Target name. If omitted, uses currentTarget. */
  targetName?: string;
  /** When set, error rather than prompt for trust on custom auth. */
  nonInteractive?: boolean;
}

export async function runBootstrapAuth(opts: BootstrapAuthOpts): Promise<number> {
  const state = await requireGlobalState();
  const { name, target } = resolveTarget(state, opts.targetName);
  const credentials = state.credentials!; // guaranteed by requireGlobalState

  if (target.authMode.kind === 'none') {
    log.info(`Auth mode for "${name}" is "none"; nothing to bootstrap.`);
    return 0;
  }

  // Make sure SIGINT handling is installed even if bootstrap-auth is called
  // standalone (i.e., not from runRun which already installs it). Idempotent.
  installSigintHandler();
  const signal = getRootSignal();

  const bb = createClient(credentials.browserbaseApiKey);

  // Reuse existing contextId or mint a new one.
  let contextId = target.contextId;
  let fresh = false;
  if (!contextId) {
    contextId = await createContext(bb, credentials.browserbaseProjectId);
    fresh = true;
    // Persist immediately so we don't leak the context if signIn later fails.
    // lastSignedInAt stays empty until post-check passes.
    await updateTarget(name, (t) => ({ ...t, contextId }));
  }

  log.step(fresh ? `Created new context: ${contextId}` : `Reusing existing context: ${contextId}`);

  log.step('Creating Browserbase session…');
  const session = await createSession({
    bb,
    projectId: credentials.browserbaseProjectId,
    contextId,
    mission: 'bootstrap_auth',
    invocationId: randomUUID().slice(0, 8),
    sessionTimeoutSec: state.defaults.caps.sessionTimeoutSec,
  });
  log.info(`  session=${session.id}`);

  let stagehandHandle: Awaited<ReturnType<typeof createStagehand>> | null = null;
  let signedInOk = false;
  try {
    stagehandHandle = await createStagehand({
      apiKey: credentials.browserbaseApiKey,
      projectId: credentials.browserbaseProjectId,
      sessionId: session.id,
      modelName: state.defaults.stagehandModel,
      modelApiKey: credentials.openaiApiKey,
      logPrefix: '',
    });

    const page = await stagehandHandle.page();

    log.step('Signing in…');
    await dispatchSignIn({
      authMode: target.authMode,
      page,
      stagehand: stagehandHandle.stagehand,
      liveViewUrl: session.liveViewUrl,
      targetUrl: target.url,
      signal,
      nonInteractive: !!opts.nonInteractive,
    });

    const signedIn = await isSignedIn({ page, stagehand: stagehandHandle.stagehand });
    if (signedIn === true) {
      log.ok('Signed in.');
      signedInOk = true;
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

  // ONLY mark the target as fully bootstrapped after the post-check passed.
  // This is what `targetIsBootstrapped` tests against.
  if (signedInOk) {
    const now = new Date().toISOString();
    await updateTarget(name, (t) => ({ ...t, lastSignedInAt: now }));
  }

  log.ok(`Context ID for "${name}": ${contextId}`);
  if (signedInOk) {
    log.ok(`Ready. Subsequent runs against "${name}" will reuse this context.`);
  } else {
    log.warn(`Bootstrap completed but sign-in could not be confirmed. The next run may auto-reauth.`);
  }
  return 0;
}
