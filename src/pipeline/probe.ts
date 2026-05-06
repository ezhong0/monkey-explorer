// Probe stage: navigate the BB session to the target URL, classify the
// result. Caller (orchestrate / runMission) decides what to do — re-auth
// on sign-in-page, error otherwise.
//
// Wraps src/probe/probe.ts (which still owns the URL-policy check, fetch
// reachability, and signed-in heuristic). This file's job is to translate
// probe's output into a StageResult<void> with FailureCause.

import type { Page } from 'playwright-core';
import type { Stagehand } from '@browserbasehq/stagehand';
import { probe } from '../probe/probe.js';
import { sanitizeText } from '../review/sanitize.js';
import type { StageResult } from './types.js';
import { ok, fail } from './types.js';

export interface ProbeStageOpts {
  page: Page;
  stagehand: Stagehand;
  targetUrl: string;
  /** Used by probe to skip the auth marker check for auth-mode=none. */
  authModeKind: string;
  /** Used in failure-reason text so the user knows which target to refresh. */
  targetName: string;
}

export async function runProbe(opts: ProbeStageOpts): Promise<StageResult<void>> {
  let probeResult: Awaited<ReturnType<typeof probe>>;
  try {
    probeResult = await probe({
      page: opts.page,
      stagehand: opts.stagehand,
      target: opts.targetUrl,
      authModeKind: opts.authModeKind,
    });
  } catch (err) {
    const errMsg = sanitizeText((err as Error).message);
    return fail('infrastructure', errMsg);
  }

  if (probeResult.kind === 'ok') return ok(undefined);

  const reason =
    probeResult.kind === 'unreachable'
      ? `unreachable: ${probeResult.details}`
      : probeResult.kind === 'sign-in-page'
        ? `not signed in (bootstrap just ran but cookies didn't apply). Run \`monkey auth ${opts.targetName}\` to refresh.`
        : `unknown auth state: ${probeResult.details}`;
  return fail('probe_failed', reason);
}
