// Renders a report's markdown body from its front matter + Review.
// Review comes pre-sanitized via review/sanitize.

import type { ConsoleEvent, NetworkFailure, RunStatus } from '../types.js';
import { sortIssues, type Verdict } from '../review/schema.js';
import type { ReportFrontMatter } from '../report/schema.js';

const RENDERED_EVENT_LIMIT = 10;

const VERDICT_BADGE: Record<Verdict, string> = {
  works: '✓ works',
  broken: '✗ broken',
  partial: '◐ partial',
  unclear: '? unclear',
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: '🔴 critical',
  high: '🟠 high',
  medium: '🟡 medium',
  low: '🟢 low',
  observation: '⚪ observation',
};

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
    '_Review will appear here after the run completes._',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function renderTerminalReport(opts: {
  fm: ReportFrontMatter;
  status: RunStatus;
  consoleErrors?: ConsoleEvent[];
  networkFailures?: NetworkFailure[];
  costSummary?: string;
}): string {
  const { fm, status, costSummary } = opts;
  const consoleErrors = opts.consoleErrors ?? [];
  const networkFailures = opts.networkFailures ?? [];
  const review = 'review' in status ? status.review : null;

  const lines: string[] = [
    renderFrontMatter(fm),
    '',
    `# Monkey Run — ${fm.started_at}`,
    '',
    `**Target:** ${fm.target_url}`,
    `**Mission:** ${fm.mission}`,
    `**Status:** ${status.kind}`,
  ];

  if (review) {
    lines.push(`**Verdict:** ${VERDICT_BADGE[review.verdict]}`);
    if (review.diagnostic) {
      lines.push(`**Diagnostic:** \`${review.diagnostic}\``);
    }
  }

  if (
    fm.status !== 'running' &&
    fm.status !== 'not_started' &&
    'finished_at' in fm
  ) {
    const ranForMs = (fm as unknown as { ranForMs?: number }).ranForMs;
    if (ranForMs != null) lines.push(`**Duration:** ${fmtDuration(ranForMs)}`);
  }

  if ('replay_url' in fm && fm.replay_url) {
    lines.push(`**Replay:** ${fm.replay_url}`);
  }

  lines.push('');

  if (review) {
    lines.push('## Summary');
    lines.push('');
    lines.push(review.summary);
    lines.push('');

    if (review.tested.length > 0) {
      lines.push('## Tested');
      lines.push('');
      for (const t of review.tested) lines.push(`- ${t}`);
      lines.push('');
    }

    if (review.worked.length > 0) {
      lines.push('## Worked');
      lines.push('');
      for (const w of review.worked) lines.push(`- ${w}`);
      lines.push('');
    }

    if (review.issues.length > 0) {
      lines.push(`## Issues (${review.issues.length})`);
      lines.push('');
      const sorted = sortIssues(review.issues);
      sorted.forEach((issue, i) => {
        const badge = SEVERITY_BADGE[issue.severity] ?? issue.severity;
        lines.push(`### ${i + 1}. ${badge} — ${issue.summary}`);
        lines.push('');
        lines.push(`_Source:_ \`${issue.source}\``);
        lines.push('');
        lines.push(issue.details);
        if (issue.cites.length > 0) {
          const provLine = issue.cites
            .map((c) => `\`${c.stepId}\` (${c.evidenceType})`)
            .join(', ');
          lines.push('');
          lines.push(`_Evidence:_ ${provLine}`);
        }
        lines.push('');
      });
    }

    if (review.suggestions.length > 0) {
      lines.push('## Suggestions');
      lines.push('');
      for (const s of review.suggestions) lines.push(`- ${s}`);
      lines.push('');
    }

    // Embedded review JSON (machine-readable for re-render / replay).
    lines.push('## Review (raw)');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify({ review }, null, 2));
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
    lines.push('## Cost');
    lines.push('');
    lines.push(costSummary);
    lines.push('');
  }

  return lines.join('\n');
}
