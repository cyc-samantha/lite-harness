/**
 * One budget across both retry layers, because two budgets are not a budget.
 *
 * A run retries a red gate in place; a contract gets another run when one fails.
 * Cap each separately and the product is what actually gets spent — three
 * repairs inside two attempts against a ceiling of thirty rungs is sixty rungs,
 * and nobody set that number. The ceiling therefore counts a contract's whole
 * history, not one attempt's.
 *
 * That history has to come from somewhere. The work source records that attempts
 * happened but not what they cost, so the count is kept here and reconciled
 * against the source's attempt count — which is the only way a run can notice
 * that it is about to be handed a budget somebody else already spent.
 */

export interface Spend {
  attempts: number;
  gateRuns: number;
  wallMinutes: number;
}

export const NOTHING_SPENT: Spend = { attempts: 0, gateRuns: 0, wallMinutes: 0 };

export class SpendUnknown extends Error {
  constructor(why: string) {
    super(`this contract's budget cannot be established: ${why}`);
    this.name = 'SpendUnknown';
  }
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * SAFETY: a record this cannot read refuses rather than resolving to nothing
 * spent. Zero is the most permissive answer available and the file is most
 * likely to be unreadable after a run was killed partway — exactly when spend is
 * high and least accounted for. An unreadable ledger is not an empty one.
 */
export function readSpend(raw: unknown): Spend {
  if (raw === undefined || raw === null) return NOTHING_SPENT;
  if (typeof raw !== 'object') throw new SpendUnknown('its record is not a document');
  const record = raw as Record<string, unknown>;
  const spend = { attempts: finite(record['attempts']), gateRuns: finite(record['gateRuns']), wallMinutes: finite(record['wallMinutes']) };
  const holes = Object.entries(spend).filter(([, value]) => value === undefined).map(([key]) => key);
  if (holes.length > 0) throw new SpendUnknown(`${holes.join(', ')} unreadable in its record`);
  return spend as Spend;
}

/** What the ceiling should be measured against right now: everything before, plus this run. */
export function runningTotal(prior: Spend, current: { gateRuns: number; wallMinutes: number }): Spend {
  return {
    attempts: prior.attempts,
    gateRuns: prior.gateRuns + current.gateRuns,
    wallMinutes: prior.wallMinutes + current.wallMinutes,
  };
}

export function afterAttempt(prior: Spend, current: { gateRuns: number; wallMinutes: number }): Spend {
  return { ...runningTotal(prior, current), attempts: prior.attempts + 1 };
}

/**
 * SAFETY: attempts the source has recorded that this ledger cannot account for
 * mean the budget was partly spent somewhere this run cannot see — another
 * machine, a wiped data directory. Granting a fresh ceiling then is how the cap
 * silently disappears at the exact moment a contract is being retried hardest.
 */
export function accountFor(attemptsUpstream: number, prior: Spend): void {
  if (!Number.isFinite(attemptsUpstream)) throw new SpendUnknown('the source did not say how many attempts it has recorded');
  const unaccounted = attemptsUpstream - prior.attempts;
  if (unaccounted <= 0) return;
  throw new SpendUnknown(`${attemptsUpstream} attempt(s) upstream, ${prior.attempts} accounted for here — ${unaccounted} spent where this run cannot see`);
}
