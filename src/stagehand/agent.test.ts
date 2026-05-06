import { describe, it, expect } from 'vitest';
import { classifyError } from './agent.js';

describe('classifyError — rate_limit bucket', () => {
  const cases = [
    { name: 'Anthropic 429', err: { status: 429, message: 'Rate limit exceeded' } },
    { name: 'Anthropic 529', err: { status: 529, message: 'Overloaded' } },
    { name: 'rate_limit_error type', err: { error: { type: 'rate_limit_error' } } },
    { name: 'overloaded_error type', err: { error: { type: 'overloaded_error' } } },
    { name: 'Stagehand wrapper', err: { message: 'Failed after 3 attempts. Last error: Overloaded' } },
    { name: 'message contains "Overloaded"', err: { message: 'Overloaded' } },
    { name: 'message contains "rate limit"', err: { message: 'Rate limit hit, retry later' } },
    { name: 'context length', err: { message: 'Error: context length exceeded' } },
    { name: 'token cap', err: { message: 'token budget exhausted' } },
  ];
  for (const { name, err } of cases) {
    it(`${name} → kind=rate_limit`, () => {
      expect(classifyError(err).kind).toBe('rate_limit');
    });
  }
});

describe('classifyError — timeout bucket', () => {
  const cases = [
    { name: 'session was closed', err: { message: 'Stagehand session was closed' } },
    { name: 'CDP disconnected', err: { message: 'CDP transport disconnected' } },
    { name: 'cancelled', err: { message: 'request cancelled' } },
    { name: 'aborted', err: { message: 'aborted by user' } },
    { name: 'act() timeout', err: { message: 'TimeoutError: act() timed out after 45000ms' } },
  ];
  for (const { name, err } of cases) {
    it(`${name} → kind=timeout`, () => {
      expect(classifyError(err).kind).toBe('timeout');
    });
  }
});

describe('classifyError — other bucket (catch-all)', () => {
  const cases = [
    { name: 'generic Error', err: { message: 'something unexpected happened' } },
    { name: 'TypeError', err: { name: 'TypeError', message: "Cannot read properties of null" } },
    { name: 'string thrown (rare)', err: 'plain string' },
    { name: 'undefined', err: undefined },
  ];
  for (const { name, err } of cases) {
    it(`${name} → kind=other`, () => {
      expect(classifyError(err).kind).toBe('other');
    });
  }
});

describe('classifyError — message preservation', () => {
  it('preserves message string', () => {
    const result = classifyError({ message: 'My specific error', status: 429 });
    expect(result.message).toBe('My specific error');
  });

  it('falls back to String(err) when no message', () => {
    const result = classifyError(42);
    expect(result.message).toBe('42');
  });
});
