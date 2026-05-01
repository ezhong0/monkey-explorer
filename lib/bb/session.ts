// Browserbase session lifecycle. Wraps SDK calls behind framework-internal
// types. `close` is `sessions.update REQUEST_RELEASE` under the hood —
// idempotent (verified during Phase 0 spike).

import type { Browserbase } from './client.js';

export interface MonkeySession {
  id: string;
  connectUrl: string;
  liveViewUrl: string;
  replayUrl: string;
  close: () => Promise<void>;
}

// userMetadata values must be slug-shaped (no spaces or special chars).
// Verified during Phase 0 spike: "Value is not a valid metadata value: <text>"
// for any value containing whitespace or punctuation outside [-._].
export function slugifyForMetadata(s: string, maxLen = 200): string {
  return s
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, maxLen);
}

export async function createSession(opts: {
  bb: Browserbase;
  projectId: string;
  contextId: string;
  mission: string;
  invocationId: string;
  sessionTimeoutSec: number;
}): Promise<MonkeySession> {
  // BB SDK type def lags the API: userMetadata is accepted at runtime
  // (verified Phase 0 spike) but not in SessionCreateParams type. Cast.
  const session = await opts.bb.sessions.create({
    projectId: opts.projectId,
    browserSettings: {
      context: { id: opts.contextId, persist: true },
    },
    timeout: opts.sessionTimeoutSec,
    userMetadata: {
      monkey: 'true',
      mission: slugifyForMetadata(opts.mission),
      invocation: opts.invocationId,
    },
  } as Parameters<typeof opts.bb.sessions.create>[0]);

  // Fetch live view URL up front so we can print it before the agent starts.
  let liveViewUrl = '';
  try {
    const debug = await opts.bb.sessions.debug(session.id);
    liveViewUrl = debug.debuggerFullscreenUrl ?? debug.debuggerUrl ?? '';
  } catch {
    // Live view URL is best-effort — don't block session creation if debug fails.
  }

  const replayUrl = `https://browserbase.com/sessions/${session.id}`;

  return {
    id: session.id,
    connectUrl: session.connectUrl,
    liveViewUrl,
    replayUrl,
    close: async () => {
      // bb.sessions.update with status: 'REQUEST_RELEASE' — idempotent.
      try {
        await opts.bb.sessions.update(session.id, {
          projectId: opts.projectId,
          status: 'REQUEST_RELEASE',
        });
      } catch {
        // Best-effort; session may already be released.
      }
    },
  };
}

export async function retrieveSession(bb: Browserbase, id: string) {
  return bb.sessions.retrieve(id);
}

export async function listMonkeySessions(
  bb: Browserbase,
  filter?: 'RUNNING' | 'ERROR' | 'TIMED_OUT' | 'COMPLETED',
) {
  const opts = filter ? { status: filter } : undefined;
  return bb.sessions.list(opts);
}
