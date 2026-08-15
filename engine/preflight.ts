/**
 * The admission gate. Nothing reaches an agent without passing every check here.
 *
 * These checks read the shape of the contract and the declared capabilities of
 * the target repository — never the contents of any source file. That is what
 * makes them the one part of the engine that is identical for every project and
 * every work source, and it is why they are cheap enough to run unconditionally:
 * a rejection here costs no model call at all.
 *
 * SAFETY: every check refuses on an input it cannot evaluate. An unresolvable
 * context reference, an unknown dependency state, or a gate whose executable is
 * missing all stop the run. The alternative — proceeding on the assumption that
 * the unevaluable thing was probably fine — produces a pull request built against
 * requirements nobody sealed, which is the failure this layer exists to prevent.
 */
import { minimatch } from 'minimatch';

import type { ProjectConfig } from '../ports/project-capabilities.ts';
import type { AcceptanceCriterion, WorkContract, WorkItemState } from '../ports/work-source.ts';

import { shapeProblems } from './contract-shape.ts';

export type PreflightCheck =
  | 'contract_shape'
  | 'seal_integrity'
  | 'authority'
  | 'dependencies'
  | 'capability_match'
  | 'scope_resolvable'
  | 'protected_path_conflict'
  | 'environment_ready';

export interface PreflightFailure {
  check: PreflightCheck;
  reason: string;
}

export type PreflightResult = { ok: true } | { ok: false; failures: PreflightFailure[] };

export interface PreflightDeps {
  /** Digest of the material a context reference points at, or undefined when it cannot be resolved. */
  shaOf(uri: string): Promise<string | undefined>;
  /** Every path the target repository tracks, repo-relative. */
  trackedFiles(): Promise<string[]>;
  /** Lifecycle state of a contract this one depends on. */
  stateOf(contractId: string): Promise<WorkItemState | undefined>;
  /** Whether a declared gate command could actually be executed. */
  canRun(command: string): Promise<boolean>;
}

function failure(check: PreflightCheck, reason: string): PreflightFailure {
  return { check, reason };
}

async function checkSeal(contract: WorkContract, deps: PreflightDeps): Promise<PreflightFailure[]> {
  const checked = contract.context.map(async (ref) => {
    const actual = await deps.shaOf(ref.uri);
    if (actual === undefined) return failure('seal_integrity', `${ref.uri} could not be resolved`);
    if (actual !== ref.contentSha) return failure('seal_integrity', `${ref.uri} has changed since the contract was sealed`);
    return undefined;
  });
  return (await Promise.all(checked)).filter((entry) => entry !== undefined);
}

function checkAuthority(contract: WorkContract): PreflightFailure[] {
  const level = contract.authority.automationLevel;
  if (level !== 'human-only') return [];
  return [failure('authority', `${contract.id} is human-only work and cannot be executed by an agent`)];
}

async function checkDependencies(contract: WorkContract, deps: PreflightDeps): Promise<PreflightFailure[]> {
  const checked = contract.dependsOn.map(async (id) => {
    const state = await deps.stateOf(id);
    if (state === 'done') return undefined;
    return failure('dependencies', `${id} is ${state ?? 'unknown to this work source'}, not done`);
  });
  return (await Promise.all(checked)).filter((entry) => entry !== undefined);
}

/**
 * WHY `deterministic_assertion` is refused: adjudication treats it as machine-owned,
 * yet the contract names no test for it, so the engine has nothing to run and no
 * honest way to report a result. Marking it passed would be the run grading its own
 * homework. Refusing is the only answer that stays true.
 */
function evidenceProblem(criterion: AcceptanceCriterion): string | undefined {
  if (criterion.verification !== 'deterministic_assertion') return undefined;
  return `${criterion.id} uses deterministic_assertion, which this engine cannot evidence — name a test and use executable_test`;
}

function checkCapabilities(contract: WorkContract, project: ProjectConfig): PreflightFailure[] {
  const unevidenceable = contract.acceptance
    .map(evidenceProblem)
    .filter((reason) => reason !== undefined)
    .map((reason) => failure('capability_match', reason));

  const needsRunner = contract.acceptance.some((entry) => entry.verification === 'executable_test');
  const hasRunner = project.gates.some((gate) => gate.per_criterion);
  if (!needsRunner || hasRunner) return unevidenceable;

  const reason = 'contract names executable tests but project.yaml declares no per_criterion gate to run them';
  return [...unevidenceable, failure('capability_match', reason)];
}

function matching(patterns: string[], files: string[]): string[] {
  return files.filter((file) => patterns.some((pattern) => minimatch(file, pattern)));
}

function checkScopeResolves(contract: WorkContract, files: string[]): PreflightFailure[] {
  return contract.scope.include
    .filter((pattern) => matching([pattern], files).length === 0)
    .map((pattern) => failure('scope_resolvable', `scope.include pattern "${pattern}" matches no tracked file`));
}

function checkProtectedPaths(contract: WorkContract, project: ProjectConfig, files: string[]): PreflightFailure[] {
  const inScope = matching(contract.scope.include, files);
  const collisions = matching(project.protected_paths, inScope);
  return collisions.map((path) =>
    failure('protected_path_conflict', `scope.include reaches "${path}", which project.yaml protects`),
  );
}

async function checkEnvironment(project: ProjectConfig, deps: PreflightDeps): Promise<PreflightFailure[]> {
  const checked = project.gates.map(async (gate) => {
    if (await deps.canRun(gate.run)) return undefined;
    return failure('environment_ready', `gate "${gate.id}" cannot run: ${gate.run}`);
  });
  return (await Promise.all(checked)).filter((entry) => entry !== undefined);
}

function shapeFailures(contract: WorkContract): PreflightFailure[] {
  return shapeProblems(contract).map((problem) => failure('contract_shape', problem));
}

/**
 * A malformed contract short-circuits: the remaining checks read fields the shape
 * check has just proven absent or wrong, so running them would bury the real
 * problem under consequences of it.
 */
export async function preflight(
  contract: WorkContract,
  project: ProjectConfig,
  deps: PreflightDeps,
): Promise<PreflightResult> {
  const shape = shapeFailures(contract);
  if (shape.length > 0) return { ok: false, failures: shape };

  const files = await deps.trackedFiles();
  const failures = [
    ...(await checkSeal(contract, deps)),
    ...checkAuthority(contract),
    ...(await checkDependencies(contract, deps)),
    ...checkCapabilities(contract, project),
    ...checkScopeResolves(contract, files),
    ...checkProtectedPaths(contract, project, files),
    ...(await checkEnvironment(project, deps)),
  ];
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}
