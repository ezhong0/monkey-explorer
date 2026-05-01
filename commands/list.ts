// `monkey list` — show active + recent runs from the global reports dir.
// Groups by target by default; --target filters.

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { select } from '../lib/prompts/index.js';
import * as log from '../lib/log/stderr.js';
import * as out from '../lib/log/stdout.js';
import { isStdoutTTY } from '../lib/tty/isTTY.js';
import { scanReports, type ReportEntry } from '../lib/report/scan.js';
import { requireGlobalState } from '../lib/state/load.js';
import { getReportsBaseDir, getReportsDirForTarget } from '../lib/state/path.js';
import { createClient } from '../lib/bb/client.js';
import { readFile } from 'node:fs/promises';

interface DisplayEntry {
  filePath: string;
  startedAt: string;
  status: string;
  mission: string;
  durationMs: number | null;
  findingsCount: number | null;
  liveViewUrl: string | null;
  replayUrl: string | null;
  isOrphan: boolean;
  targetName: string;
}

function parseSinceFlag(s: string | undefined): number {
  if (!s) return 24 * 60 * 60 * 1000;
  const m = s.match(/^(\d+)([hdm])$/);
  if (!m) {
    log.warn(`Invalid --since "${s}" — expected e.g. "1h", "7d", "30m". Defaulting to 24h.`);
    return 24 * 60 * 60 * 1000;
  }
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === 'h') return n * 60 * 60 * 1000;
  if (unit === 'd') return n * 24 * 60 * 60 * 1000;
  if (unit === 'm') return n * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  const rs = s % 60;
  return `${mins}m ${rs}s`;
}

function fmtTime(iso: string): string {
  return iso.slice(11, 16);
}

function statusIcon(status: string): string {
  switch (status) {
    case 'completed': return '✓';
    case 'errored':
    case 'extract_failed':
    case 'not_started': return '✗';
    case 'timed_out':
    case 'aborted':
    case 'exceeded_tokens':
    case 'interrupted': return '⚠';
    default: return ' ';
  }
}

export async function runList(opts: {
  targetFilter: string | undefined;
  since: string | undefined;
}): Promise<number> {
  const state = await requireGlobalState();
  const reportsBaseDir = getReportsBaseDir();
  const sinceMs = parseSinceFlag(opts.since);
  const cutoff = Date.now() - sinceMs;

  // Determine which target dirs to scan.
  let targetNames: string[];
  if (opts.targetFilter) {
    if (!state.targets[opts.targetFilter]) {
      log.fail(`Target "${opts.targetFilter}" not found.`);
      return 1;
    }
    targetNames = [opts.targetFilter];
  } else {
    if (!existsSync(reportsBaseDir)) {
      log.info('No monkey runs found in the time window.');
      return 0;
    }
    targetNames = (await readdir(reportsBaseDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  // Collect reports across all relevant target dirs.
  const all: Array<ReportEntry & { targetName: string }> = [];
  for (const targetName of targetNames) {
    const dir = getReportsDirForTarget(targetName);
    if (!existsSync(dir)) continue;
    const entries = await scanReports(dir);
    for (const e of entries) all.push({ ...e, targetName });
  }

  const filtered = all.filter(
    (r) => new Date(r.frontMatter.started_at).getTime() >= cutoff,
  );

  if (filtered.length === 0) {
    log.info('No monkey runs found in the time window.');
    log.info(`  Try \`monkey list --since 7d\` for an older window.`);
    return 0;
  }

  const display: DisplayEntry[] = await Promise.all(
    filtered.map(async (e) => buildDisplayEntry(state.credentials!.browserbaseApiKey, e)),
  );

  if (isStdoutTTY()) {
    return await renderInteractive(display);
  } else {
    renderStatic(display);
    return 0;
  }
}

async function buildDisplayEntry(
  bbKey: string,
  e: ReportEntry & { targetName: string },
): Promise<DisplayEntry> {
  const fm = e.frontMatter;
  const base: DisplayEntry = {
    filePath: e.filePath,
    startedAt: fm.started_at,
    status: fm.status,
    mission: fm.mission,
    durationMs: null,
    findingsCount: null,
    liveViewUrl: null,
    replayUrl: null,
    isOrphan: false,
    targetName: e.targetName,
  };

  if (fm.status !== 'running' && fm.status !== 'not_started' && 'finished_at' in fm) {
    base.durationMs = new Date(fm.finished_at).getTime() - new Date(fm.started_at).getTime();
  }
  if ('findings_count' in fm) base.findingsCount = fm.findings_count;
  if ('replay_url' in fm) base.replayUrl = fm.replay_url;

  if (fm.status === 'running' && fm.session_id) {
    try {
      const bb = createClient(bbKey);
      const sess = await bb.sessions.retrieve(fm.session_id);
      const sessStatus = (sess as { status?: string }).status;
      if (sessStatus && sessStatus !== 'RUNNING') {
        base.status = 'interrupted';
        base.isOrphan = true;
      } else {
        try {
          const debug = await bb.sessions.debug(fm.session_id);
          base.liveViewUrl = debug.debuggerFullscreenUrl ?? debug.debuggerUrl ?? null;
        } catch {
          // Live view URL is enrichment; ignore failure
        }
        base.durationMs = Date.now() - new Date(fm.started_at).getTime();
      }
    } catch {
      // BB unreachable — show as running per file
    }
  }
  return base;
}

function renderStatic(entries: DisplayEntry[]): void {
  const active = entries.filter((e) => e.status === 'running');
  const recent = entries.filter((e) => e.status !== 'running');

  if (active.length > 0) {
    out.out(`ACTIVE (${active.length}):`);
    for (const e of active) {
      const dur = `[${fmtDuration(e.durationMs)}]`.padEnd(10);
      const url = e.liveViewUrl ?? '';
      out.out(`  ${e.targetName.padEnd(20)} ${dur} ${e.mission}    ${url}`);
    }
  }

  if (recent.length > 0) {
    out.out(`RECENT (${recent.length}):`);
    for (const e of recent) {
      const t = fmtTime(e.startedAt);
      const icon = statusIcon(e.status);
      const dur = fmtDuration(e.durationMs).padEnd(8);
      const findings = e.findingsCount != null ? `${e.findingsCount} findings`.padEnd(12) : ' '.repeat(12);
      const url = e.replayUrl ?? '';
      out.out(`  ${t}  ${icon}  ${e.targetName.padEnd(20)} ${e.mission}  ${dur}  ${findings}  ${url}`);
    }
  }
}

async function renderInteractive(entries: DisplayEntry[]): Promise<number> {
  const choices = entries.map((e, i) => {
    const t = fmtTime(e.startedAt);
    const icon = statusIcon(e.status);
    const dur = fmtDuration(e.durationMs).padEnd(8);
    const findings = e.findingsCount != null ? `${e.findingsCount} findings` : '';
    const label = `${t}  ${icon}  ${e.targetName.padEnd(20)} ${e.mission}  ${dur}  ${findings}`;
    return { name: label, value: i };
  });

  let chosen: number;
  try {
    chosen = await select({
      message: 'Select a run (esc to exit):',
      choices,
    });
  } catch {
    return 0;
  }

  const entry = entries[chosen];
  if (entry.liveViewUrl) {
    log.info(`Opening live view: ${entry.liveViewUrl}`);
    tryOpenInBrowser(entry.liveViewUrl);
    return 0;
  }

  const text = await readFile(entry.filePath, 'utf-8').catch(() => '');
  out.outRaw(text);
  return 0;
}

function tryOpenInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // Fall through; URL was logged
  }
}

// Avoid unused-symbol warnings.
void join;
