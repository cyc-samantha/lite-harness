/**
 * Turning a contract id into a branch git will accept.
 *
 * This exists because the first real run died here. Contract ids are
 * `<adapter>:<spec>:<slice>` by convention, `agent/` was joined to one verbatim,
 * and git refuses a ref containing a colon — after the work had already been
 * claimed upstream, which is the most expensive place to find out.
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

describe('branch names built from contract ids', () => {
  it('produces a ref git accepts from a colon-separated contract id', () => {
    const branch = branchName('agent/', 'harness-factory-map:specifications:self-relation');
    expect(gitWouldAccept(branch)).toBe(true);
    expect(branch.startsWith('agent/')).toBe(true);
  });

  it('keeps two different contracts on two different branches', () => {
    const one = branchName('agent/', 'proj:alpha:slice');
    const two = branchName('agent/', 'proj:beta:slice');
    expect(one).not.toEqual(two);
  });

  it('accepts an id that was already legal without mangling it', () => {
    expect(branchName('agent/', 'plain-contract-id')).toBe('agent/plain-contract-id');
  });

  it('refuses an id with nothing a branch name can be built from', () => {
    expect(() => branchName('agent/', ':::')).toThrow(/nothing a branch name/);
  });

  it('refuses rather than silently collapsing onto the bare prefix', () => {
    expect(() => branchName('agent/', '   ')).toThrow();
  });
});
