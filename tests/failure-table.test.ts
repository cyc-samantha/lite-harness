/**
 * The failure table, including the two things about it that are easy to get wrong.
 *
 * The first is precedence: a cost ceiling consulted after the retry rule has
 * already fired is not a ceiling. The second is the fall-through, which escalates
 * rather than retries — an unnamed failure retried is how a run spends its whole
 * budget learning nothing.
 */
import { describe, expect, it } from 'vitest';

import { classify, errorSignature, GATE_RETRY_LIMIT, type Observation } from '../engine/failure-table.ts';

const HEALTHY: Observation = {
  attemptsOnThisGate: 0,
  sealBroken: false,
  scopeViolations: 0,
  baseMoved: false,
  budget: { gateRuns: 1, wallMinutes: 2, maxGateRuns: 30, maxWallMinutes: 90 },
};

const red = (over: Partial<Observation> = {}): Observation => ({
  ...HEALTHY,
  redGate: { gateId: 'typecheck', exitCode: 1, output: 'TS2345: not assignable' },
  ...over,
});

describe('what the table decides', () => {
  it('retries a red gate in the context that produced it', () => {
    const decision = classify(red());
    expect(decision.action).toBe('retry_in_place');
    expect(decision.countsTowardBudget).toBe(true);
  });

  it('stops retrying a gate once it has had its attempts', () => {
    expect(classify(red({ attemptsOnThisGate: GATE_RETRY_LIMIT })).action).toBe('escalate');
  });

  it('never retries a broken seal', () => {
    const decision = classify(red({ sealBroken: true }));
    expect(decision.category).toBe('seal_broken');
    expect(decision.action).toBe('fail_loud');
  });

  it('escalates a diff that left the contract rather than widening the scope', () => {
    expect(classify(red({ scopeViolations: 2 })).action).toBe('escalate');
  });

  it('does not charge the run for a timeout', () => {
    const decision = classify(red({ redGate: { gateId: 'full_suite', exitCode: 137, output: '' } }));
    expect(decision.action).toBe('retry');
    expect(decision.countsTowardBudget).toBe(false);
  });

  it('refuses to retry a command that is not installed', () => {
    const decision = classify(red({ redGate: { gateId: 'lint', exitCode: 127, output: 'not found' } }));
    expect(decision.category).toBe('environment');
    expect(decision.action).toBe('escalate');
  });

  it('does not charge the run for the world moving underneath it', () => {
    const decision = classify(red({ baseMoved: true }));
    expect(decision.action).toBe('rebase_and_retry');
    expect(decision.countsTowardBudget).toBe(false);
  });

  it('sends an identical repeat failure to a judge instead of retrying it again', () => {
    const output = 'TS2345: not assignable';
    const decision = classify(red({ previousSignature: errorSignature(output) }));
    expect(decision.category).toBe('no_progress');
    expect(decision.action).toBe('judge');
  });

  it('keeps retrying while the failure is genuinely changing', () => {
    expect(classify(red({ previousSignature: errorSignature('a different error') })).action).toBe('retry_in_place');
  });
});

describe('precedence', () => {
  it('lets the ceiling stop a gate that would otherwise be retried', () => {
    const decision = classify(red({ budget: { ...HEALTHY.budget, gateRuns: 30 } }));
    expect(decision.action).toBe('halt');
  });

  it('lets the ceiling stop a run on elapsed time alone', () => {
    expect(classify(red({ budget: { ...HEALTHY.budget, wallMinutes: 91 } })).action).toBe('halt');
  });

  it('reports a broken seal even when the budget is also spent', () => {
    const spent = { ...HEALTHY.budget, gateRuns: 99 };
    expect(classify(red({ sealBroken: true, budget: spent })).category).toBe('seal_broken');
  });
});

describe('the failure the table cannot name', () => {
  it('escalates rather than retrying', () => {
    const decision = classify({ ...HEALTHY });
    expect(decision.category).toBe('unexplained');
    expect(decision.action).toBe('judge');
  });

  it('halts on an unreadable budget rather than treating it as room to spare', () => {
    const nonsense = { gateRuns: Number.NaN, wallMinutes: 2, maxGateRuns: 30, maxWallMinutes: 90 };
    expect(classify(red({ budget: nonsense })).action).toBe('halt');
  });

  it('halts on an unreadable ceiling even with a retryable gate in front of it', () => {
    const noCeiling = { gateRuns: 1, wallMinutes: 2, maxGateRuns: Number.NaN, maxWallMinutes: 90 };
    expect(classify(red({ budget: noCeiling })).category).toBe('budget_exhausted');
  });

  it('never answers "retry" for a failure it did not recognise', () => {
    const decision = classify({ ...HEALTHY });
    expect(['retry', 'retry_in_place', 'rebase_and_retry']).not.toContain(decision.action);
  });
});

describe('error signatures', () => {
  it('calls the same failure the same thing across runs', () => {
    const first = 'FAIL /tmp/lite/run/4489f70f/src/a.ts:12:4 in 231ms at 2026-08-15T21:00:00Z';
    const second = 'FAIL /tmp/lite/run/818be3a5/src/a.ts:12:4 in 987ms at 2026-08-15T22:31:09Z';
    expect(errorSignature(first)).toEqual(errorSignature(second));
  });

  it('still tells two genuinely different failures apart', () => {
    expect(errorSignature('TS2345: not assignable')).not.toEqual(errorSignature('TS2554: wrong arity'));
  });

  it('reduces empty output to something stable rather than throwing', () => {
    expect(errorSignature('')).toEqual('');
  });
});
