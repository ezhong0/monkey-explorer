// Global config schema. Source of truth — TS types inferred from Zod.
//
// Single file holds three concerns: credentials (per-user-machine), defaults
// (per-user preferences), and named targets (per-app-being-tested). Whole file
// is mode 0600.

import { z } from 'zod';

// ─── Reused shapes (copies of what was in lib/config/schema.ts) ───
//
// AuthMode and Caps were per-project before; now they live per-target inside
// the global state. The shapes don't change.

export const AuthModeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ai-form'),
    signInUrl: z.string().url(),
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
  }),
]);

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
});

// ─── Defaults block (per-user preferences) ───

export const DefaultsSchema = z.object({
  stagehandModel: z.string().min(1),
  agentModel: z.string().min(1),
  caps: CapsSchema,
});

// ─── Target block (per-app being tested) ───
//
// `contextId` is empty string until bootstrap-auth runs; non-empty after.
// `lastUsed` is best-effort; concurrent writes may lose updates.
// `testCredentials` is undefined for `none` and `custom` auth modes.

export const TargetSchema = z.object({
  url: z.string().url(),
  authMode: AuthModeSchema,
  testCredentials: z
    .object({
      email: z.string().email(),
      password: z.string().min(1),
    })
    .optional(),
  contextId: z.string(),
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
  stagehandModel: 'openai/gpt-5.5',
  agentModel: 'openai/gpt-5.5',
} as const;

export const DEFAULT_DEFAULTS: Defaults = {
  ...DEFAULT_MODELS,
  caps: DEFAULT_CAPS,
};

export const CURRENT_SCHEMA_VERSION = 1 as const;

// ─── Empty state factory ───

export function emptyState(): GlobalState {
  return {
    $schema_version: CURRENT_SCHEMA_VERSION,
    defaults: DEFAULT_DEFAULTS,
    targets: {},
  };
}
