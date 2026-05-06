import { describe, it, expect } from 'vitest';
import { ReviewSchema } from './schema.js';

describe('ReviewSchema cross-field invariants (superRefine)', () => {
  const baseIssue = {
    source: 'agent' as const,
    severity: 'medium' as const,
    summary: 'something',
    details: 'details',
    cites: [{ stepId: 'step_0001', evidenceType: 'action' as const }],
  };

  it("verdict 'works' requires >=1 entry in tested[]", () => {
    const result = ReviewSchema.safeParse({
      verdict: 'works',
      summary: 'all good',
      tested: [],
      worked: [],
      issues: [],
      suggestions: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('tested'))).toBe(true);
    }
  });

  it("verdict 'works' rejects medium+ severity issues", () => {
    const result = ReviewSchema.safeParse({
      verdict: 'works',
      summary: 'all good',
      tested: ['homepage loaded'],
      worked: ['homepage loaded'],
      issues: [{ ...baseIssue, severity: 'medium' }],
      suggestions: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('issues'))).toBe(true);
    }
  });

  it("verdict 'works' allows low + observation severity issues", () => {
    const result = ReviewSchema.safeParse({
      verdict: 'works',
      summary: 'all good',
      tested: ['homepage loaded'],
      worked: ['homepage loaded'],
      issues: [
        { ...baseIssue, severity: 'low' },
        { ...baseIssue, severity: 'observation' },
      ],
      suggestions: [],
    });
    expect(result.success).toBe(true);
  });

  it("verdict 'broken' requires >=1 medium+ severity issue", () => {
    const result = ReviewSchema.safeParse({
      verdict: 'broken',
      summary: 'broken',
      tested: ['homepage'],
      worked: [],
      issues: [{ ...baseIssue, severity: 'low' }],
      suggestions: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('issues'))).toBe(true);
    }
  });

  it("verdict 'broken' accepts critical / high / medium issues", () => {
    for (const severity of ['critical', 'high', 'medium'] as const) {
      const result = ReviewSchema.safeParse({
        verdict: 'broken',
        summary: 'broken',
        tested: ['homepage'],
        worked: [],
        issues: [{ ...baseIssue, severity }],
        suggestions: [],
      });
      expect(result.success).toBe(true);
    }
  });

  it("diagnostic field rejected when verdict is not 'unclear'", () => {
    for (const verdict of ['works', 'broken', 'partial'] as const) {
      const tested = verdict === 'works' ? ['homepage'] : [];
      const issues =
        verdict === 'broken' ? [{ ...baseIssue, severity: 'high' as const }] : [];
      const result = ReviewSchema.safeParse({
        verdict,
        summary: 's',
        diagnostic: 'rate_limited',
        tested,
        worked: [],
        issues,
        suggestions: [],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('diagnostic'))).toBe(true);
      }
    }
  });

  it("diagnostic field accepted when verdict is 'unclear'", () => {
    const result = ReviewSchema.safeParse({
      verdict: 'unclear',
      summary: 'timed out',
      diagnostic: 'timed_out',
      tested: [],
      worked: [],
      issues: [],
      suggestions: [],
    });
    expect(result.success).toBe(true);
  });

  it("severity preprocess: 'warn' → 'low'", () => {
    const result = ReviewSchema.safeParse({
      verdict: 'partial',
      summary: 's',
      tested: [],
      worked: [],
      issues: [{ ...baseIssue, severity: 'warn' }],
      suggestions: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues[0].severity).toBe('low');
    }
  });

  it("severity preprocess: 'error' → 'high'", () => {
    const result = ReviewSchema.safeParse({
      verdict: 'partial',
      summary: 's',
      tested: [],
      worked: [],
      issues: [{ ...baseIssue, severity: 'error' }],
      suggestions: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues[0].severity).toBe('high');
    }
  });
});
