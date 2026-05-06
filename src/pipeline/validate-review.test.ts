import { describe, it, expect } from 'vitest';
import { validateReview } from './validate-review.js';
import type { Issue, Review } from '../review/schema.js';
import type { Trace } from '../trace/schema.js';

const makeTrace = (stepIds: string[]): Trace => ({
  header: {
    type: 'header',
    schemaVersion: 1,
    missionId: 'm1',
    mission: 'mission',
    target: 'https://app.example.com',
    startedAt: '2026-05-06T12:00:00.000Z',
    agentModel: 'anthropic/claude-opus-4-6',
  },
  steps: stepIds.map((id, i) => ({
    id,
    index: i,
    timestamp: '2026-05-06T12:00:00.000Z',
    url: 'https://app.example.com',
    type: 'action' as const,
    action: { description: 'click', method: 'click' },
    consoleEvents: [],
    networkEvents: [],
  })),
});

const makeReview = (issues: Issue[]): Review => ({
  verdict: 'partial',
  summary: 's',
  tested: [],
  worked: [],
  issues,
  suggestions: [],
});

describe('validateReview — forward provenance', () => {
  it('passes when all cites reference real trace steps', () => {
    const trace = makeTrace(['step_0001', 'step_0002']);
    const review = makeReview([
      {
        source: 'agent',
        severity: 'medium',
        summary: 's',
        details: 'd',
        cites: [{ stepId: 'step_0001', evidenceType: 'action' }],
      },
    ]);
    expect(validateReview(review, [], trace)).toEqual({ ok: true });
  });

  it('passes when cites reference lifter step IDs', () => {
    const trace = makeTrace(['step_0001']);
    const lifter: Issue[] = [
      {
        source: 'lifter',
        severity: 'high',
        summary: 'l',
        details: 'd',
        cites: [{ stepId: 'step_network_0000', evidenceType: 'network' }],
      },
    ];
    const review = makeReview([
      // The lifter issue echoed back into review
      lifter[0],
    ]);
    expect(validateReview(review, lifter, trace)).toEqual({ ok: true });
  });

  it('fails when cite references unknown stepId', () => {
    const trace = makeTrace(['step_0001']);
    const review = makeReview([
      {
        source: 'agent',
        severity: 'medium',
        summary: 's',
        details: 'd',
        cites: [{ stepId: 'step_9999', evidenceType: 'action' }],
      },
    ]);
    const result = validateReview(review, [], trace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('step_9999');
      expect(result.reason).toContain('non-existent step');
    }
  });
});

describe('validateReview — inverse provenance', () => {
  const trace = makeTrace(['step_0001']);

  const makeLifterIssue = (severity: Issue['severity'], stepId: string): Issue => ({
    source: 'lifter',
    severity,
    summary: 'l',
    details: 'd',
    cites: [{ stepId, evidenceType: 'network' }],
  });

  it('passes when high-severity lifter Issue appears in review.issues', () => {
    const lifter = [makeLifterIssue('high', 'step_network_0000')];
    const review = makeReview([
      {
        source: 'agent',
        severity: 'low',
        summary: 'agent observation referencing the same step',
        details: 'd',
        cites: [{ stepId: 'step_network_0000', evidenceType: 'network' }],
      },
    ]);
    expect(validateReview(review, lifter, trace)).toEqual({ ok: true });
  });

  it('passes when LLM downgrades severity (still cites the step)', () => {
    // The validator's contract: stepId membership matters, not severity match.
    const lifter = [makeLifterIssue('high', 'step_network_0000')];
    const review = makeReview([
      {
        source: 'lifter',
        severity: 'low', // downgraded by adjudicator
        summary: 'noisy',
        details: 'd',
        cites: [{ stepId: 'step_network_0000', evidenceType: 'network' }],
      },
    ]);
    expect(validateReview(review, lifter, trace)).toEqual({ ok: true });
  });

  it('fails when high-severity lifter Issue is dropped from review.issues', () => {
    const lifter = [makeLifterIssue('high', 'step_network_0000')];
    const review = makeReview([]);
    const result = validateReview(review, lifter, trace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('step_network_0000');
      expect(result.reason).toContain('high');
    }
  });

  it('fails when critical-severity lifter Issue is dropped', () => {
    const lifter = [makeLifterIssue('critical', 'step_console_0000')];
    const review = makeReview([]);
    const result = validateReview(review, lifter, trace);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('critical');
  });

  it('does NOT enforce inverse provenance for medium / low / observation lifter Issues', () => {
    const lifter = [
      makeLifterIssue('medium', 'step_network_0000'),
      makeLifterIssue('low', 'step_network_0001'),
      makeLifterIssue('observation', 'step_network_0002'),
    ];
    const review = makeReview([]);
    expect(validateReview(review, lifter, trace)).toEqual({ ok: true });
  });
});
