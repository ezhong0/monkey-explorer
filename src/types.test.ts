import { describe, it, expect } from 'vitest';
import { ALL_FAILURE_CAUSES, ALL_RUN_STATUS_KINDS, type FailureCause, type RunStatus } from './types.js';

describe('exhaustiveness guards', () => {
  it('ALL_FAILURE_CAUSES enumerates every FailureCause value', () => {
    // Compile-time guard already lives in types.ts. This test asserts the
    // runtime constant has every value the type does — guards against
    // someone adding to the union without updating ALL_FAILURE_CAUSES (the
    // compile-time guard catches that, but the runtime constant is what
    // consumers iterate).
    const all = new Set<string>(ALL_FAILURE_CAUSES);
    const everyValueRepresentedAtRuntime: FailureCause[] = [
      'wallclock',
      'rate_limited',
      'budget_exceeded',
      'agent_errored',
      'adjudicator_parse',
      'adjudicator_other',
      'probe_failed',
      'infrastructure',
      'aborted',
    ];
    for (const cause of everyValueRepresentedAtRuntime) {
      expect(all.has(cause)).toBe(true);
    }
    expect(ALL_FAILURE_CAUSES.length).toBe(everyValueRepresentedAtRuntime.length);
  });

  it('ALL_RUN_STATUS_KINDS enumerates every RunStatus.kind', () => {
    const all = new Set<string>(ALL_RUN_STATUS_KINDS);
    const everyValueRepresentedAtRuntime: RunStatus['kind'][] = [
      'running',
      'completed',
      'timed_out',
      'exceeded_tokens',
      'adjudicator_failed',
      'errored',
      'not_started',
      'aborted',
    ];
    for (const kind of everyValueRepresentedAtRuntime) {
      expect(all.has(kind)).toBe(true);
    }
    expect(ALL_RUN_STATUS_KINDS.length).toBe(everyValueRepresentedAtRuntime.length);
  });
});
