/**
 * Who has to do something next, as four answers and no fifth.
 *
 * This is deliberately not the run's state. A run's lifecycle — claimed,
 * admitted, packed, gates passed, pull request open, submitted — lives in
 * `state.ts` and says where the work got to. What follows says why it stopped
 * and who it is waiting on. Collapsing the two produces a system that can say
 * "RETRYABLE" and cannot say whether that means queued, retrying, or already
 * picked up by somebody else.
 *
 * `origin` is the axis that is easy to leave out and expensive to add later.
 * Without it, a broken ledger, an unprovisioned sandbox and an unreachable work
 * source all arrive as RETRYABLE, and the platform's own failures are invisible
 * inside a number that counts contract failures.
 */
import type { Decision, FailureCategory } from './failure-table.ts';
import type { PreflightCheck, PreflightFailure } from './preflight.ts';

export type FailureClass = 'SPEC_BLOCKED' | 'RETRYABLE' | 'HUMAN_DECISION_REQUIRED' | 'HARD_STOP';

/** Whose fault it is, which is not the same question as who fixes it. */
export type FailureOrigin = 'CONTRACT' | 'EXECUTION' | 'PLATFORM' | 'EXTERNAL';

/**
 * A role, not a person. The engine has no directory and must not invent a name;
 * resolving `NAMED_HUMAN` to somebody is the ledger's job, and it is the ledger
 * that knows who signed the authorisation.
 */
export type NextActor = 'SPEC_AUTHOR' | 'SYSTEM' | 'NAMED_HUMAN' | 'PLATFORM';

export interface Routing {
  failure_class: FailureClass;
  failure_origin: FailureOrigin;
  reason: string;
  next_actor: NextActor;
}

/** The class is the exit code, so a caller that reads nothing else still routes correctly. */
export const EXIT_CODE: Record<FailureClass, number> = {
  RETRYABLE: 2,
  HARD_STOP: 3,
  SPEC_BLOCKED: 4,
  HUMAN_DECISION_REQUIRED: 5,
};

const ACTOR: Record<FailureClass, NextActor> = {
  SPEC_BLOCKED: 'SPEC_AUTHOR',
  RETRYABLE: 'SYSTEM',
  HUMAN_DECISION_REQUIRED: 'NAMED_HUMAN',
  HARD_STOP: 'PLATFORM',
};

type Route = readonly [FailureClass, FailureOrigin];

const BY_CATEGORY: Partial<Record<FailureCategory, Route>> = {
  seal_broken: ['HARD_STOP', 'CONTRACT'],
  budget_exhausted: ['HARD_STOP', 'EXECUTION'],
  scope_violation: ['HARD_STOP', 'EXECUTION'],
  no_progress: ['HARD_STOP', 'EXECUTION'],
  world_moved: ['RETRYABLE', 'EXTERNAL'],
  gate_failure: ['RETRYABLE', 'EXECUTION'],
};

const BY_CHECK: Partial<Record<PreflightCheck, Route>> = {
  contract_shape: ['SPEC_BLOCKED', 'CONTRACT'],
  unevidenceable_criterion: ['SPEC_BLOCKED', 'CONTRACT'],
  scope_resolvable: ['SPEC_BLOCKED', 'CONTRACT'],
  unaccepted_proposal: ['SPEC_BLOCKED', 'CONTRACT'],
  unanswered_decision: ['HUMAN_DECISION_REQUIRED', 'CONTRACT'],
  missing_signature: ['HUMAN_DECISION_REQUIRED', 'CONTRACT'],
  authority: ['HUMAN_DECISION_REQUIRED', 'CONTRACT'],
  dependencies: ['RETRYABLE', 'EXTERNAL'],
  seal_integrity: ['HARD_STOP', 'CONTRACT'],
  protected_path_conflict: ['HARD_STOP', 'CONTRACT'],
  capability_match: ['HARD_STOP', 'PLATFORM'],
  environment_ready: ['HARD_STOP', 'PLATFORM'],
};

/**
 * SAFETY: anything unrecognised routes to a hard stop owned by the platform, not
 * to a retry. A failure nobody classified is a failure nobody understands, and
 * retrying it spends the budget learning nothing while hiding the gap. Sending
 * it to the platform is also the only route that gets the missing case noticed.
 */
const UNCLASSIFIED: Route = ['HARD_STOP', 'PLATFORM'];

function routed(route: Route, reason: string): Routing {
  const [failure_class, failure_origin] = route;
  return { failure_class, failure_origin, reason, next_actor: ACTOR[failure_class] };
}

/**
 * A timed-out command says nothing about the change, so it is the world's
 * problem and free to retry; a command that could not start at all is the
 * machine's, and no number of retries installs it.
 */
function environmentRoute(decision: Decision): Route {
  return decision.action === 'escalate' ? ['HARD_STOP', 'PLATFORM'] : ['RETRYABLE', 'EXTERNAL'];
}

function categoryRoute(decision: Decision): Route {
  if (decision.category === 'environment') return environmentRoute(decision);
  if (decision.category === 'gate_failure' && decision.action === 'escalate') return ['HARD_STOP', 'EXECUTION'];
  return BY_CATEGORY[decision.category] ?? UNCLASSIFIED;
}

export function routeDecision(decision: Decision): Routing {
  return routed(categoryRoute(decision), decision.why);
}

/** Most-stopping first, so the class answers "can this run happen at all". */
const SEVERITY: Record<FailureClass, number> = {
  RETRYABLE: 0,
  SPEC_BLOCKED: 1,
  HUMAN_DECISION_REQUIRED: 2,
  HARD_STOP: 3,
};

function worst(routes: Route[]): Route {
  return routes.reduce((chosen, route) => (SEVERITY[route[0]] > SEVERITY[chosen[0]] ? route : chosen));
}

/**
 * SAFETY: an empty list of failures is a caller asking this to explain a refusal
 * that named no reason, which it cannot do. Answering "retryable" would let a run
 * proceed past an admission that had already refused it.
 *
 * The class routes the actor; every failure still travels in the reason, so
 * picking the most-stopping one does not hide the others from whoever reads it.
 */
export function routePreflight(failures: readonly PreflightFailure[]): Routing {
  if (failures.length === 0) return routed(UNCLASSIFIED, 'admission refused without naming a reason');
  const routes = failures.map((entry) => BY_CHECK[entry.check] ?? UNCLASSIFIED);
  const reason = failures.map((entry) => `[${entry.check}] ${entry.reason}`).join('\n');
  return routed(worst(routes), reason);
}
