/**
 * Where work comes from, as an interface the engine can depend on.
 *
 * The engine knows this file and nothing about who implements it. A work source
 * may be a contract ledger, an issue tracker, or a directory of YAML files — the
 * engine's behaviour must not change when the implementation does. Anything an
 * implementation happens to offer beyond this surface is invisible here on
 * purpose: the moment the engine reaches for it, this port has stopped being one.
 */

/** How a criterion is proven, ordered strongest to weakest. */
export type VerificationMechanism =
  | 'executable_test'
  | 'deterministic_assertion'
  | 'human_review'
  | 'rubric';

/** How much of this work a machine may decide on its own. */
export type AutomationLevel =
  | 'human-only'
  | 'human-approves'
  | 'agent-with-review'
  | 'agent-autonomous'
  | 'deterministic';

export type Risk = 'low' | 'medium' | 'high' | 'critical';

/** What changing this work's shape costs once it is in production. */
export type Irreversibility = 'refactor' | 'migration' | 'rewrite';

/** The test that proves one criterion, named by the contract rather than found by the agent. */
export interface TargetTest {
  file: string;
  name: string;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  verification: VerificationMechanism;
  targetTest?: TargetTest;
}

/**
 * A pinned pointer to material the run needs.
 *
 * `contentSha` is what makes sealing mean anything: a contract that is immutable
 * but whose context is mutable by reference is not actually immutable.
 */
export interface ContextRef {
  uri: string;
  contentSha: string;
  why: string;
}

/** What may be changed, and what may not. Both keys are always present. */
export interface Scope {
  include: string[];
  exclude: string[];
}

export interface Authority {
  allowed: string[];
  requiresHuman: string[];
  automationLevel: AutomationLevel;
}

export interface WorkContract {
  id: string;
  title: string;
  target: string;
  scope: Scope;
  constraints: string[];
  acceptance: AcceptanceCriterion[];
  context: ContextRef[];
  authority: Authority;
  irreversibility: Irreversibility;
  risk: Risk;
  dependsOn: string[];
}

/**
 * One criterion's result, as observed by the run.
 *
 * `envelopeSha` points back at the execution basis this result was produced on.
 * Without it a green result and a later red one on the same sealed contract are
 * indistinguishable from a flaky test, when the actual difference may be that
 * the base branch moved or the gate commands were edited underneath.
 */
export interface Evidence {
  acId: string;
  passed: boolean;
  envelopeSha: string;
  note?: string;
}

/** A progress report a supervisor can act on. */
export interface Checkpoint {
  step: string;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface Claim {
  runId: string;
  /** Which sealed version of the contract this run was handed. */
  sealVersion: string;
  contract: WorkContract;
}

export type Verdict =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; reasons: string[] }
  | { outcome: 'awaiting_human'; pending: string[] };

/** Lifecycle state of a work item, as the source reports it. */
export type WorkItemState = 'draft' | 'ready' | 'claimed' | 'running' | 'verifying' | 'done' | 'failed';

export interface WorkSource {
  listReady(): Promise<string[]>;

  /** Resolves undefined when the source has never heard of this contract. */
  stateOf(contractId: string): Promise<WorkItemState | undefined>;

  /**
   * How many runs this contract has already had that ended, however they ended.
   *
   * Rejects rather than answering zero when the count cannot be established. A
   * caller asking this is deciding whether to spend another attempt, and an
   * unreadable history that reads as "none yet" removes the limit precisely when
   * the source is unhealthy.
   */
  attemptsSpent(contractId: string): Promise<number>;

  /** Rejects when the work is not available — somebody else claimed it first. */
  claim(contractId: string, agent: string): Promise<Claim>;

  heartbeat(runId: string): Promise<void>;

  checkpoint(runId: string, checkpoint: Checkpoint): Promise<void>;

  submit(runId: string, evidence: Evidence[]): Promise<Verdict>;

  fail(runId: string): Promise<void>;
}
