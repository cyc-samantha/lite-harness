/**
 * What this run has already done, kept somewhere the run itself cannot forget.
 *
 * Agent context is compacted, processes are killed, machines are rebooted. State
 * held only in a conversation is state that will be lost partway through, and a
 * resumed run that has forgotten it already opened a pull request will open a
 * second one. Every phase is therefore recorded on disk as it completes, and every
 * step asks the record before it acts rather than after.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Ordered, so "has this run already got past X" is answerable.
 *
 * Every phase here is written by something the engine watched happen — a claim
 * returning, an admission passing, a ladder exiting zero, a pull request URL
 * arriving. Implementing and reviewing are missing on purpose: a subagent does
 * both, and the only available signal that either finished is the subagent saying
 * so. A phase recorded on a model's account of itself would make the record look
 * complete while meaning nothing, which is worse than not recording it.
 */
export const RUN_PHASES = [
  'claimed',
  'admitted',
  'packed',
  'gates_passed',
  'pr_open',
  'submitted',
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

/**
 * What the last red rung was, so "the same failure twice" is answerable.
 *
 * A run cannot tell a repair that achieved nothing from one that changed the
 * error unless it remembers what the error was, and it cannot remember anything
 * across two invocations of a CLI except on disk.
 */
export interface LastRed {
  gateId: string;
  signature: string;
}

export interface RunState {
  runId: string;
  contractId: string;
  phase: RunPhase;
  startedAt: string;
  updatedAt: string;
  branch?: string;
  worktree?: string;
  prUrl?: string;
  /** Consecutive retries of the gate named in `lastRed`. */
  gateAttempts: number;
  /** Every rung this run has executed, which is what the ceiling counts. */
  gateRuns: number;
  lastRed?: LastRed;
}

export function statePath(dataDir: string, runId: string): string {
  return join(dataDir, 'run', runId, 'state.json');
}

export function newRun(runId: string, contractId: string, now: string): RunState {
  return { runId, contractId, phase: 'claimed', startedAt: now, updatedAt: now, gateAttempts: 0, gateRuns: 0 };
}

/** Minutes since the run was claimed, which is half of what the ceiling watches. */
export function elapsedMinutes(state: RunState, now: string): number {
  const started = Date.parse(state.startedAt);
  const current = Date.parse(now);
  // WHY: an unreadable clock reports an exhausted budget rather than a fresh one.
  // The ceiling's job is to stop a run it cannot account for.
  if (!Number.isFinite(started) || !Number.isFinite(current)) return Number.POSITIVE_INFINITY;
  return (current - started) / 60_000;
}

export function hasReached(state: RunState, phase: RunPhase): boolean {
  return RUN_PHASES.indexOf(state.phase) >= RUN_PHASES.indexOf(phase);
}

export function advanced(state: RunState, phase: RunPhase, now: string): RunState {
  if (hasReached(state, phase)) return { ...state, updatedAt: now };
  return { ...state, phase, updatedAt: now };
}

/**
 * SAFETY: written to a temporary path and renamed into place. A process killed
 * mid-write would otherwise leave a truncated state file, and a resumed run that
 * cannot parse its own record has no way to tell "nothing happened yet" from
 * "everything happened and the record was lost".
 */
export async function saveState(dataDir: string, state: RunState): Promise<void> {
  const target = statePath(dataDir, state.runId);
  await mkdir(dirname(target), { recursive: true });
  const staging = `${target}.writing`;
  await writeFile(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(staging, target);
}

export async function loadState(dataDir: string, runId: string): Promise<RunState | undefined> {
  try {
    const raw = await readFile(statePath(dataDir, runId), 'utf8');
    return JSON.parse(raw) as RunState;
  } catch {
    return undefined;
  }
}
