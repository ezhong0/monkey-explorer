// Fetch + filter Browserbase session logs into our ConsoleEvent[] +
// NetworkFailure[] types.
//
// Why this approach (vs Page event listeners):
// Stagehand v3's Page is a CDP-based wrapper, not Playwright's Page. It
// doesn't expose `.on('console' / 'response' / etc.)`. Instead, Browserbase
// captures the full CDP trace server-side and exposes it via
// `bb.sessions.logs.list(id)` — we fetch + filter at end of mission.
//
// Trade-off: events arrive after the mission finishes (not streaming), but
// for the agentic-loop use case the consumer (Claude / a script) reads the
// final JSON anyway.

import { sanitizeText } from '../findings/sanitize.js';
import * as logStderr from '../log/stderr.js';
import type { Browserbase } from '../bb/client.js';
import type { ConsoleEvent, NetworkFailure } from '../types.js';

const MAX_EVENTS = 50;

interface SessionLog {
  method: string;
  timestamp: number;
  request?: { params: Record<string, unknown>; timestamp: number };
  response?: { result: Record<string, unknown>; timestamp: number };
}

export interface CollectedEvents {
  consoleErrors: ConsoleEvent[];
  networkFailures: NetworkFailure[];
}

export async function fetchSessionEvents(opts: {
  bb: Browserbase;
  sessionId: string;
  targetOrigin: string;
}): Promise<CollectedEvents> {
  let logs: SessionLog[] = [];
  try {
    const response = await opts.bb.sessions.logs.list(opts.sessionId);
    logs = (response as unknown as SessionLog[]) ?? [];
  } catch {
    // Session may have been released too quickly to have logs available; return empty.
    return { consoleErrors: [], networkFailures: [] };
  }

  const consoleErrors: ConsoleEvent[] = [];
  const networkFailures: NetworkFailure[] = [];
  let consoleDropped = 0;
  let networkDropped = 0;

  for (const log of logs) {
    switch (log.method) {
      case 'Runtime.consoleAPICalled': {
        const event = parseConsoleApiCalled(log, opts.targetOrigin);
        if (!event) break;
        if (consoleErrors.length < MAX_EVENTS) consoleErrors.push(event);
        else consoleDropped++;
        break;
      }
      case 'Runtime.exceptionThrown': {
        const event = parseExceptionThrown(log, opts.targetOrigin);
        if (!event) break;
        if (consoleErrors.length < MAX_EVENTS) consoleErrors.push(event);
        else consoleDropped++;
        break;
      }
      case 'Network.responseReceived': {
        const event = parseResponseReceived(log, opts.targetOrigin);
        if (!event) break;
        if (networkFailures.length < MAX_EVENTS) networkFailures.push(event);
        else networkDropped++;
        break;
      }
      case 'Network.loadingFailed': {
        const event = parseLoadingFailed(log, opts.targetOrigin);
        if (!event) break;
        if (networkFailures.length < MAX_EVENTS) networkFailures.push(event);
        else networkDropped++;
        break;
      }
    }
  }

  if (consoleDropped > 0) {
    logStderr.warn(
      `fetchSessionEvents: capped console errors at ${MAX_EVENTS}; ${consoleDropped} additional event(s) dropped. Findings may be incomplete.`,
    );
  }
  if (networkDropped > 0) {
    logStderr.warn(
      `fetchSessionEvents: capped network failures at ${MAX_EVENTS}; ${networkDropped} additional event(s) dropped. Findings may be incomplete.`,
    );
  }

  return { consoleErrors, networkFailures };
}

function safeIsoFromMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return new Date().toISOString();
  try {
    return new Date(ms).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function isFirstParty(url: string | undefined, targetOrigin: string): boolean {
  if (!url) return true;
  try {
    return new URL(url).origin === targetOrigin;
  } catch {
    return false;
  }
}

// Known noise-source hosts. Errors thrown from these origins are infrastructure
// noise (Vercel preview toolbar, analytics, ads) and not bugs in the target app.
// Even when surfaced through a first-party page, these errors come from
// third-party scripts/iframes and aren't actionable for the user testing
// their app.
const NOISE_HOSTS = [
  'vercel.live',
  'vercel.com',
  'vercel-insights.com',
  'googletagmanager.com',
  'google-analytics.com',
  'doubleclick.net',
  'fullstory.com',
  'sentry.io',
  'datadoghq.com',
  'segment.io',
  'mixpanel.com',
  'hotjar.com',
  'posthog.com',
  'launchdarkly.com',
];

function isFromNoiseSource(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return NOISE_HOSTS.some((n) => host === n || host.endsWith(`.${n}`));
  } catch {
    return false;
  }
}

interface ConsoleAPICalledParams {
  type?: string;
  args?: Array<{ value?: unknown; description?: string }>;
  stackTrace?: { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }> };
}

function parseConsoleApiCalled(log: SessionLog, targetOrigin: string): ConsoleEvent | null {
  const p = (log.request?.params ?? log.response?.result ?? {}) as ConsoleAPICalledParams;
  const t = p.type;
  if (t !== 'error' && t !== 'warning') return null;

  const message = (p.args ?? [])
    .map((a) => (typeof a.value === 'string' ? a.value : a.description ?? JSON.stringify(a.value)))
    .filter(Boolean)
    .join(' ');
  if (!message) return null;

  const topFrame = p.stackTrace?.callFrames?.[0];
  // Drop if top frame is from a known noise source (Vercel toolbar iframe,
  // analytics, etc.) — even when surfaced through the page, these aren't
  // bugs the user testing their app cares about.
  if (topFrame && isFromNoiseSource(topFrame.url)) return null;
  // Only keep events whose top frame is genuinely first-party.
  if (topFrame && !isFirstParty(topFrame.url, targetOrigin)) return null;

  return {
    level: t === 'warning' ? 'warn' : 'error',
    message: sanitizeText(message),
    source: topFrame
      ? { url: topFrame.url, line: topFrame.lineNumber, column: topFrame.columnNumber }
      : undefined,
    timestamp: safeIsoFromMs(log.timestamp),
  };
}

interface ExceptionThrownParams {
  exceptionDetails?: {
    text?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    exception?: { description?: string };
  };
}

function parseExceptionThrown(log: SessionLog, targetOrigin: string): ConsoleEvent | null {
  const p = (log.request?.params ?? log.response?.result ?? {}) as ExceptionThrownParams;
  const ex = p.exceptionDetails;
  if (!ex) return null;
  // Drop noise-source exceptions (Vercel toolbar, analytics).
  if (ex.url && isFromNoiseSource(ex.url)) return null;
  // Drop third-party exceptions in general.
  if (ex.url && !isFirstParty(ex.url, targetOrigin)) return null;
  const message = sanitizeText(
    (ex.exception?.description ?? ex.text ?? 'unknown exception').toString(),
  );
  return {
    level: 'error',
    message,
    source: ex.url
      ? {
          url: ex.url,
          line: ex.lineNumber ?? 0,
          column: ex.columnNumber ?? 0,
        }
      : undefined,
    timestamp: safeIsoFromMs(log.timestamp),
  };
}

interface ResponseReceivedParams {
  response?: { url?: string; status?: number };
  request?: { method?: string };
}

function parseResponseReceived(log: SessionLog, targetOrigin: string): NetworkFailure | null {
  const p = (log.request?.params ?? log.response?.result ?? {}) as ResponseReceivedParams;
  const r = p.response;
  if (!r) return null;
  if (typeof r.status !== 'number' || r.status < 400) return null;
  if (!isFirstParty(r.url, targetOrigin)) return null;
  return {
    url: sanitizeText(r.url ?? ''),
    method: p.request?.method ?? 'GET',
    status: r.status,
    timestamp: safeIsoFromMs(log.timestamp),
  };
}

interface LoadingFailedParams {
  errorText?: string;
  type?: string;
}

function parseLoadingFailed(log: SessionLog, _targetOrigin: string): NetworkFailure | null {
  void _targetOrigin;
  const p = (log.request?.params ?? log.response?.result ?? {}) as LoadingFailedParams;
  const error = p.errorText ?? p.type ?? 'failed';
  // Skip benign noise that fires when the session closes / page navigates away.
  // ERR_ABORTED in particular happens at every session shutdown.
  if (/ERR_ABORTED|net::ERR_FAILED$/i.test(error)) return null;
  return {
    url: '(unknown — see replay)',
    method: 'UNKNOWN',
    failure: error,
    timestamp: safeIsoFromMs(log.timestamp),
  };
}
