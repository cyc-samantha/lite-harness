/**
 * Four answers to "who does something next", and the two ways that goes wrong.
 *
 * The first is the fifth answer nobody meant to add: an unrecognised failure
 * treated as retryable, which turns every platform outage into a run quietly
 * burning its budget. The second is losing the run's own lifecycle inside the
 * classification — these are separate axes and this file only tests one of them.
 */
import { describe, expect, it } from 'vitest';

import { EXIT_CODE, routeDecision, routePreflight } from '../engine/failure-class.ts';
import { classify, type Decision, type Observation } from '../engine/failure-table.ts';

const HEALTHY: Observation = {
  attemptsOnThisGate: 0,
  sealBroken: false,
  scopeViolations: 0,
  baseMoved: false,
  budget: { gateRuns: 1, wallMinutes: 2, maxGateRuns: 30, maxWallMinutes: 90 },
};

const red = (over: Partial<Observation> = {}): Observation => ({
  ...HEALTHY,
  redGate: { gateId: 'typecheck', exitCode: 1, output: 'TS2345' },
  ...over,
});

const route = (over: Partial<Observation> = {}) => routeDecision(classify(red(over)));

describe('routing a failure the run hit', () => {
  it('sends an ordinary red gate back round the loop, owned by nobody', () => {
    const routing = route();
    expect(routing.failure_class).toBe('RETRYABLE');
    expect(routing.next_actor).toBe('SYSTEM');
    expect(routing.failure_origin).toBe('EXECUTION');
  });

  it('stops a gate that has had its attempts instead of retrying it again', () => {
    expect(route({ attemptsOnThisGate: 3 }).failure_class).toBe('HARD_STOP');
  });

  it('blames the world, not the run, when the base moved underneath it', () => {
    const routing = route({ baseMoved: true });
    expect(routing.failure_class).toBe('RETRYABLE');
    expect(routing.failure_origin).toBe('EXTERNAL');
  });

  it('calls a timeout external and free rather than a fault of the change', () => {
    const routing = route({ redGate: { gateId: 'suite', exitCode: 137, output: '' } });
    expect(routing).toMatchObject({ failure_class: 'RETRYABLE', failure_origin: 'EXTERNAL' });
  });

  it('names the platform when a declared command is not installed', () => {
    const routing = route({ redGate: { gateId: 'lint', exitCode: 127, output: 'not found' } });
    expect(routing).toMatchObject({ failure_class: 'HARD_STOP', failure_origin: 'PLATFORM' });
  });

  it('carries the reason through rather than replacing it with a category name', () => {
    expect(route({ sealBroken: true }).reason).toContain('recorded hash');
  });
});

describe('routing a refusal at admission', () => {
  const routeOf = (check: string) => routePreflight([{ check, reason: 'x' } as never]);

  it('sends an unaccepted proposal back to whoever writes the spec', () => {
    expect(routeOf('unaccepted_proposal')).toMatchObject({
      failure_class: 'SPEC_BLOCKED',
      next_actor: 'SPEC_AUTHOR',
    });
  });

  it('sends an unanswered decision to a named person, not to the spec author', () => {
    expect(routeOf('unanswered_decision')).toMatchObject({
      failure_class: 'HUMAN_DECISION_REQUIRED',
      next_actor: 'NAMED_HUMAN',
    });
  });

  it('waits for a signature rather than treating it as a broken spec', () => {
    expect(routeOf('missing_signature').failure_class).toBe('HUMAN_DECISION_REQUIRED');
  });

  it('lets an unfinished dependency resolve itself', () => {
    expect(routeOf('dependencies')).toMatchObject({ failure_class: 'RETRYABLE', failure_origin: 'EXTERNAL' });
  });

  it('reports every failure in the reason even though one of them picks the class', () => {
    const routing = routePreflight([
      { check: 'dependencies', reason: 'WC-2 is not done' },
      { check: 'seal_integrity', reason: 'spec.md has changed' },
    ]);
    expect(routing.failure_class).toBe('HARD_STOP');
    expect(routing.reason).toContain('WC-2 is not done');
    expect(routing.reason).toContain('spec.md has changed');
  });
});

describe('the failure nobody classified', () => {
  it('is a hard stop the platform owns, never a retry', () => {
    const unnamed = { category: 'something_new', action: 'judge', countsTowardBudget: true, why: 'x' };
    const routing = routeDecision(unnamed as unknown as Decision);
    expect(routing.failure_class).toBe('HARD_STOP');
    expect(routing.failure_origin).toBe('PLATFORM');
  });

  it('does not become retryable just because admission named no reason', () => {
    const routing = routePreflight([]);
    expect(routing.failure_class).toBe('HARD_STOP');
    expect(routing.reason).toContain('without naming a reason');
  });

  it('routes an unrecognised admission check to the platform rather than through', () => {
    expect(routePreflight([{ check: 'invented_later', reason: 'x' } as never]).failure_class).toBe('HARD_STOP');
  });
});

describe('the exit code a caller reads', () => {
  it('gives each class its own, so a shell script can route without parsing', () => {
    const codes = Object.values(EXIT_CODE);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('never uses 0 or 1, which mean passed and crashed', () => {
    expect(Object.values(EXIT_CODE).every((code) => code > 1)).toBe(true);
  });
});
