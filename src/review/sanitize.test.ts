import { describe, it, expect } from 'vitest';
import { sanitizeText, sanitizeIssue, sanitizeReview } from './sanitize.js';

describe('sanitizeText pattern matches', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['anthropic key', 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', /\[REDACTED\]/],
    ['openai key', 'sk-proj-yyyyyyyyyyyyyyyyyyyyyyyyy', /\[REDACTED\]/],
    ['browserbase key live', 'bb_live_abcdefghijklmnop', /\[REDACTED\]/],
    ['browserbase key test', 'bb_test_abcdefghijklmnop', /\[REDACTED\]/],
    ['github fine pat', 'github_pat_' + 'A'.repeat(70), /\[REDACTED\]/],
    ['github classic', 'ghp_' + 'A'.repeat(35), /\[REDACTED\]/],
    ['aws access key', 'AKIA0123456789ABCDEF', /\[REDACTED\]/],
    ['slack token', 'xoxb-1234-abcdefghijklmnopqrstuvw', /\[REDACTED\]/],
    ['stripe live key', 'sk_live_aaaaaaaaaaaaaaaa', /\[REDACTED\]/],
    ['google api', 'AIzaSy' + 'A'.repeat(33), /\[REDACTED\]/],
    [
      'JWT (long)',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      /\[REDACTED\]/,
    ],
    ['db uri', 'postgres://user:pass@db.example.com:5432/foo', /\[REDACTED\]/],
    ['url credential', 'https://user:secret@api.example.com/foo', /\[REDACTED\]/],
    ['bearer token', 'Authorization: Bearer abcdefghij' + 'kl'.repeat(10), /\[REDACTED\]/],
  ];

  for (const [name, input, expected] of cases) {
    it(`redacts ${name}`, () => {
      const out = sanitizeText(input);
      expect(out).toMatch(expected);
      expect(out).not.toContain(input);
    });
  }

  it('preserves benign text', () => {
    const benign = 'The Save button shows a loading spinner for 8 seconds before responding.';
    expect(sanitizeText(benign)).toBe(benign);
  });

  it('redacts high-entropy unknown-shape secrets via entropy fallback', () => {
    const highEntropy = 'a1B2c3D4e5F6g7H8i9J0kLmN0pQrSt';
    // 30 chars = below ENTROPY_MIN_LENGTH (32). Should NOT redact.
    expect(sanitizeText(highEntropy)).toContain(highEntropy);

    const longHighEntropy = 'a1B2c3D4e5F6g7H8i9J0kLmN0pQrStUvWxYz1234';
    // 40 chars + high entropy (mixed case + digits, no repeats) → tagged.
    const out = sanitizeText(longHighEntropy);
    expect(out).toContain('[POSSIBLE-SECRET]');
  });

  it('does not flag low-entropy long strings', () => {
    const lowEntropy = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(sanitizeText(lowEntropy)).toContain(lowEntropy);
  });

  it('handles empty + multiline input', () => {
    expect(sanitizeText('')).toBe('');
    expect(sanitizeText('a\nb\nc')).toBe('a\nb\nc');
  });
});

describe('sanitizeIssue + sanitizeReview', () => {
  it('redacts both summary + details on Issue', () => {
    const issue = {
      source: 'agent' as const,
      severity: 'high' as const,
      summary: 'Got token sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa back',
      details: 'Logs include AKIA0123456789ABCDEF in stderr',
      cites: [{ stepId: 'step_0001', evidenceType: 'action' as const }],
    };
    const cleaned = sanitizeIssue(issue);
    expect(cleaned.summary).toContain('[REDACTED]');
    expect(cleaned.details).toContain('[REDACTED]');
    expect(cleaned.severity).toBe('high'); // unchanged
    expect(cleaned.cites).toBe(issue.cites); // shared reference (not deeply copied)
  });

  it('traverses every LLM-authored field in Review', () => {
    const review = {
      verdict: 'broken' as const,
      summary: 'Saw Bearer abcdefghijklmnopqrstuvwxyz12 in response',
      tested: ['probed sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaa endpoint'],
      worked: [],
      issues: [
        {
          source: 'lifter' as const,
          severity: 'high' as const,
          summary: 'leak: AKIA0123456789ABCDEF',
          details: 'd',
          cites: [{ stepId: 'step_network_0001', evidenceType: 'network' as const }],
        },
      ],
      suggestions: ['Rotate sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa'],
    };
    const cleaned = sanitizeReview(review);
    expect(cleaned.summary).toContain('[REDACTED]');
    expect(cleaned.tested[0]).toContain('[REDACTED]');
    expect(cleaned.issues[0].summary).toContain('[REDACTED]');
    expect(cleaned.suggestions[0]).toContain('[REDACTED]');
    expect(cleaned.verdict).toBe('broken'); // unchanged
  });
});
