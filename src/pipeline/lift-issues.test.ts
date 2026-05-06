import { describe, it, expect } from 'vitest';
import { liftDeterministicIssues, liftConsoleError, liftNetworkFailure } from './lift-issues.js';
import type { ConsoleEvent, NetworkFailure } from '../types.js';

describe('liftConsoleError', () => {
  it('promotes console.error to high-severity Issue', () => {
    const evt: ConsoleEvent = {
      level: 'error',
      message: 'TypeError: foo is undefined',
      timestamp: '2026-05-06T12:00:00.000Z',
    };
    const issue = liftConsoleError(evt, 0);
    expect(issue.source).toBe('lifter');
    expect(issue.severity).toBe('high');
    expect(issue.cites[0].stepId).toBe('step_console_0000');
    expect(issue.cites[0].evidenceType).toBe('console');
    expect(issue.summary).toContain('TypeError');
  });

  it('promotes console.warn to low-severity Issue', () => {
    const evt: ConsoleEvent = {
      level: 'warn',
      message: 'Deprecated prop foo',
      timestamp: '2026-05-06T12:00:00.000Z',
    };
    const issue = liftConsoleError(evt, 5);
    expect(issue.severity).toBe('low');
    expect(issue.cites[0].stepId).toBe('step_console_0005');
  });

  it('truncates very long messages in summary', () => {
    const longMsg = 'x'.repeat(500);
    const evt: ConsoleEvent = {
      level: 'error',
      message: longMsg,
      timestamp: '2026-05-06T12:00:00.000Z',
    };
    const issue = liftConsoleError(evt, 0);
    // Summary cap is 100 chars after the prefix
    expect(issue.summary.length).toBeLessThan(150);
    expect(issue.summary).toContain('…');
    // Full message preserved in details
    expect(issue.details).toContain(longMsg);
  });

  it('includes source location in details when provided', () => {
    const evt: ConsoleEvent = {
      level: 'error',
      message: 'oops',
      source: { url: 'https://app.example.com/foo.js', line: 42, column: 10 },
      timestamp: '2026-05-06T12:00:00.000Z',
    };
    const issue = liftConsoleError(evt, 0);
    expect(issue.details).toContain('foo.js:42');
  });
});

describe('liftNetworkFailure severity scaling', () => {
  const base = {
    url: 'https://app.example.com/api/foo',
    method: 'GET',
    timestamp: '2026-05-06T12:00:00.000Z',
  };

  it('5xx → high severity', () => {
    const evt: NetworkFailure = { ...base, status: 500 };
    expect(liftNetworkFailure(evt, 0).severity).toBe('high');
    const evt503: NetworkFailure = { ...base, status: 503 };
    expect(liftNetworkFailure(evt503, 0).severity).toBe('high');
  });

  it('429 → medium severity (rate-limit)', () => {
    const evt: NetworkFailure = { ...base, status: 429 };
    expect(liftNetworkFailure(evt, 0).severity).toBe('medium');
  });

  it('4xx (non-429) → medium severity', () => {
    const evt: NetworkFailure = { ...base, status: 404 };
    expect(liftNetworkFailure(evt, 0).severity).toBe('medium');
    const evt403: NetworkFailure = { ...base, status: 403 };
    expect(liftNetworkFailure(evt403, 0).severity).toBe('medium');
  });

  it('net::ERR (no status) → high severity', () => {
    const evt: NetworkFailure = { ...base, failure: 'net::ERR_FAILED' };
    expect(liftNetworkFailure(evt, 0).severity).toBe('high');
  });

  it('200-299 status (no real failure) → observation severity', () => {
    const evt: NetworkFailure = { ...base, status: 200 };
    expect(liftNetworkFailure(evt, 0).severity).toBe('observation');
  });

  it('cites step_network_NNNN with index zero-padded to 4', () => {
    const evt: NetworkFailure = { ...base, status: 500 };
    expect(liftNetworkFailure(evt, 7).cites[0].stepId).toBe('step_network_0007');
    expect(liftNetworkFailure(evt, 12).cites[0].stepId).toBe('step_network_0012');
    expect(liftNetworkFailure(evt, 1234).cites[0].stepId).toBe('step_network_1234');
  });
});

describe('liftDeterministicIssues integration', () => {
  it('merges console + network into one Issue array', () => {
    const { issues } = liftDeterministicIssues({
      consoleErrors: [
        {
          level: 'error',
          message: 'a',
          timestamp: '2026-05-06T12:00:00.000Z',
        },
      ],
      networkFailures: [
        {
          url: 'https://app.example.com/api/x',
          method: 'GET',
          status: 500,
          timestamp: '2026-05-06T12:00:01.000Z',
        },
      ],
    });
    expect(issues).toHaveLength(2);
    expect(issues[0].cites[0].stepId).toBe('step_console_0000');
    expect(issues[1].cites[0].stepId).toBe('step_network_0000');
  });

  it('returns empty issues array on empty input', () => {
    const { issues } = liftDeterministicIssues({
      consoleErrors: [],
      networkFailures: [],
    });
    expect(issues).toHaveLength(0);
  });
});
