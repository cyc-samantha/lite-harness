/**
 * Turning what the ladder observed into what the work source adjudicates.
 *
 * The passed flag on a criterion is the exit code of the test the contract named
 * for it — never a model's account of how the work went. That substitution is the
 * whole reason this layer produces evidence instead of a report: an exit code
 * cannot be persuaded.
 *
 * Adjudication needs exactly one entry per sealed criterion. A gap reads as
 * unfinished work and a duplicate reads as an ambiguous result, so criteria the
 * ladder never reached still get an entry saying so.
 */
import type { AcceptanceCriterion, Evidence, WorkContract } from '../ports/work-source.ts';

import type { GateOutcome, LadderResult } from './gates.ts';

const HUMAN_OWNED = new Set(['human_review', 'rubric']);

function outcomeFor(criterionId: string, outcomes: GateOutcome[]): GateOutcome | undefined {
  return outcomes.find((entry) => entry.criterionId === criterionId);
}

/**
 * A criterion a person owns still needs an entry, and the flag on it is not the
 * engine's to set — the work source sets those aside for human review whatever
 * this says. The note is what a reviewer reads.
 */
function deferred(criterion: AcceptanceCriterion): Evidence {
  return {
    acId: criterion.id,
    passed: true,
    note: `deferred to human review (${criterion.verification})`,
  };
}

function notReached(criterion: AcceptanceCriterion, stoppedAt: string | undefined): Evidence {
  const where = stoppedAt ? `the ladder stopped at ${stoppedAt}` : 'the ladder did not run';
  return { acId: criterion.id, passed: false, note: `not evaluated: ${where}` };
}

function fromOutcome(criterion: AcceptanceCriterion, outcome: GateOutcome): Evidence {
  const verdict = outcome.passed ? 'passed' : `failed with exit ${outcome.exitCode}`;
  return {
    acId: criterion.id,
    passed: outcome.passed,
    note: `${criterion.targetTest?.name ?? outcome.gateId} ${verdict}`,
  };
}

function evidenceFor(criterion: AcceptanceCriterion, ladder: LadderResult): Evidence {
  if (HUMAN_OWNED.has(criterion.verification)) return deferred(criterion);
  const outcome = outcomeFor(criterion.id, ladder.outcomes);
  return outcome ? fromOutcome(criterion, outcome) : notReached(criterion, ladder.stoppedAt);
}

export function evidenceFrom(contract: WorkContract, ladder: LadderResult): Evidence[] {
  return contract.acceptance.map((criterion) => evidenceFor(criterion, ladder));
}
