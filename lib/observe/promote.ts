// Deterministic-issue lifter. Promotes oracle-backed signals from the
// observe stream (console errors + first-party 4xx/5xx network failures)
// into Issues that don't require any LLM judgment. These flow into the
// adjudicator as INPUT — the adjudicator must include critical/high
// lifter Issues in its Review (enforced by validator).
//
// StepId namespace: `step_console_NNNN` for console events,
// `step_network_NNNN` for network events. Distinct from trace action
// steps (`step_NNNN`) so cross-references can disambiguate. The Review
// schema's StepCite regex enforces both shapes.

import type { ConsoleEvent, NetworkFailure } from '../types.js';
import type { Issue, Severity, StepCite } from '../review/schema.js';

function eventStepId(prefix: 'console' | 'network', index: number): string {
  return `step_${prefix}_${String(index).padStart(4, '0')}`;
}

function severityForStatus(status: number | undefined, failure: string | undefined): Severity {
  if (status != null) {
    if (status >= 500) return 'high';     // server errors
    if (status === 429) return 'medium';  // rate limit on first-party
    if (status >= 400) return 'medium';   // client errors on first-party
    return 'observation';
  }
  if (failure) return 'high';             // net::ERR_* — request didn't even land
  return 'observation';
}

export function liftConsoleError(event: ConsoleEvent, index: number): Issue {
  const stepId = eventStepId('console', index);
  const cites: StepCite[] = [{ stepId, evidenceType: 'console' }];
  const sourceLine = event.source ? ` at ${event.source.url}:${event.source.line}` : '';
  return {
    source: 'lifter',
    severity: event.level === 'error' ? 'high' : 'low',
    summary: `Console ${event.level}: ${event.message.slice(0, 100)}${event.message.length > 100 ? '…' : ''}`,
    details: `Console ${event.level} captured during the mission${sourceLine}.\n\nFull message:\n${event.message}`,
    cites,
  };
}

export function liftNetworkFailure(event: NetworkFailure, index: number): Issue {
  const stepId = eventStepId('network', index);
  const cites: StepCite[] = [{ stepId, evidenceType: 'network' }];
  const statusOrFailure = event.status != null ? String(event.status) : event.failure ?? 'failed';
  return {
    source: 'lifter',
    severity: severityForStatus(event.status, event.failure),
    summary: `Network ${statusOrFailure}: ${event.method} ${event.url}`,
    details: `First-party network request failed during the mission.\n\n${event.method} ${event.url}\nStatus: ${event.status ?? '(no response)'}\nFailure: ${event.failure ?? '(none)'}\nTimestamp: ${event.timestamp}`,
    cites,
  };
}

export interface LifterInput {
  consoleErrors: ConsoleEvent[];
  networkFailures: NetworkFailure[];
}

export function liftDeterministicIssues(input: LifterInput): { issues: Issue[] } {
  const issues: Issue[] = [
    ...input.consoleErrors.map(liftConsoleError),
    ...input.networkFailures.map(liftNetworkFailure),
  ];
  return { issues };
}
