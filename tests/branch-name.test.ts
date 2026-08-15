/**
 * Turning a contract id into a branch git will accept, once per run.
 *
 * Both rules here were written by the same pilot run. It died creating a
 * worktree because `agent/` had been joined to a contract id verbatim and a
 * colon is not legal in a ref — after the work had already been claimed
 * upstream, which is the most expensive place to find out. Its retry then asked
 * for a branch the first attempt had already created.
 */
import { describe, expect, it } from 'vitest';

import { branchName } from '../engine/repo.ts';

/** git's own rules, narrowed to the ones a contract id can plausibly break. */
function gitWouldAccept(ref: string): boolean {
  if (/[\s~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
  if (ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false;
  return ref.length > 0;
}

const RUN = '4489f70f-b508-4392-905f-97a0e943f1fb';

describe('branch names built from contract ids', () => {
  it('produces a ref git accepts from a colon-separated contract id', () => {
    const branch = branchName('agent/', 'harness-factory-map:specifications:self-relation', RUN);
    expect(gitWouldAccept(branch)).toBe(true);
    expect(branch.startsWith('agent/harness-factory-map-specifications-self-relation')).toBe(true);
  });

  it('keeps two different contracts on two different branches', () => {
    expect(branchName('agent/', 'proj:alpha', RUN)).not.toEqual(branchName('agent/', 'proj:beta', RUN));
  });

  it('gives a retried contract a branch of its own', () => {
    const first = branchName('agent/', 'proj:alpha', '4489f70f-b508-4392-905f-97a0e943f1fb');
    const second = branchName('agent/', 'proj:alpha', 'ebf6af7c-7d89-4b9a-8c87-6f44afa570c8');
    expect(first).not.toEqual(second);
  });

  it('keeps the contract readable in the name rather than hashing it away', () => {
    expect(branchName('agent/', 'plain-contract-id', RUN)).toBe('agent/plain-contract-id-4489f70f');
  });

  it('refuses an id with nothing a branch name can be built from', () => {
    expect(() => branchName('agent/', ':::', RUN)).toThrow(/contract id has nothing/);
  });

  it('refuses an unnamed run rather than reusing one branch for every attempt', () => {
    expect(() => branchName('agent/', 'proj:alpha', '   ')).toThrow(/run id has nothing/);
  });
});
