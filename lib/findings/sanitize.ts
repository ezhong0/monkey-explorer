// Output sanitizer — pure regex + entropy fallback.
//
// Applied to findings AND error fields before persistence. Defense against
// the agent extracting a secret-shaped string from the page (e.g., an API
// key visible in dev-tools, a session JWT in a cookie display, a database
// URI in a config dump, etc.) and against Stagehand stack traces leaking
// API keys into report `error` fields.

const REPLACEMENT = '[REDACTED]';
const ENTROPY_TAG = '[POSSIBLE-SECRET]';

interface Pattern {
  name: string;
  re: RegExp;
}

// Order matters: more-specific patterns first so their replacements win
// before broader catch-alls (JWT, entropy fallback).
const PATTERNS: ReadonlyArray<Pattern> = [
  // OpenAI / Anthropic. Anthropic prefix wins over openai (longer prefix).
  { name: 'anthropic-secret', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai-secret', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  // Browserbase
  { name: 'browserbase-key', re: /\bbb_(live|test)_[A-Za-z0-9_-]{16,}\b/g },
  // GitHub fine-grained PAT (must come before classic)
  { name: 'github-fine-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  // GitHub classic tokens
  { name: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  // AWS
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Slack
  { name: 'slack-token', re: /\bxox[bpasr]-[A-Za-z0-9-]{20,}\b/g },
  // 1Password
  { name: '1password-token', re: /\bops_(live|test|cache|sa)_[A-Za-z0-9_.-]{20,}\b/g },
  // Stripe (live + test, all key shapes including restricted rk_*)
  { name: 'stripe-key', re: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/g },
  // Google API
  { name: 'google-api-key', re: /\bAIzaSy[A-Za-z0-9_-]{30,}\b/g },
  // Vercel
  { name: 'vercel-token', re: /\bvc_[A-Za-z0-9_-]{20,}\b/g },
  // PEM / OpenSSH / RSA / DSA private key blocks
  {
    name: 'pem-private-key',
    re: /-----BEGIN (?:OPENSSH |RSA |DSA |EC |ENCRYPTED |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |DSA |EC |ENCRYPTED |PGP )?PRIVATE KEY-----/g,
  },
  // Database connection strings
  {
    name: 'db-uri',
    re: /\b(postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s@/]+:[^\s@/]+@[^\s/]+/g,
  },
  // Google service-account JSON shape (best-effort: looks for "private_key" field)
  {
    name: 'google-service-account',
    re: /"private_key"\s*:\s*"-----BEGIN[^"]*-----[^"]*-----END[^"]*-----[^"]*"/g,
  },
  // URL-embedded credentials: replace just the user:pass@ portion
  { name: 'url-credential', re: /(https?:\/\/)[^:/\s@]+:[^@\s]+@/g },
  // Bearer / Authorization headers
  {
    name: 'bearer-token',
    re: /\b(Bearer|Token|Authorization:?)\s+[A-Za-z0-9._\-+/=]{16,}\b/gi,
  },
  // JWT shape — runs late as catch-all
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// Entropy-based fallback for unknown secret shapes. Conservative: high
// entropy + long enough + no whitespace + no common-English-word shape.
const ENTROPY_THRESHOLD = 4.5;
const ENTROPY_MIN_LENGTH = 32;
const HIGH_ENTROPY_TOKEN_RE = /[A-Za-z0-9_+/=.\-]{32,}/g;

export function sanitizeText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re } of PATTERNS) {
    out = out.replace(re, REPLACEMENT);
  }
  // Entropy fallback — runs after explicit patterns.
  out = out.replace(HIGH_ENTROPY_TOKEN_RE, (match) => {
    if (match.length < ENTROPY_MIN_LENGTH) return match;
    if (shannonEntropy(match) < ENTROPY_THRESHOLD) return match;
    return ENTROPY_TAG;
  });
  return out;
}

import type { Issue, Review } from '../review/schema.js';

export function sanitizeIssue(issue: Issue): Issue {
  return {
    ...issue,
    summary: sanitizeText(issue.summary),
    details: sanitizeText(issue.details),
  };
}

export function sanitizeReview(review: Review): Review {
  return {
    ...review,
    summary: sanitizeText(review.summary),
    issues: review.issues.map(sanitizeIssue),
    suggestions: review.suggestions.map(sanitizeText),
    // tested[] and worked[] are agent-authored short labels — not user
    // input, but still passed through sanitization for defense in depth.
    tested: review.tested.map(sanitizeText),
    worked: review.worked.map(sanitizeText),
  };
}
