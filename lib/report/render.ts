// Renders a report's markdown body from its front matter + findings.
// Findings come pre-sanitized via lib/findings/sanitize.

import type { ConsoleEvent, Finding, NetworkFailure, RunStatus } from '../types.js';
import type { ReportFrontMatter } from './schema.js';

const RENDERED_EVENT_LIMIT = 10;

const SEVERITY_BADGE: Record<string, string> = {
  critical: '🔴 critical',
  high: '🟠 high',
  medium: '🟡 medium',
  low: '🟢 low',
  observation: '⚪ observation',
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'observation'];

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

function renderFrontMatter(fm: ReportFrontMatter): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v === null || v === undefined) {
      lines.push(`${k}: null`);
    } else if (typeof v === 'string') {
      // Quote strings to handle special chars
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

export function renderRunningReport(fm: ReportFrontMatter): string {
  if (fm.status !== 'running') {
    throw new Error(`renderRunningReport called with status: ${fm.status}`);
  }
  return [
    renderFrontMatter(fm),
    '',
    `# Monkey Run — ${fm.started_at}`,
    '',
    `**Target:** ${fm.target_url}`,
    `**Mission:** ${fm.mission}`,
    `**Status:** running…`,
    fm.live_view_url ? `**Live view:** ${fm.live_view_url}` : '',
    fm.replay_url ? `**Replay (post-run):** ${fm.replay_url}` : '',
    '',
    '_Findings will appear here after the run completes._',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function renderTerminalReport(opts: {
  fm: ReportFrontMatter;
  status: RunStatus;
  findings: Finding[];
  consoleErrors?: ConsoleEvent[];
  networkFailures?: NetworkFailure[];
  costSummary?: string;
}): string {
  const { fm, status, findings, costSummary } = opts;
  const consoleErrors = opts.consoleErrors ?? [];
  const networkFailures = opts.networkFailures ?? [];
  const lines: string[] = [
    renderFrontMatter(fm),
    '',
    `# Monkey Run — ${fm.started_at}`,
    '',
    `**Target:** ${fm.target_url}`,
    `**Mission:** ${fm.mission}`,
    `**Status:** ${status.kind}`,
  ];

  if (fm.status !== 'running' && fm.status !== 'not_started' && 'finished_at' in fm) {
    const ranForMs = (fm as unknown as { ranForMs?: number }).ranForMs;
    if (ranForMs != null) lines.push(`**Duration:** ${fmtDuration(ranForMs)}`);
  }

  if ('replay_url' in fm && fm.replay_url) {
    lines.push(`**Replay:** ${fm.replay_url}`);
  }

  lines.push('');

  // Findings section. Speculative findings (LLM judgments without oracle-
  // backed evidence) are filtered out of the human-readable section by
  // default — they're still in the "Findings (raw)" JSON block at the
  // bottom for completeness, and surfaceable via --include-speculative.
  const verified = findings.filter((f) => f.tier !== 'speculative');
  const speculativeCount = findings.length - verified.length;

  if (verified.length > 0) {
    lines.push('## Findings');
    lines.push('');
    const sorted = [...verified].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );
    sorted.forEach((f, i) => {
      lines.push(`### ${i + 1}. ${SEVERITY_BADGE[f.severity] ?? f.severity} — ${f.summary}`);
      lines.push('');
      lines.push(f.details);
      if (f.provenance && f.provenance.length > 0) {
        const provLine = f.provenance
          .map((p) => `\`${p.stepId}\` (${p.evidenceType})`)
          .join(', ');
        lines.push('');
        lines.push(`_Evidence:_ ${provLine}`);
      }
      lines.push('');
    });
    if (speculativeCount > 0) {
      lines.push(
        `_(${speculativeCount} additional speculative finding${speculativeCount === 1 ? '' : 's'} hidden — pass \`--include-speculative\` to surface.)_`,
      );
      lines.push('');
    }
  } else if (status.kind === 'completed' || status.kind === 'adjudicator_failed') {
    lines.push('## Findings');
    lines.push('');
    if (speculativeCount > 0) {
      lines.push(
        `_No verified findings. ${speculativeCount} speculative finding${speculativeCount === 1 ? '' : 's'} hidden — pass \`--include-speculative\` to surface._`,
      );
    } else {
      lines.push('_No findings._');
    }
    lines.push('');
  }

  // Embedded findings JSON (machine-readable for re-render)
  if (findings.length > 0) {
    lines.push('## Findings (raw)');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify({ findings }, null, 2));
    lines.push('```');
    lines.push('');
  }

  // Error info
  if ('error' in fm && fm.error) {
    lines.push('## Error');
    lines.push('');
    lines.push('```');
    lines.push(fm.error);
    lines.push('```');
    lines.push('');
  }

  if ('reason' in fm && fm.reason) {
    lines.push('## Reason');
    lines.push('');
    lines.push(fm.reason);
    lines.push('');
  }

  // Console errors (filtered + capped during capture)
  if (consoleErrors.length > 0) {
    lines.push(`## Console errors (${consoleErrors.length})`);
    lines.push('');
    consoleErrors.slice(0, RENDERED_EVENT_LIMIT).forEach((e, i) => {
      const src = e.source ? ` at ${e.source.url}:${e.source.line}` : '';
      lines.push(`${i + 1}. \`[${e.level}] ${e.message}\`${src}`);
    });
    if (consoleErrors.length > RENDERED_EVENT_LIMIT) {
      lines.push(`_(${consoleErrors.length - RENDERED_EVENT_LIMIT} more — see --json output for full list.)_`);
    }
    lines.push('');
  }

  // Network failures (4xx/5xx + requestfailed events)
  if (networkFailures.length > 0) {
    lines.push(`## Network failures (${networkFailures.length})`);
    lines.push('');
    networkFailures.slice(0, RENDERED_EVENT_LIMIT).forEach((e, i) => {
      const status = e.status ? `${e.status}` : e.failure ?? 'failed';
      lines.push(`${i + 1}. \`${e.method} ${e.url} → ${status}\``);
    });
    if (networkFailures.length > RENDERED_EVENT_LIMIT) {
      lines.push(`_(${networkFailures.length - RENDERED_EVENT_LIMIT} more — see --json output for full list.)_`);
    }
    lines.push('');
  }

  // Cost summary
  if (costSummary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(costSummary);
    lines.push('');
  }

  return lines.join('\n');
}
