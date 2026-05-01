// monkey.config.json schema + types. Source of truth — TS types are inferred
// from Zod, not hand-maintained.

import { z } from 'zod';

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

export const MonkeyConfigSchema = z.object({
  $schema_version: z.number().int().positive(),
  authMode: AuthModeSchema,
  stagehandModel: z.string().min(1),
  agentModel: z.string().min(1),
  caps: CapsSchema,
});

export type MonkeyConfig = z.infer<typeof MonkeyConfigSchema>;

// Sensible defaults baked into init; not prompted.
export const DEFAULT_CAPS: z.infer<typeof CapsSchema> = {
  wallClockMs: 600_000, // 10 min
  maxSteps: 60,
  sessionTimeoutSec: 660, // 11 min — outer cap (above wall-clock)
};

export const DEFAULT_MODELS = {
  stagehandModel: 'openai/gpt-5.5',
  agentModel: 'openai/gpt-5.5',
};

export const CURRENT_SCHEMA_VERSION = 1 as const;
