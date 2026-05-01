// Global config schema. Source of truth — TS types inferred from Zod.
//
// Single file holds three concerns: credentials (per-user-machine), defaults
// (per-user preferences), and named targets (per-app-being-tested). Whole file
// is mode 0600.

import { z } from 'zod';

// ─── AuthMode discriminated union (v2 schema) ───
//
// v2 change: testEmail + testPassword moved from Target.testCredentials into
// the AuthMode variants that need them. ai-form REQUIRES them by construction.
// custom MAY optionally have them (passed through to the user's signIn fn).
// interactive and none don't carry creds at all. This eliminates the
// asymmetric-handling bug that was possible in v1.

export const AuthModeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ai-form'),
    signInUrl: z.string().url(),
    testEmail: z.string().email(),
    testPassword: z.string().min(1),
  }),
  z.object({
    kind: z.literal('interactive'),
    signInUrl: z.string().url(),
  }),
  z.object({
    kind: z.literal('none'),
  }),
  z.object({
    kind: z.literal('custom'),
    path: z.string().min(1),
    testEmail: z.string().email().optional(),
    testPassword: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('cookie-jar'),
    // Absolute path to a Playwright storageState JSON file. Resolved at
    // `target add` time. The file is read at every bootstrap-auth.
    path: z.string().min(1),
  }),
]);

// ─── Playwright storageState shape ───
//
// Permissive (`.passthrough()`) so future Playwright versions adding fields
// (priority, partitionKey, sourceScheme, etc.) don't break the loader.

export const StorageStateCookieSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    domain: z.string(),
    path: z.string(),
    expires: z.number(), // unix epoch seconds; -1 = session cookie
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(['Lax', 'Strict', 'None']),
  })
  .passthrough();

export const StorageStateOriginSchema = z.object({
  origin: z.string().url(),
  localStorage: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .default([]),
});

export const StorageStateSchema = z
  .object({
    cookies: z.array(StorageStateCookieSchema).default([]),
    origins: z.array(StorageStateOriginSchema).default([]),
  })
  .passthrough();

export type StorageState = z.infer<typeof StorageStateSchema>;
export type StorageStateCookie = z.infer<typeof StorageStateCookieSchema>;

export const CapsSchema = z.object({
  wallClockMs: z.number().int().positive({
    message: 'caps.wallClockMs must be a positive integer (milliseconds)',
  }),
  maxSteps: z.number().int().positive({
    message: 'caps.maxSteps must be a positive integer',
  }),
  sessionTimeoutSec: z.number().int().positive({
    message: 'caps.sessionTimeoutSec must be a positive integer (seconds)',
  }),
});

// ─── Credentials block (per-user-machine) ───

export const CredentialsSchema = z.object({
  browserbaseApiKey: z.string().min(1),
  browserbaseProjectId: z.string().min(1),
  openaiApiKey: z.string().min(1),
  anthropicApiKey: z.string().min(1).optional(),
  // Optional override for the Anthropic API base URL. Set to e.g. an Azure
  // Foundry endpoint (https://<resource>.services.ai.azure.com/anthropic)
  // to route Claude calls there instead of api.anthropic.com — useful when
  // the direct Anthropic key has tight rate limits and an Azure deployment
  // has more headroom. When set, anthropicApiKey is interpreted as the
  // Azure deployment's key (NOT a sk-ant-... key).
  anthropicBaseURL: z.string().url().optional(),
});

// ─── Defaults block (per-user preferences) ───

export const DefaultsSchema = z.object({
  stagehandModel: z.string().min(1),
  agentModel: z.string().min(1),
  // Adjudicator runs after the mission; reads the trace and emits findings
  // with cited provenance. Optional — falls back to agentModel when unset.
  // Adjudication is text-heavy reasoning; can usually run on a cheaper model
  // than the explorer (e.g. claude-sonnet-4-5 instead of claude-opus-4-6).
  adjudicatorModel: z.string().min(1).optional(),
  caps: CapsSchema,
});

// ─── Target block (per-app being tested) ───
//
// `contextId` is empty string until bootstrap-auth runs; non-empty after.
// `lastSignedInAt` is empty string until signIn post-check confirms success;
// only THEN is the target truly bootstrapped. Used by `targetIsBootstrapped`.
// `lastUsed` is best-effort; concurrent writes may lose updates.

export const TargetSchema = z.object({
  url: z.string().url(),
  authMode: AuthModeSchema,
  contextId: z.string(),
  lastSignedInAt: z.string(),
  lastUsed: z.string(),
});

// ─── Top-level state ───

export const GlobalStateSchema = z.object({
  $schema_version: z.number().int().positive(),
  credentials: CredentialsSchema.optional(), // optional during initial setup
  defaults: DefaultsSchema,
  targets: z.record(z.string(), TargetSchema),
  currentTarget: z.string().optional(),
});

export type GlobalState = z.infer<typeof GlobalStateSchema>;
export type Credentials = z.infer<typeof CredentialsSchema>;
export type Defaults = z.infer<typeof DefaultsSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type AuthMode = z.infer<typeof AuthModeSchema>;
export type Caps = z.infer<typeof CapsSchema>;

// ─── Bootstrap defaults ───

export const DEFAULT_CAPS: Caps = {
  wallClockMs: 600_000, // 10 min
  maxSteps: 60,
  sessionTimeoutSec: 660, // 11 min — outer cap
};

export const DEFAULT_MODELS = {
  // Used by Stagehand's extract() and act() — text-mostly calls, not the
  // agentic loop. OpenAI gpt-5.5 here is fine.
  stagehandModel: 'openai/gpt-5.5',
  // Anthropic Sonnet 4.5 — CUA-capable. Stagehand's agent routes through
  // the Anthropic CUA path, which advertises user-provided tools to the
  // model. Requires anthropicApiKey in credentials.
  agentModel: 'anthropic/claude-sonnet-4-5-20250929',
} as const;

export const DEFAULT_DEFAULTS: Defaults = {
  ...DEFAULT_MODELS,
  caps: DEFAULT_CAPS,
};

export const CURRENT_SCHEMA_VERSION = 2 as const;

// ─── Empty state factory ───

export function emptyState(): GlobalState {
  return {
    $schema_version: CURRENT_SCHEMA_VERSION,
    defaults: DEFAULT_DEFAULTS,
    targets: {},
  };
}
