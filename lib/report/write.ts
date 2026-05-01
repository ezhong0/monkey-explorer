// Atomic write of report files. POSIX rename is atomic; readers (including
// concurrent `monkey list` runs) see either the old content or the new,
// never partial.
//
// Edge cases addressed:
// - SIGINT during write leaves an orphan .tmp file → swept at run start
//   (sweepStaleTmpFiles).
// - Reports directory may not exist on first run → mkdir({ recursive: true })
//   in writeReportInitial.

import { mkdir, rename, writeFile, readdir, stat, unlink, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPORT_SCHEMA_VERSION as CURRENT_SCHEMA_VERSION } from './schema.js';
import { sanitizeText } from '../findings/sanitize.js';
import { renderRunningReport, renderTerminalReport } from './render.js';
import { reportFilename, reportPath, tmpPath } from './paths.js';
import { ReportFrontMatterSchema, type ReportFrontMatter } from './schema.js';
import type { ConsoleEvent, Finding, NetworkFailure, RunStatus } from '../types.js';

export interface InitialReport {
  filePath: string;
  frontMatter: ReportFrontMatter;
}

export async function writeReportInitial(opts: {
  reportsDir: string;
  startedAt: Date;
  target: string;
  mission: string;
  sessionId: string;
  liveViewUrl: string | null;
  replayUrl: string | null;
}): Promise<InitialReport> {
  // Defensive mkdir: handles first-run + user-deletion of reports/ between runs.
  await mkdir(opts.reportsDir, { recursive: true });

  const filename = reportFilename(opts.startedAt, opts.sessionId);
  const filePath = reportPath(opts.reportsDir, filename);

  const fm: ReportFrontMatter = {
    $schema_version: CURRENT_SCHEMA_VERSION,
    status: 'running',
    started_at: opts.startedAt.toISOString(),
    target_url: opts.target,
    mission: opts.mission,
    session_id: opts.sessionId,
    live_view_url: opts.liveViewUrl,
    replay_url: opts.replayUrl,
  } as ReportFrontMatter;

  // Validate before writing — surface schema bugs early, not at read time.
  ReportFrontMatterSchema.parse(fm);

  const content = renderRunningReport(fm);
  await atomicWrite(filePath, content);
  return { filePath, frontMatter: fm };
}

// Update an in-flight report to a terminal status. Sanitizes findings + error.
export async function writeReportTerminal(opts: {
  filePath: string;
  initialFm: ReportFrontMatter;
  status: RunStatus;
  findings: Finding[];
  consoleErrors?: ConsoleEvent[];
  networkFailures?: NetworkFailure[];
  finishedAt: Date;
  costSummary?: string;
  sessionId: string;
  replayUrl: string;
}): Promise<void> {
  const sanitizedFindings = opts.findings.map((f) => ({
    ...f,
    summary: sanitizeText(f.summary),
    details: sanitizeText(f.details),
  }));

  const fm: ReportFrontMatter = buildTerminalFrontMatter({
    initialFm: opts.initialFm,
    status: opts.status,
    finishedAt: opts.finishedAt,
    sessionId: opts.sessionId,
    replayUrl: opts.replayUrl,
    findingsCount: sanitizedFindings.length,
  });
  ReportFrontMatterSchema.parse(fm);

  const content = renderTerminalReport({
    fm,
    status: opts.status,
    findings: sanitizedFindings,
    consoleErrors: opts.consoleErrors,
    networkFailures: opts.networkFailures,
    costSummary: opts.costSummary,
  });
  await atomicWrite(opts.filePath, content);
}

function buildTerminalFrontMatter(opts: {
  initialFm: ReportFrontMatter;
  status: RunStatus;
  finishedAt: Date;
  sessionId: string;
  replayUrl: string;
  findingsCount: number;
}): ReportFrontMatter {
  const base = {
    $schema_version: CURRENT_SCHEMA_VERSION,
    started_at: opts.initialFm.started_at,
    target_url: opts.initialFm.target_url,
    mission: opts.initialFm.mission,
    finished_at: opts.finishedAt.toISOString(),
  };

  switch (opts.status.kind) {
    case 'completed':
      return {
        ...base,
        status: 'completed' as const,
        session_id: opts.sessionId,
        replay_url: opts.replayUrl,
        ranForMs: opts.status.ranForMs,
        findings_count: opts.findingsCount,
        tokens_used: opts.status.tokensUsed ?? null,
      };
    case 'timed_out':
      return {
        ...base,
        status: 'timed_out' as const,
        session_id: opts.sessionId,
        replay_url: opts.replayUrl,
        ranForMs: opts.status.ranForMs,
        findings_count: opts.findingsCount,
      };
    case 'exceeded_tokens':
      return {
        ...base,
        status: 'exceeded_tokens' as const,
        session_id: opts.sessionId,
        replay_url: opts.replayUrl,
        ranForMs: opts.status.ranForMs,
        findings_count: opts.findingsCount,
      };
    case 'adjudicator_failed':
      return {
        ...base,
        status: 'adjudicator_failed' as const,
        session_id: opts.sessionId,
        replay_url: opts.replayUrl,
        ranForMs: opts.status.ranForMs,
        findings_count: opts.findingsCount,
        error: sanitizeText(opts.status.error),
      };
    case 'errored':
      return {
        ...base,
        status: 'errored' as const,
        session_id: opts.sessionId || null,
        replay_url: opts.replayUrl || null,
        ranForMs: opts.status.ranForMs,
        error: sanitizeText(opts.status.error),
      };
    case 'not_started':
      return {
        ...base,
        status: 'not_started' as const,
        session_id: opts.sessionId || null,
        replay_url: opts.replayUrl || null,
        reason: sanitizeText(opts.status.reason),
      };
    case 'aborted':
      return {
        ...base,
        status: 'aborted' as const,
        session_id: opts.sessionId || null,
        replay_url: opts.replayUrl || null,
        ranForMs: opts.status.ranForMs,
      };
    case 'running':
      throw new Error('buildTerminalFrontMatter called with status running');
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = tmpPath(filePath);
  await writeFile(tmp, content);
  await rename(tmp, filePath);
}

// Cleanup orphan .tmp files from prior crashes / SIGINT-during-write.
export async function sweepStaleTmpFiles(reportsDir: string, olderThanMs: number): Promise<void> {
  if (!existsSync(reportsDir)) return;
  const now = Date.now();
  const entries = await readdir(reportsDir).catch(() => []);
  for (const name of entries) {
    if (!name.endsWith('.tmp')) continue;
    const p = join(reportsDir, name);
    const s = await stat(p).catch(() => null);
    if (!s) continue;
    if (now - s.mtimeMs > olderThanMs) {
      await unlink(p).catch(() => {});
    }
  }
}

// Sweep stale "running" reports from prior kill -9 / process crashes.
// At run start we mutate any report still marked running and older than
// (wallClockMs + 1min) to status: errored.
export async function sweepStaleRunningReports(opts: {
  reportsDir: string;
  wallClockMs: number;
}): Promise<void> {
  if (!existsSync(opts.reportsDir)) return;
  const threshold = Date.now() - (opts.wallClockMs + 60_000);
  const entries = await readdir(opts.reportsDir).catch(() => []);
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const filePath = join(opts.reportsDir, name);
    const s = await stat(filePath).catch(() => null);
    if (!s) continue;
    if (s.mtimeMs > threshold) continue;
    // Old file — peek at front matter
    let text: string;
    try {
      text = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    if (!/^status:\s*"running"/m.test(text)) continue;
    // Mutate to errored. Best-effort; don't crash on parse failure.
    try {
      const fm = parseFrontMatterRaw(text);
      if (!fm || fm.status !== 'running') continue;
      const finishedAt = new Date(s.mtimeMs).toISOString();
      const newFm: ReportFrontMatter = {
        $schema_version: CURRENT_SCHEMA_VERSION,
        status: 'errored' as const,
        started_at: fm.started_at as string,
        target_url: fm.target_url as string,
        mission: fm.mission as string,
        finished_at: finishedAt,
        session_id: (fm.session_id as string) || null,
        replay_url: (fm.replay_url as string) || null,
        ranForMs: 0,
        error: 'process crashed before cleanup',
      };
      const newContent = renderTerminalReport({
        fm: newFm,
        status: { kind: 'errored', error: 'process crashed before cleanup', ranForMs: 0 },
        findings: [],
      });
      await atomicWrite(filePath, newContent);
    } catch {
      // Best-effort; swallow.
    }
  }
}

// Best-effort YAML front-matter peek for the orphan-sweep path.
// Production-grade YAML parsing is overkill here; just match key:value lines.
function parseFrontMatterRaw(text: string): Record<string, unknown> | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_$][\w]*)\s*:\s*(.+)$/);
    if (!kv) continue;
    let v: unknown = kv[2].trim();
    if (typeof v === 'string') {
      if (v === 'null') v = null;
      else if (/^".*"$/.test(v)) v = v.slice(1, -1);
      else if (/^\d+$/.test(v)) v = Number(v);
    }
    out[kv[1]] = v;
  }
  return out;
}
