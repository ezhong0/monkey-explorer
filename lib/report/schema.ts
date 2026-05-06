// Report front-matter schema. Discriminated union per status — illegal
// states unrepresentable. Each variant carries only the fields that variant
// actually populates.
//
// Per-version dispatch in scan.ts; this is the v2 schema (v1 used the
// pre-reframe findings list + derived verdict; v2 carries Review.verdict
// directly and renames findings_count → issues_count).

import { z } from 'zod';
import { VerdictSchema } from '../review/schema.js';

/**
 * Report-file front-matter schema version. Independent of the global config
 * schema version (lib/state/schema.ts CURRENT_SCHEMA_VERSION) — reports have
 * their own evolution. Bumped from 1 → 2 with the reviewer reframe (Review
 * replaces Findings; verdict is a structured field, not derived).
 */
export const REPORT_SCHEMA_VERSION = 2 as const;

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
    verdict: VerdictSchema,
    issues_count: z.number().int().nonnegative(),
    tokens_used: z.number().int().nonnegative().nullable().optional(),
  }),
  z.object({
    ...Common,
    status: z.literal('timed_out'),
    finished_at: z.string().datetime(),
    session_id: z.string(),
    replay_url: z.string().url(),
    ranForMs: z.number(),
    verdict: VerdictSchema,
    issues_count: z.number().int().nonnegative(),
  }),
  z.object({
    ...Common,
    status: z.literal('exceeded_tokens'),
    finished_at: z.string().datetime(),
    session_id: z.string(),
    replay_url: z.string().url(),
    ranForMs: z.number(),
    verdict: VerdictSchema,
    issues_count: z.number().int().nonnegative(),
  }),
  z.object({
    ...Common,
    status: z.literal('adjudicator_failed'),
    finished_at: z.string().datetime(),
    session_id: z.string(),
    replay_url: z.string().url(),
    ranForMs: z.number(),
    verdict: VerdictSchema,
    issues_count: z.number().int().nonnegative(),
    error: z.string(),
    error_kind: z.enum(['rate_limit', 'parse', 'other']),
  }),
  z.object({
    ...Common,
    status: z.literal('errored'),
    finished_at: z.string().datetime(),
    session_id: z.string().nullable(),
    replay_url: z.string().url().nullable(),
    ranForMs: z.number(),
    verdict: VerdictSchema,
    error: z.string(),
  }),
  z.object({
    ...Common,
    status: z.literal('not_started'),
    finished_at: z.string().datetime(),
    session_id: z.string().nullable(),
    replay_url: z.string().url().nullable(),
    verdict: VerdictSchema,
    reason: z.string(),
  }),
  z.object({
    ...Common,
    status: z.literal('aborted'),
    finished_at: z.string().datetime(),
    session_id: z.string().nullable(),
    replay_url: z.string().url().nullable(),
    ranForMs: z.number(),
    verdict: VerdictSchema,
  }),
]);

export type ReportFrontMatter = z.infer<typeof ReportFrontMatterSchema>;

// Type-level exhaustiveness guard — adding a new RunStatus variant must
// also add the corresponding ReportFrontMatterSchema variant. Mirrors the
// guard in lib/types.ts for the RunStatus union.
import type { RunStatus } from '../types.js';
type _ReportFrontMatterExhaustivenessCheck = Exclude<
  RunStatus['kind'],
  ReportFrontMatter['status']
> extends never
  ? true
  : { error: 'ReportFrontMatterSchema missing a status variant from RunStatus' };
const _reportFrontMatterOk: _ReportFrontMatterExhaustivenessCheck = true;
void _reportFrontMatterOk;

// Body sections live as markdown content — Review rendered inline; the
// front matter has only `verdict` + `issues_count` for `monkey runs`'
// row display. The actual Review object is persisted as a fenced JSON
// block in the body for human inspection.
