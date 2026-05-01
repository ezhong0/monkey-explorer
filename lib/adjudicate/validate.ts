// Validation pipeline for adjudicator output.
//
// The adjudicator LLM emits AdjudicatedFinding[] via tool({inputSchema}).
// Zod parsing happens at the tool boundary. AFTER parsing, we still have to:
//   1. Cross-reference each provenance.stepId against the trace's step set.
//   2. Confirm the cited evidenceType actually exists in that step (cited
//      `network` → step has network events; cited `console` → step has
//      console events; cited `observation` → the step IS an observation).
//   3. Partition provenance into valid + invalid entries (don't all-or-nothing).
//   4. Assign tier:
//        - At least one valid oracle-evidence entry → `verified`
//        - Otherwise (only screenshot/observation/dom/diff that don't cross-reference) → `speculative`
//        - Zero valid entries → `speculative` + `validation_failed` populated
// Demote-don't-drop: preserve the model's signal, downgrade trust.

import type { AdjudicatedFinding } from '../findings/schema.js';
import { ORACLE_EVIDENCE_TYPES, type EvidenceType, type Finding, type Provenance, type Tier } from '../types.js';
import type { Trace, TraceStep } from '../trace/schema.js';

function isOracleEvidence(t: EvidenceType): boolean {
  return (ORACLE_EVIDENCE_TYPES as readonly EvidenceType[]).includes(t);
}

function stepHasEvidence(step: TraceStep, type: EvidenceType): boolean {
  switch (type) {
    case 'console':
      return step.type === 'action' && step.consoleEvents.length > 0;
    case 'network':
      return step.type === 'action' && step.networkEvents.length > 0;
    case 'observation':
      return step.type === 'observation';
    case 'screenshot':
    case 'dom':
    case 'diff':
      // V1 trace doesn't capture per-step screenshots, DOM snapshots, or
      // baseline diffs. Citations against these types fail cross-reference;
      // the finding gets demoted to speculative with validation_failed.
      return false;
  }
}

/** Lifter-introduced stepIds (e.g. step_console_NNNN, step_network_NNNN)
 *  exist as provenance targets without corresponding trace steps. They're
 *  always valid for their declared evidence type by construction. */
function isLifterStepId(stepId: string): EvidenceType | null {
  if (stepId.startsWith('step_console_')) return 'console';
  if (stepId.startsWith('step_network_')) return 'network';
  return null;
}

interface ValidatedProvenance {
  valid: Provenance[];
  invalid: Array<{ entry: Provenance; reason: string }>;
}

function validateProvenance(
  raw: Provenance[],
  trace: Trace,
  lifterStepIds: ReadonlySet<string>,
): ValidatedProvenance {
  const stepById = new Map(trace.steps.map((s) => [s.id, s] as const));
  const valid: Provenance[] = [];
  const invalid: ValidatedProvenance['invalid'] = [];

  for (const p of raw) {
    // Lifter stepIds: validate against their declared type
    const lifterType = isLifterStepId(p.stepId);
    if (lifterType !== null) {
      if (!lifterStepIds.has(p.stepId)) {
        invalid.push({ entry: p, reason: `unknown lifter stepId: ${p.stepId}` });
        continue;
      }
      if (p.evidenceType !== lifterType) {
        invalid.push({
          entry: p,
          reason: `lifter stepId ${p.stepId} is type '${lifterType}', not '${p.evidenceType}'`,
        });
        continue;
      }
      valid.push(p);
      continue;
    }

    // Trace stepIds: must be in the trace's step set
    const step = stepById.get(p.stepId);
    if (!step) {
      invalid.push({ entry: p, reason: `unknown stepId: ${p.stepId}` });
      continue;
    }
    if (!stepHasEvidence(step, p.evidenceType)) {
      invalid.push({
        entry: p,
        reason: `step ${p.stepId} has no ${p.evidenceType} evidence`,
      });
      continue;
    }
    valid.push(p);
  }

  return { valid, invalid };
}

function pickTier(valid: Provenance[]): Tier {
  return valid.some((p) => isOracleEvidence(p.evidenceType)) ? 'verified' : 'speculative';
}

/** Run the validation pipeline against one adjudicator finding.
 *  Returns the persistable Finding (with tier + maybe validation_failed). */
export function validateAndTier(
  raw: AdjudicatedFinding,
  trace: Trace,
  lifterStepIds: ReadonlySet<string>,
): Finding {
  const { valid, invalid } = validateProvenance(raw.provenance, trace, lifterStepIds);

  if (valid.length === 0) {
    return {
      severity: raw.severity,
      summary: raw.summary,
      details: raw.details,
      provenance: raw.provenance,
      tier: 'speculative',
      validation_failed: invalid.map((e) => e.reason).join('; ') || 'no valid provenance',
    };
  }

  const validation_failed =
    invalid.length > 0 ? `dropped ${invalid.length} invalid: ${invalid.map((e) => e.reason).join('; ')}` : undefined;

  return {
    severity: raw.severity,
    summary: raw.summary,
    details: raw.details,
    provenance: valid,
    tier: pickTier(valid),
    ...(validation_failed ? { validation_failed } : {}),
  };
}

export function validateAdjudicatedFindings(
  raws: AdjudicatedFinding[],
  trace: Trace,
  lifterStepIds: ReadonlySet<string>,
): Finding[] {
  return raws.map((r) => validateAndTier(r, trace, lifterStepIds));
}
