/**
 * The lease gate: what happens when this run may no longer act on its contract.
 *
 * The two tests that matter here are the two every gate in this repository ships.
 * The first goes red the moment the refusal is softened into a warning; the second
 * feeds an input the gate cannot evaluate and asserts it refuses rather than
 * asking the work source what it thinks about an empty run id.
 */
import { describe, expect, it } from 'vitest';

import { LeaseLost, renewLease } from '../engine/lease.ts';
import type { Checkpoint, Claim, Evidence, Verdict, WorkItemState, WorkSource } from '../ports/work-source.ts';

interface Recorder extends WorkSource {
  beats: string[];
}

function sourceWhoseHeartbeat(behaviour: () => Promise<void>): Recorder {
  const beats: string[] = [];
  const unused = (): never => {
    throw new Error('this test does not use that call');
  };
  return {
    beats,
    listReady: (): Promise<string[]> => unused(),
    stateOf: (): Promise<WorkItemState | undefined> => unused(),
    claim: (): Promise<Claim> => unused(),
    async heartbeat(runId: string): Promise<void> {
      beats.push(runId);
      await behaviour();
    },
    checkpoint: (_runId: string, _checkpoint: Checkpoint): Promise<void> => unused(),
    submit: (_runId: string, _evidence: Evidence[]): Promise<Verdict> => unused(),
    fail: (): Promise<void> => unused(),
  };
}

const renewed = (): Promise<void> => Promise.resolve();

describe('lease renewal', () => {
  it('renews quietly while the run still holds its lease', async () => {
    const source = sourceWhoseHeartbeat(renewed);
    await expect(renewLease(source, 'run-1')).resolves.toBeUndefined();
    expect(source.beats).toEqual(['run-1']);
  });

  it('refuses when the work source rejects the renewal', async () => {
    const source = sourceWhoseHeartbeat(() => Promise.reject(new Error('no live lease for run: run-1')));
    await expect(renewLease(source, 'run-1')).rejects.toBeInstanceOf(LeaseLost);
  });

  it('carries the source’s reason so a person can tell requeued from unreachable', async () => {
    const source = sourceWhoseHeartbeat(() => Promise.reject(new Error('connect ECONNREFUSED')));
    await expect(renewLease(source, 'run-1')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('refuses an unnamed run without asking the source at all', async () => {
    const source = sourceWhoseHeartbeat(renewed);
    await expect(renewLease(source, '   ')).rejects.toBeInstanceOf(LeaseLost);
    expect(source.beats).toEqual([]);
  });
});
