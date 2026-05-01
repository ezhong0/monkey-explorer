// Deterministic-finding lifter. Promotes oracle-backed signals from the
// observe stream (console errors + first-party 4xx/5xx network failures)
// into Findings that don't require any LLM judgment.
//
// These findings tier as `verified` because the page (or its server) IS
// the oracle: a JS exception said something failed; a 4xx/5xx response
// IS a server-side error.
//
// Naming convention for stepIds emitted here: `step_event_NNNN` so they
// don't collide with action-step IDs (`step_NNNN`). The adjudicator can
// cite either form.

import type { ConsoleEvent, Finding, NetworkFailure, Provenance } from '../types.js';

function eventStepId(prefix: 'console' | 'network', index: number): string {
  return `step_${prefix}_${String(index).padStart(4, '0')}`;
}

function severityForStatus(status: number | undefined, failure: string | undefined): Finding['severity'] {
  if (status != null) {
    if (status >= 500) return 'high';     // server errors
    if (status === 429) return 'medium';  // rate limit on first-party
    if (status >= 400) return 'medium';   // client errors on first-party are worth flagging
    return 'observation';
  }
  if (failure) return 'high';             // net::ERR_* — request didn't even land
  return 'observation';
}

export function liftConsoleError(event: ConsoleEvent, index: number): Finding {
  const stepId = eventStepId('console', index);
  const provenance: Provenance[] = [{ stepId, evidenceType: 'console' }];
  const sourceLine = event.source ? ` at ${event.source.url}:${event.source.line}` : '';
  return {
    severity: event.level === 'error' ? 'high' : 'low',
    summary: `Console ${event.level}: ${event.message.slice(0, 100)}${event.message.length > 100 ? '…' : ''}`,
    details: `Console ${event.level} captured during the mission${sourceLine}.\n\nFull message:\n${event.message}`,
    provenance,
    tier: 'verified',
  };
}

export function liftNetworkFailure(event: NetworkFailure, index: number): Finding {
  const stepId = eventStepId('network', index);
  const provenance: Provenance[] = [{ stepId, evidenceType: 'network' }];
  const statusOrFailure = event.status != null ? String(event.status) : event.failure ?? 'failed';
  return {
    severity: severityForStatus(event.status, event.failure),
    summary: `Network ${statusOrFailure}: ${event.method} ${event.url}`,
    details: `First-party network request failed during the mission.\n\n${event.method} ${event.url}\nStatus: ${event.status ?? '(no response)'}\nFailure: ${event.failure ?? '(none)'}\nTimestamp: ${event.timestamp}`,
    provenance,
    tier: 'verified',
  };
}

export interface LifterInput {
  consoleErrors: ConsoleEvent[];
  networkFailures: NetworkFailure[];
}

export interface LifterOutput {
  findings: Finding[];
  /** stepIds the lifter introduced — adjudicator's prompt should know about
   *  these so it doesn't re-derive the same findings. */
  introducedStepIds: string[];
}

export function liftDeterministicFindings(input: LifterInput): LifterOutput {
  const findings: Finding[] = [];
  const introducedStepIds: string[] = [];

  input.consoleErrors.forEach((evt, i) => {
    const f = liftConsoleError(evt, i);
    findings.push(f);
    if (f.provenance) introducedStepIds.push(...f.provenance.map((p) => p.stepId));
  });

  input.networkFailures.forEach((evt, i) => {
    const f = liftNetworkFailure(evt, i);
    findings.push(f);
    if (f.provenance) introducedStepIds.push(...f.provenance.map((p) => p.stepId));
  });

  return { findings, introducedStepIds };
}
