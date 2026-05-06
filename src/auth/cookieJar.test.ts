import { describe, it, expect } from 'vitest';
import { etldPlus1 } from './cookieJar.js';

describe('etldPlus1 — naive 2-segment fallback', () => {
  it('app.example.com → example.com', () => {
    expect(etldPlus1('app.example.com')).toBe('example.com');
  });

  it('staging.foo.example.com → example.com', () => {
    expect(etldPlus1('staging.foo.example.com')).toBe('example.com');
  });

  it('two-segment hostname returned as-is', () => {
    expect(etldPlus1('example.com')).toBe('example.com');
  });

  it('single-segment hostname returned as-is', () => {
    expect(etldPlus1('localhost')).toBe('localhost');
  });
});

describe('etldPlus1 — known public suffixes (PSL fix, H3)', () => {
  // Regression: pre-fix, etldPlus1('foo.vercel.app') → 'vercel.app',
  // which would let cookies from any *.vercel.app site pass the filter.
  // Post-fix: returns the full per-tenant hostname.

  it('vercel.app: app.vercel.app → app.vercel.app (full host)', () => {
    expect(etldPlus1('app.vercel.app')).toBe('app.vercel.app');
  });

  it('vercel.app deep nesting: nested.foo.vercel.app → foo.vercel.app', () => {
    expect(etldPlus1('nested.foo.vercel.app')).toBe('foo.vercel.app');
  });

  it("vercel.app exact: 'vercel.app' returned as-is", () => {
    expect(etldPlus1('vercel.app')).toBe('vercel.app');
  });

  it('user-specific case: long Vercel preview hostname', () => {
    const hostname = 'structure-prediction-git-staging-preview-tamarind-team.vercel.app';
    expect(etldPlus1(hostname)).toBe(hostname);
  });

  const otherSuffixes: Array<[string, string]> = [
    ['my-app.pages.dev', 'my-app.pages.dev'],
    ['site.netlify.app', 'site.netlify.app'],
    ['username.github.io', 'username.github.io'],
    ['app.herokuapp.com', 'app.herokuapp.com'],
    ['x.web.app', 'x.web.app'],
    ['x.firebaseapp.com', 'x.firebaseapp.com'],
    ['x.run.app', 'x.run.app'],
    ['x.fly.dev', 'x.fly.dev'],
    ['x.railway.app', 'x.railway.app'],
    ['x.onrender.com', 'x.onrender.com'],
    ['x.glitch.me', 'x.glitch.me'],
    ['x.replit.app', 'x.replit.app'],
  ];
  for (const [hostname, expected] of otherSuffixes) {
    it(`PSL ${hostname.split('.').slice(-2).join('.')}: ${hostname} → ${expected}`, () => {
      expect(etldPlus1(hostname)).toBe(expected);
    });
  }
});
