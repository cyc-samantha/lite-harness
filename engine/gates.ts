/**
 * The gate ladder: declared commands, in declared order, stopping at the first red.
 *
 * Order is the cost model. Cheap deterministic checks run first so an expensive
 * one never pays for a failure a compiler could have found, and nothing below a
 * failed rung runs at all. A `record_only` rung is a measurement rather than a
 * verdict — it reports and lets the run continue, because a threshold nobody has
 * data for is a guess, and a gate that fails on a guess gets routed around until
 * it means nothing.
 */
import type { Gate, ProjectConfig } from '../ports/project-capabilities.ts';
import type { AcceptanceCriterion, WorkContract } from '../ports/work-source.ts';

import type { CommandRunner } from './shell.ts';

export interface GateOutcome {
  gateId: string;
  criterionId?: string;
  command: string;
  exitCode: number;
  passed: boolean;
  recordOnly: boolean;
  output: string;
}

export interface LadderResult {
  passed: boolean;
  outcomes: GateOutcome[];
  /** The gate that stopped the ladder, when one did. */
  stoppedAt?: string;
}

export interface LadderContext {
  cwd: string;
  runId: string;
  env: Record<string, string>;
}

/**
 * SAFETY: substituted values are single-quoted before they reach a shell. A test
 * name is ordinary prose — it contains spaces, and it arrives from a contract this
 * engine did not write. Interpolating it raw would both break the command (`-t
 * rejects unknown columns` is three arguments, not one) and let a crafted name run
 * whatever it liked.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function substitute(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, shellQuote(value)),
    template,
  );
}

function testableCriteria(contract: WorkContract): AcceptanceCriterion[] {
  return contract.acceptance.filter((entry) => entry.verification === 'executable_test');
}

interface PlannedStep {
  gate: Gate;
  command: string;
  criterionId?: string;
}

function expand(gate: Gate, contract: WorkContract, runId: string): PlannedStep[] {
  const base = { run_id: runId };
  if (!gate.per_criterion) return [{ gate, command: substitute(gate.run, base) }];
  return testableCriteria(contract).map((criterion) => ({
    gate,
    criterionId: criterion.id,
    command: substitute(gate.run, { ...base, file: criterion.targetTest!.file, name: criterion.targetTest!.name }),
  }));
}

export function planLadder(contract: WorkContract, project: ProjectConfig, runId: string): PlannedStep[] {
  return project.gates.flatMap((gate) => expand(gate, contract, runId));
}

function outcomeOf(step: PlannedStep, exitCode: number, output: string): GateOutcome {
  const base = {
    gateId: step.gate.id,
    command: step.command,
    exitCode,
    passed: exitCode === 0,
    recordOnly: step.gate.record_only,
    output,
  };
  return step.criterionId === undefined ? base : { ...base, criterionId: step.criterionId };
}

/** A red rung stops the ladder unless it was only ever a measurement. */
function halts(outcome: GateOutcome): boolean {
  return !outcome.passed && !outcome.recordOnly;
}

export async function runLadder(
  contract: WorkContract,
  project: ProjectConfig,
  context: LadderContext,
  runner: CommandRunner,
): Promise<LadderResult> {
  const outcomes: GateOutcome[] = [];
  for (const step of planLadder(contract, project, context.runId)) {
    const result = await runner.run(step.command, { cwd: context.cwd, env: context.env });
    const outcome = outcomeOf(step, result.exitCode, result.output);
    outcomes.push(outcome);
    if (halts(outcome)) return { passed: false, outcomes, stoppedAt: outcome.gateId };
  }
  return { passed: true, outcomes };
}
