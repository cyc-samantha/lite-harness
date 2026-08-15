/**
 * The claims the gate ladder, the evidence step, and the run record actually make.
 *
 * A run that succeeds proves very little. What has to hold is the behaviour on the
 * bad paths: that a red rung stops everything below it, that evidence reports the
 * exit code rather than the intention, and that a resumed run does not repeat a
 * side effect it already performed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runLadder, type LadderResult } from '../engine/gates.ts';
import { evidenceFrom } from '../engine/evidence.ts';
import { scopeViolations } from '../engine/scope-check.ts';
import { advanced, hasReached, loadState, newRun, saveState } from '../engine/state.ts';
import type { CommandResult, CommandRunner, RunOptions } from '../engine/shell.ts';

import { validContract, validProject } from './fixtures/index.ts';

interface RecordingRunner extends CommandRunner {
  commands: string[];
}

function runnerThatFails(failOn: (command: string) => boolean): RecordingRunner {
  const commands: string[] = [];
  return {
    commands,
    async run(command: string, _options: RunOptions): Promise<CommandResult> {
      commands.push(command);
      return failOn(command) ? { exitCode: 1, output: 'boom' } : { exitCode: 0, output: 'ok' };
    },
  };
}

const CONTEXT = { cwd: '/nowhere', runId: 'run-1', env: {} };

async function ladderWith(failOn: (command: string) => boolean): Promise<{ result: LadderResult; runner: RecordingRunner }> {
  const runner = runnerThatFails(failOn);
  const result = await runLadder(validContract(), validProject(), CONTEXT, runner);
  return { result, runner };
}

describe('the gate ladder', () => {
  it('stops at the first red rung and runs nothing below it', async () => {
    const { result, runner } = await ladderWith((command) => command.includes('tsc'));
    expect(result.passed).toBe(false);
    expect(result.stoppedAt).toBe('typecheck');
    expect(runner.commands).toEqual(['npx tsc --noEmit']);
  });

  it('expands a per_criterion gate once per named test, quoting each value', async () => {
    const { runner } = await ladderWith(() => false);
    expect(runner.commands).toContain(
      "npx vitest run 'tests/board/export.test.ts' -t 'rejects unknown columns'",
    );
    expect(runner.commands.filter((command) => command.includes('-t '))).toHaveLength(2);
  });

  it('quotes a substituted value that would otherwise end the command', async () => {
    const contract = validContract();
    contract.acceptance[0]!.targetTest!.name = "x'; rm -rf /; echo '";
    const runner = runnerThatFails(() => false);
    await runLadder(contract, validProject(), CONTEXT, runner);
    const expanded = runner.commands.find((command) => command.includes('rm -rf'));
    expect(expanded).toContain(`'x'\\''; rm -rf /; echo '\\'''`);
  });

  it('lets a record_only rung report red without stopping the run', async () => {
    const { result, runner } = await ladderWith((command) => command.includes('c8'));
    expect(result.passed).toBe(true);
    expect(runner.commands.some((command) => command.includes('c8'))).toBe(true);
    expect(result.outcomes.at(-1)?.passed).toBe(false);
  });
});

describe('evidence', () => {
  it('reports the exit code of the named test, not an account of the work', async () => {
    const { result } = await ladderWith((command) => command.includes('names the offending column'));
    const evidence = evidenceFrom(validContract(), result);
    expect(evidence.find((entry) => entry.acId === 'AC-02')?.passed).toBe(false);
  });

  it('gives every sealed criterion exactly one entry', async () => {
    const { result } = await ladderWith(() => false);
    const evidence = evidenceFrom(validContract(), result);
    expect(evidence.map((entry) => entry.acId)).toEqual(['AC-01', 'AC-02']);
  });

  it('says so plainly when a criterion was never reached', async () => {
    const { result } = await ladderWith((command) => command.includes('tsc'));
    const evidence = evidenceFrom(validContract(), result);
    expect(evidence.every((entry) => entry.passed === false)).toBe(true);
    expect(evidence[0]?.note).toContain('not evaluated');
  });

  it('defers a criterion a person owns instead of marking its own homework', async () => {
    const contract = validContract();
    contract.acceptance[1]!.verification = 'rubric';
    delete contract.acceptance[1]!.targetTest;
    const { result } = await ladderWith(() => false);
    const evidence = evidenceFrom(contract, result);
    expect(evidence[1]?.note).toContain('deferred to human review');
  });
});

describe('scope', () => {
  it('flags a file the contract never claimed', () => {
    const violations = scopeViolations(['src/board/export.ts', 'src/api/routes.ts'], validContract().scope);
    expect(violations).toEqual([{ path: 'src/api/routes.ts', reason: 'outside include' }]);
  });

  it('flags a file the contract explicitly excluded', () => {
    const violations = scopeViolations(['src/board/legacy/old-export.ts'], validContract().scope);
    expect(violations[0]?.reason).toBe('matches exclude');
  });

  it('passes a change that stayed inside the boundary', () => {
    expect(scopeViolations(['src/board/export.ts'], validContract().scope)).toEqual([]);
  });
});

describe('the run record', () => {
  const made: string[] = [];

  afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function dataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'lite-harness-'));
    made.push(dir);
    return dir;
  }

  it('survives a round trip to disk', async () => {
    const dir = await dataDir();
    const state = newRun('run-1', 'WC-0001', '2026-08-15T00:00:00Z');
    await saveState(dir, state);
    await expect(loadState(dir, 'run-1')).resolves.toEqual(state);
  });

  it('reports no state rather than inventing one for a run it has never seen', async () => {
    await expect(loadState(await dataDir(), 'run-never')).resolves.toBeUndefined();
  });

  it('does not walk a resumed run backwards past a phase it already completed', () => {
    const opened = advanced(newRun('run-1', 'WC-0001', 'T0'), 'pr_open', 'T1');
    const replayed = advanced(opened, 'packed', 'T2');
    expect(replayed.phase).toBe('pr_open');
    expect(hasReached(replayed, 'pr_open')).toBe(true);
  });
});
