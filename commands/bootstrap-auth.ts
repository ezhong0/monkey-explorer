// Bootstrap a Browserbase context with fresh auth cookies for a target.
//
// Idempotent: reuses the target's existing contextId if present, mints a new
// one (and persists it) if missing. Always runs the configured signIn flow,
// overwriting whatever cookies the context had before. Sessions created
// after bootstrap inherit the fresh cookies.
//
// Called automatically at the start of every `monkey "..."` invocation, AND
// directly via `monkey auth <name>` for the Chrome ceremony / smoke test.
// No `lastSignedInAt` field — bootstrap is always-on, not gated by past state.

import { randomUUID } from 'node:crypto';
import * as log from '../lib/log/stderr.js';
import { requireGlobalState } from '../lib/state/load.js';
import { updateTarget } from '../lib/state/save.js';
import { resolveTarget } from '../lib/state/predicates.js';
import { createClient } from '../lib/bb/client.js';
import { createContext } from '../lib/bb/context.js';
import { createSession } from '../lib/bb/session.js';
import { createStagehand } from '../lib/stagehand/adapter.js';
import { pickModelApiKey } from '../lib/stagehand/modelKey.js';
import { dispatchSignIn } from '../lib/auth/dispatch.js';
import { isSignedIn, waitForAuthSettled } from '../lib/probe/markerDetect.js';
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
  const credentials = state.credentials!;

  if (target.authMode.kind === 'none') {
    log.info(`Auth mode for "${name}" is "none"; nothing to bootstrap.`);
    return 0;
  }

  installSigintHandler();
  const signal = getRootSignal();
  const bb = createClient(credentials.browserbaseApiKey);

  // Reuse existing contextId or mint a new one. The context handle is stable
  // across runs (BB has no contexts.delete; reusing prevents leakage). The
  // cookies INSIDE it get overwritten on every bootstrap call.
  let contextId = target.contextId;
  if (!contextId) {
    contextId = await createContext(bb, credentials.browserbaseProjectId);
    await updateTarget(name, (t) => ({ ...t, contextId }));
    log.step(`Created new context: ${contextId}`);
  } else {
    log.step(`Reusing existing context: ${contextId}`);
  }

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
      modelApiKey: pickModelApiKey(state.defaults.stagehandModel, credentials),
      logPrefix: '',
    });

    const page = await stagehandHandle.page();

    log.step('Signing in…');
    await dispatchSignIn({
      authMode: target.authMode,
      page,
      stagehand: stagehandHandle.stagehand,
      targetUrl: target.url,
      targetName: name,
      signal,
    });

    // Auth-state-settle wait owned at the dispatch boundary — auth-mode
    // implementations don't have to remember this individually. After
    // dispatchSignIn the page has navigated to the post-signed-in URL but
    // the auth-provider's client-side refresh dance (Clerk/Auth0) may
    // still be in flight; isSignedIn run too eagerly observes the
    // pre-refresh state.
    await waitForAuthSettled(page);
    const signedIn = await isSignedIn({ page, stagehand: stagehandHandle.stagehand });
    if (signedIn === true) {
      log.ok('Signed in.');
      signedInOk = true;
    } else if (signedIn === false) {
      log.warn(
        'Sign-in flow completed but post-check says "not signed in". Cookie may not have persisted.',
      );
      if (target.authMode.kind === 'cookie-jar') {
        log.info(
          `  Cookies in the jar may have aged out (auth-provider session JWTs typically expire in ~5 min).`,
        );
        log.info(`  Re-export with:  monkey auth ${name}`);
      }
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

  if (signedInOk) {
    log.ok(`Ready. Subsequent missions in this run will share context ${contextId}.`);
    return 0;
  } else {
    log.fail(`Bootstrap could not confirm sign-in. Aborting before any mission session spawns.`);
    if (target.authMode.kind === 'cookie-jar') {
      log.info(`  Refresh cookies:  monkey auth ${name}`);
    }
    return 1;
  }
}
