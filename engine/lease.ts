/**
 * Holding on to the work, and noticing when the work has been taken back.
 *
 * A work source hands out leases so that an agent which dies mid-run does not
 * strand its contract forever — the lease lapses and the work returns to the
 * queue. That mechanism only helps if the live agent renews, and it only stays
 * safe if an agent whose renewal was refused stops.
 */
import type { WorkSource } from '../ports/work-source.ts';

/** Raised when this run may no longer act on its contract. */
export class LeaseLost extends Error {
  constructor(runId: string, cause: string) {
    super(`run ${runId} no longer holds its lease: ${cause}`);
    this.name = 'LeaseLost';
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * SAFETY: every path out of this function is either a renewed lease or a throw.
 * A refused renewal means the work source already requeued this work, so another
 * agent may hold it — continuing would spend an implementer, and possibly open a
 * pull request, on a contract this run no longer owns. An unnamed run is refused
 * before the source is asked at all: there is no lease to renew, and asking with
 * an empty id would let whatever the source does with that stand in for a verdict.
 */
export async function renewLease(source: WorkSource, runId: string): Promise<void> {
  if (!runId.trim()) throw new LeaseLost('(unnamed)', 'no run id was given');
  try {
    await source.heartbeat(runId);
  } catch (error) {
    throw new LeaseLost(runId, reason(error));
  }
}
