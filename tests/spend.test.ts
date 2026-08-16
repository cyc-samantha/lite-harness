/**
 * One ceiling across both retry layers.
 *
 * The arithmetic is trivial and the two refusals are the point: a record this
 * cannot read must not resolve to nothing spent, and attempts the source knows
 * about that this ledger cannot account for must not be handed a fresh budget.
 * Both failures look like generosity and are how a cap disappears.
 */
import { describe, expect, it } from 'vitest';

import {
  accountFor,
  afterAttempt,
  NOTHING_SPENT,
  readSpend,
  runningTotal,
  SpendUnknown,
  type Spend,
} from '../engine/spend.ts';

const SPENT: Spend = { attempts: 1, gateRuns: 12, wallMinutes: 31 };

describe('what a contract has cost so far', () => {
  it('adds this run to everything before it, so the second attempt is not given a fresh ceiling', () => {
    expect(runningTotal(SPENT, { gateRuns: 9, wallMinutes: 20 })).toEqual({
      attempts: 1,
      gateRuns: 21,
      wallMinutes: 51,
    });
  });

  it('counts the attempt only once it has ended', () => {
    expect(runningTotal(SPENT, { gateRuns: 1, wallMinutes: 1 }).attempts).toBe(1);
    expect(afterAttempt(SPENT, { gateRuns: 1, wallMinutes: 1 }).attempts).toBe(2);
  });

  it('starts a contract nobody has run at nothing', () => {
    expect(readSpend(undefined)).toEqual(NOTHING_SPENT);
  });

  it('reads back what it wrote', () => {
    expect(readSpend(JSON.parse(JSON.stringify(SPENT)) as unknown)).toEqual(SPENT);
  });
});

describe('a record this cannot read', () => {
  it('refuses rather than resolving to nothing spent', () => {
    expect(() => readSpend({ attempts: 1, gateRuns: 'lots', wallMinutes: 3 })).toThrow(SpendUnknown);
  });

  it('names the fields it could not read', () => {
    expect(() => readSpend({ attempts: 1 })).toThrow(/gateRuns, wallMinutes/);
  });

  it('refuses a negative count rather than letting it buy budget back', () => {
    expect(() => readSpend({ attempts: 1, gateRuns: -50, wallMinutes: 3 })).toThrow(SpendUnknown);
  });

  it('refuses a document that is not one', () => {
    expect(() => readSpend('12')).toThrow(SpendUnknown);
  });
});

describe('spend this ledger cannot see', () => {
  it('refuses a claim when the source counted attempts nobody here recorded', () => {
    expect(() => accountFor(2, { attempts: 0, gateRuns: 0, wallMinutes: 0 })).toThrow(SpendUnknown);
  });

  it('says how much is unaccounted for, since that is what a person has to resolve', () => {
    expect(() => accountFor(3, SPENT)).toThrow(/2 spent where this run cannot see/);
  });

  it('allows a claim whose history is fully accounted for', () => {
    expect(() => accountFor(1, SPENT)).not.toThrow();
  });

  it('allows a first claim on a contract nobody has run', () => {
    expect(() => accountFor(0, NOTHING_SPENT)).not.toThrow();
  });

  it('refuses when the source could not say how many attempts it has recorded', () => {
    expect(() => accountFor(Number.NaN, SPENT)).toThrow(SpendUnknown);
  });
});
