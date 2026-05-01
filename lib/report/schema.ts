// Report front-matter schema. Discriminated union per status — illegal
// states unrepresentable. Each variant carries only the fields that variant
// actually populates.
//
// Per-version dispatch in scan.ts; this is the v1 schema only.

import { z } from 'zod';
import { FindingSchema } from '../findings/schema.js';

/**
 * Report-file front-matter schema version. Independent of the global config
 * schema version (lib/state/schema.ts CURRENT_SCHEMA_VERSION) — reports have
 * their own evolution.
 */
export const REPORT_SCHEMA_VERSION = 1 as const;

const Common = {
  $schema_version: z.literal(REPORT_SCHEMA_VERSION),
  started_at: z.string().datetime(),
  target_url: z.string().url(),
  mission: z.string().min(1),
};

export const ReportFrontMatterSchema = z.discriminatedUnion('status', [
  // Active — session may still be running
  z.object({
    ...Common,
    status: z.literal('running'),
    finished_at: z.null().optional(),
    session_id: z.string().nullable(),
    live_view_url: z.string().url().nullable(),
    replay_url: z.string().url().nullable(),
  }),
  z.object({
    ...Common,
    status: z.literal('completed'),
    finished_at: z.string().datetime(),
    session_id: z.string(),
    replay_url: z.string().url(),
    ranForMs: z.number(),
    findings_count: z.number().int().nonnegative(),
    tokens_used: z.number().int().nonnegative().nullable().optional(),
  }),
  z.object({
    ...Common,
    status: z.literal('timed_out'),
    finished_at: z.string().datetime(),
    session_id: z.string(),
    replay_url: z.string().url(),
    ranForMs: z.number(),
    findings_count: z.number().int().nonnegative(),
  }),
  z.object({
    ...Common,
    status: z.literal('exceeded_tokens'),
    finished_at: z.string().datetime(),
    session_id: z.string(),
    replay_url: z.string().url(),
    ranForMs: z.number(),
    findings_count: z.number().int().nonnegative(),
  }),
  z.object({
    ...Common,
    status: z.literal('adjudicator_failed'),
    finished_at: z.string().datetime(),
    session_id: z.string(),
    replay_url: z.string().url(),
    ranForMs: z.number(),
    findings_count: z.number().int().nonnegative(),
    error: z.string(),
  }),
  z.object({
    ...Common,
    status: z.literal('errored'),
    finished_at: z.string().datetime(),
    session_id: z.string().nullable(),
    replay_url: z.string().url().nullable(),
    ranForMs: z.number(),
    error: z.string(),
  }),
  z.object({
    ...Common,
    status: z.literal('not_started'),
    finished_at: z.string().datetime(),
    session_id: z.string().nullable(),
    replay_url: z.string().url().nullable(),
    reason: z.string(),
  }),
  z.object({
    ...Common,
    status: z.literal('aborted'),
    finished_at: z.string().datetime(),
    session_id: z.string().nullable(),
    replay_url: z.string().url().nullable(),
    ranForMs: z.number(),
  }),
]);

export type ReportFrontMatter = z.infer<typeof ReportFrontMatterSchema>;

// Body sections live as markdown content — findings rendered inline; the
// front matter has only `findings_count` for `monkey list`'s row display.
// The actual finding objects are persisted as a fenced JSON block in the
// body (machine-readable on read-back), plus rendered as markdown for
// human display.

export const FindingsBlockSchema = z.object({
  findings: z.array(FindingSchema),
});
export type FindingsBlock = z.infer<typeof FindingsBlockSchema>;
