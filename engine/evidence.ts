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

/**
 * What the ladder observed about one criterion, before it is stamped with the
 * world it was observed in. Nothing leaves this file in this shape.
 */
type Finding = Omit<Evidence, 'envelopeSha'>;

const HUMAN_OWNED = new Set(['human_review', 'rubric']);

function outcomeFor(criterionId: string, outcomes: GateOutcome[]): GateOutcome | undefined {
  return outcomes.find((entry) => entry.criterionId === criterionId);
}

/**
 * A criterion a person owns still needs an entry, and the flag on it is not the
 * engine's to set — the work source sets those aside for human review whatever
 * this says. The note is what a reviewer reads.
 */
function deferred(criterion: AcceptanceCriterion): Finding {
  return {
    acId: criterion.id,
    passed: true,
    note: `deferred to human review (${criterion.verification})`,
  };
}

function notReached(criterion: AcceptanceCriterion, stoppedAt: string | undefined): Finding {
  const where = stoppedAt ? `the ladder stopped at ${stoppedAt}` : 'the ladder did not run';
  return { acId: criterion.id, passed: false, note: `not evaluated: ${where}` };
}

/**
 * SAFETY: a green rung is not enough on its own; the test the criterion names
 * must also exist. Test runners select by name and report success when the
 * selection is empty — `vitest -t`, `pytest -k` and `rspec -e` all exit zero
 * having run nothing — so a criterion naming a test that was never written
 * produces a passing exit code and evidence that a person would act on. An exit
 * code cannot be persuaded, but it can be asked the wrong question.
 */
function vacuous(criterion: AcceptanceCriterion): Finding {
  return {
    acId: criterion.id,
    passed: false,
    note: `no test named "${criterion.targetTest?.name ?? ''}" exists in ${criterion.targetTest?.file ?? 'the named file'}; a runner that matched nothing exited zero`,
  };
}

function fromOutcome(criterion: AcceptanceCriterion, outcome: GateOutcome, exists: boolean): Finding {
  if (outcome.passed && !exists) return vacuous(criterion);
  const verdict = outcome.passed ? 'passed' : `failed with exit ${outcome.exitCode}`;
  return {
    acId: criterion.id,
    passed: outcome.passed,
    note: `${criterion.targetTest?.name ?? outcome.gateId} ${verdict}`,
  };
}

/** Whether the test a criterion names could be found in the run's worktree. */
export type TestLocator = (criterion: AcceptanceCriterion) => boolean;

function evidenceFor(criterion: AcceptanceCriterion, ladder: LadderResult, locate: TestLocator): Finding {
  if (HUMAN_OWNED.has(criterion.verification)) return deferred(criterion);
  const outcome = outcomeFor(criterion.id, ladder.outcomes);
  if (!outcome) return notReached(criterion, ladder.stoppedAt);
  return fromOutcome(criterion, outcome, locate(criterion));
}

/** Everything one run of the ladder proved, and the world it proved it in. */
export interface EvidenceRequest {
  contract: WorkContract;
  ladder: LadderResult;
  locate: TestLocator;
  envelopeSha: string;
}

/**
 * SAFETY: evidence with no basis on it is refused rather than submitted
 * unstamped. Adjudication treats what arrives as the record, and a record that
 * cannot say which world produced it makes every later comparison — this
 * criterion passed in March and fails now — unanswerable. There is no migration
 * back: the world it ran in is gone by the time anyone notices the gap.
 */
export function evidenceFrom(request: EvidenceRequest): Evidence[] {
  const { contract, ladder, locate, envelopeSha } = request;
  if (!envelopeSha.trim()) throw new Error('refusing to produce evidence that cannot say what it was executed against');
  return contract.acceptance.map((criterion) => ({ ...evidenceFor(criterion, ladder, locate), envelopeSha }));
}
