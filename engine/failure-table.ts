/**
 * What to do about a failure, decided by looking it up rather than reasoning about it.
 *
 * Most of failure handling is a table. Which failures may be retried, which are
 * free, which mean the contract itself is wrong — these are answers somebody
 * already knows, and asking a model to rederive them each time is both slower and
 * less consistent than reading them off. A model is worth paying for exactly one
 * cell of this table: the one where nothing else matched.
 *
 * The order of the rules is the substance. A cost ceiling that is only consulted
 * after the retry rule has fired is not a ceiling.
 */

export type FailureCategory =
  | 'seal_broken'
  | 'budget_exhausted'
  | 'scope_violation'
  | 'world_moved'
  | 'environment'
  | 'no_progress'
  | 'gate_failure'
  | 'unexplained';

/**
 * `retry_in_place` means the same implementer, holding the context that produced
 * the code, is handed the failure. Spawning a fresh one throws away the most
 * valuable thing in the run and pays to rebuild a worse copy of it.
 */
export type FailureAction =
  | 'fail_loud'
  | 'halt'
  | 'escalate'
  | 'rebase_and_retry'
  | 'retry'
  | 'retry_in_place'
  | 'judge';

export interface Decision {
  category: FailureCategory;
  action: FailureAction;
  /** Whether this failure is the run's own fault, and so spends its budget. */
  countsTowardBudget: boolean;
  why: string;
}

export interface Budget {
  gateRuns: number;
  wallMinutes: number;
  maxGateRuns: number;
  maxWallMinutes: number;
}

export interface RedGate {
  gateId: string;
  exitCode: number;
  output: string;
}

export interface Observation {
  redGate?: RedGate;
  /** The signature of the last red on this same gate, carried in the run record. */
  previousSignature?: string;
  /** How many times this gate has already been retried in this run. */
  attemptsOnThisGate: number;
  sealBroken: boolean;
  scopeViolations: number;
  baseMoved: boolean;
  budget: Budget;
}

/** A command killed on timeout; see `engine/shell.ts`. */
const TIMED_OUT = 137;

/** A command that could not start at all; see `engine/shell.ts`. */
const NOT_FOUND = 127;

/** How many times one gate may be retried inside a single run before escalating. */
export const GATE_RETRY_LIMIT = 3;

type Rule = (observation: Observation) => Decision | undefined;

function sealBroken({ sealBroken: broken }: Observation): Decision | undefined {
  if (!broken) return undefined;
  return {
    category: 'seal_broken',
    action: 'fail_loud',
    countsTowardBudget: false,
    why: 'a sealed reference no longer matches its recorded hash, so this run cannot know what it was asked to build',
  };
}

const spentOf = (budget: Budget): Decision => ({
  category: 'budget_exhausted',
  action: 'halt',
  countsTowardBudget: false,
  why: `spent ${budget.gateRuns}/${budget.maxGateRuns} gate runs and ${Math.round(budget.wallMinutes)}/${budget.maxWallMinutes} minutes`,
});

/**
 * SAFETY: the test asks whether the run is provably under both limits, and halts
 * on anything else — rather than asking whether it is over them and continuing
 * on anything else. The two read alike and differ on unreadable input: every
 * comparison against NaN is false, so the natural phrasing answers "not over the
 * limit, carry on" for a budget it could not read at all, and answers it again
 * on every later check. An unreadable ceiling is not a ceiling.
 */
function budgetSpent({ budget }: Observation): Decision | undefined {
  const withinLimits = budget.gateRuns < budget.maxGateRuns && budget.wallMinutes < budget.maxWallMinutes;
  return withinLimits ? undefined : spentOf(budget);
}

function scopeEscaped({ scopeViolations }: Observation): Decision | undefined {
  if (scopeViolations <= 0) return undefined;
  return {
    category: 'scope_violation',
    action: 'escalate',
    countsTowardBudget: false,
    why: `${scopeViolations} changed path(s) fall outside the contract's scope, and widening a sealed scope is not this run's decision`,
  };
}

function worldMoved({ baseMoved }: Observation): Decision | undefined {
  if (!baseMoved) return undefined;
  return {
    category: 'world_moved',
    action: 'rebase_and_retry',
    countsTowardBudget: false,
    why: 'the base branch moved under this run, which is somebody else delivering rather than this run failing',
  };
}

function environment({ redGate }: Observation): Decision | undefined {
  if (redGate?.exitCode === TIMED_OUT) {
    return {
      category: 'environment',
      action: 'retry',
      countsTowardBudget: false,
      why: `${redGate.gateId} was killed on timeout, which says nothing about the change`,
    };
  }
  if (redGate?.exitCode !== NOT_FOUND) return undefined;
  return {
    category: 'environment',
    action: 'escalate',
    countsTowardBudget: false,
    why: `${redGate.gateId} could not start — a declared command is missing from this machine, and no number of retries installs it`,
  };
}

function noProgress({ redGate, previousSignature }: Observation): Decision | undefined {
  if (!redGate || previousSignature === undefined) return undefined;
  if (errorSignature(redGate.output) !== previousSignature) return undefined;
  return {
    category: 'no_progress',
    action: 'judge',
    countsTowardBudget: false,
    why: `${redGate.gateId} failed identically twice, so the last attempt changed nothing that mattered`,
  };
}

function gateFailure({ redGate, attemptsOnThisGate }: Observation): Decision | undefined {
  if (!redGate) return undefined;
  if (attemptsOnThisGate >= GATE_RETRY_LIMIT) {
    return {
      category: 'gate_failure',
      action: 'escalate',
      countsTowardBudget: true,
      why: `${redGate.gateId} has been retried ${attemptsOnThisGate} times; a fourth has never been the attempt that worked`,
    };
  }
  return {
    category: 'gate_failure',
    action: 'retry_in_place',
    countsTowardBudget: true,
    why: `${redGate.gateId} exited ${redGate.exitCode}; the implementer that wrote the code repairs it`,
  };
}

/**
 * SAFETY: the fall-through escalates rather than retries. Every retry rule above
 * had to recognise its failure to fire; anything reaching here is a failure this
 * table cannot name, and the cheapest wrong answer for an unnamed failure is to
 * try it again — that is the shape of a loop that spends a budget discovering
 * nothing. Judging costs one model call and produces a reason a person can read.
 */
const UNEXPLAINED: Decision = {
  category: 'unexplained',
  action: 'judge',
  countsTowardBudget: true,
  why: 'no rule in the failure table recognised this, which is itself evidence — most often that the contract asks for something it does not describe',
};

const RULES: readonly Rule[] = [
  sealBroken,
  budgetSpent,
  scopeEscaped,
  worldMoved,
  environment,
  noProgress,
  gateFailure,
];

export function classify(observation: Observation): Decision {
  for (const rule of RULES) {
    const decision = rule(observation);
    if (decision) return decision;
  }
  return UNEXPLAINED;
}

const NOISE: readonly [RegExp, string][] = [
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<time>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b[0-9a-f]{7,64}\b/gi, '<hex>'],
  [/(?:\/[\w.@-]+){2,}/g, '<path>'],
  [/:\d+:\d+/g, ':<pos>'],
  [/\b\d+(?:\.\d+)?\s?m?s\b/g, '<duration>'],
  [/\d+/g, '<n>'],
];

/**
 * What a failure is, with what merely varies between runs stripped out.
 *
 * "The same failure twice" is the signal that an attempt achieved nothing, and it
 * is worthless if a timestamp, a temporary path, or a duration makes every
 * failure look new. Normalising too aggressively only costs one extra retry;
 * normalising too little costs the whole no-progress rule.
 */
export function errorSignature(output: string): string {
  return NOISE.reduce((text, [pattern, token]) => text.replace(pattern, token), output)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}
