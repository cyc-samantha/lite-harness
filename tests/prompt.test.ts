/**
 * The two claims the four-slot layout makes, as things that can fail.
 *
 * Both were previously true only because a document said so, which is another way
 * of saying they were not true. The reviewer's independence in particular is worth
 * a structural guarantee: it is invisible when it breaks, and a second reading
 * that has quietly seen the implementation still reads like a review.
 */
import { describe, expect, it } from 'vitest';

import { assemble, REPO_NOTES_LIMIT_BYTES, type RolePayload } from '../engine/prompt.ts';

import { validContract, validProject } from './fixtures/index.ts';

const PACK = 'src/board/export.ts — the module the criteria name';
const DIFF = '--- a/src/board/export.ts\n+++ b/src/board/export.ts\n+  throw new Error("unknown column");';

function promptFor(payload: RolePayload, roleText = `# ${payload.role}\nDo the ${payload.role} thing.`) {
  return assemble({ project: validProject(), repoNotes: '', contract: validContract(), roleText, payload });
}

function withNotes(notes: string) {
  const payload: RolePayload = { role: 'implementer', worktree: '/wt', contextPack: PACK };
  return assemble({ project: validProject(), repoNotes: notes, contract: validContract(), roleText: '# r', payload });
}

const packer = (): ReturnType<typeof promptFor> =>
  promptFor({ role: 'context-packer', repoRoot: '/repo' });

const implementer = (gateFailure?: string): ReturnType<typeof promptFor> =>
  promptFor({
    role: 'implementer',
    worktree: '/wt',
    contextPack: PACK,
    ...(gateFailure === undefined ? {} : { gateFailure }),
  });

const reviewer = (): ReturnType<typeof promptFor> => promptFor({ role: 'reviewer', diff: DIFF });

describe('the shared prefix', () => {
  it('is byte-identical across every role in one run', () => {
    const prefixes = [packer(), implementer(), reviewer()].map((prompt) => prompt.sharedPrefix);
    expect(new Set(prefixes).size).toBe(1);
  });

  it('opens every prompt, so a cache can actually reuse it', () => {
    for (const prompt of [packer(), implementer(), reviewer()]) {
      expect(prompt.text.startsWith(prompt.sharedPrefix)).toBe(true);
    }
  });

  it('survives a fix cycle unchanged, so a re-spawned implementer keeps the hit', () => {
    expect(implementer('typecheck failed').sharedPrefix).toBe(implementer().sharedPrefix);
  });

  it('carries the project and the contract, which is what makes it shareable', () => {
    const { sharedPrefix } = reviewer();
    expect(sharedPrefix).toContain('npx tsc --noEmit');
    expect(sharedPrefix).toContain('WC-0001');
  });
});

describe("the reviewer's independence", () => {
  it('is given the diff', () => {
    expect(reviewer().text).toContain(DIFF);
  });

  it('is given the criteria it must judge against', () => {
    const text = reviewer().text;
    expect(text).toContain('AC-01');
    expect(text).toContain('rejects unknown columns');
  });

  it('never receives the context pack', () => {
    expect(reviewer().text).not.toContain(PACK);
  });

  it('never receives a worktree or repository path to go reading', () => {
    const text = reviewer().text;
    expect(text).not.toContain('/wt');
    expect(text).not.toContain('/repo');
  });

  it('never learns that a gate failed and was fixed', () => {
    expect(reviewer().text).not.toContain('came back red');
  });

  it('has nowhere to put any of it, which is why the rules above hold', () => {
    // @ts-expect-error a reviewer payload has no contextPack field, by construction
    const forbidden: RolePayload = { role: 'reviewer', diff: DIFF, contextPack: PACK };
    expect(forbidden).toBeDefined();
  });
});

describe('the implementer', () => {
  it('receives the pack and its worktree', () => {
    const text = implementer().text;
    expect(text).toContain(PACK);
    expect(text).toContain('/wt');
  });

  it('is handed the failure output when a gate comes back red', () => {
    expect(implementer('tsc: 3 errors').text).toContain('tsc: 3 errors');
  });

  it('is told not to weaken the test, at the moment it would be tempting', () => {
    expect(implementer('tsc: 3 errors').text).toContain('Do not weaken the test');
  });
});

describe('the conditional roles', () => {
  const judge = (): ReturnType<typeof promptFor> =>
    promptFor({ role: 'escalation-judge', history: ['phase reached: packed', 'last red: typecheck exited 1'] });

  const splitter = (): ReturnType<typeof promptFor> => promptFor({ role: 'splitter', filesChanged: 14 });

  it('shares its prefix with the resident roles, so a run pays for it once', () => {
    expect(judge().sharedPrefix).toEqual(reviewer().sharedPrefix);
    expect(splitter().sharedPrefix).toEqual(reviewer().sharedPrefix);
  });

  it('gives the judge the history and not the repository', () => {
    const text = judge().text;
    expect(text).toContain('last red: typecheck exited 1');
    expect(text).not.toContain(PACK);
    expect(text).not.toContain('/wt');
  });

  it('has nowhere to hand the judge a worktree, which is why that holds', () => {
    // @ts-expect-error an escalation-judge payload has no worktree field, by construction
    const forbidden: RolePayload = { role: 'escalation-judge', history: [], worktree: '/wt' };
    expect(forbidden).toBeDefined();
  });

  it('tells the splitter how large the change is, not what is in it', () => {
    const text = splitter().text;
    expect(text).toContain('14 file(s)');
    expect(text).not.toContain(DIFF);
  });

  it('has nowhere to hand the splitter a diff, which is why that holds', () => {
    // @ts-expect-error a splitter payload has no diff field, by construction
    const forbidden: RolePayload = { role: 'splitter', filesChanged: 14, diff: DIFF };
    expect(forbidden).toBeDefined();
  });
});

/**
 * The repository's own notes belong in the slot that is shared widest, and the
 * budget on them has to be a test — always-loaded text is paid for on every
 * spawn and nobody notices a paragraph being added.
 */
describe("what the repository says about itself", () => {
  it('rides in the shared prefix, so every role in the run pays for it once', () => {
    const prompt = withNotes('Modules are wired in `bin/`, never in `engine/`.');
    expect(prompt.sharedPrefix).toContain('Modules are wired in');
  });

  it('is absent rather than empty-headed when the repository has no notes', () => {
    expect(withNotes('').sharedPrefix).not.toContain('How this codebase works');
    expect(withNotes('   \n  ').sharedPrefix).not.toContain('How this codebase works');
  });

  it('keeps the contract after it, so the widest-shared slot still comes first', () => {
    const prefix = withNotes('some notes').sharedPrefix;
    expect(prefix.indexOf('How this codebase works')).toBeLessThan(prefix.indexOf('This contract'));
  });

  it('says so in the prompt when a repository writes more than the budget allows', () => {
    const prompt = withNotes('x'.repeat(REPO_NOTES_LIMIT_BYTES + 500));
    expect(prompt.sharedPrefix).toContain('over the budget');
    expect(Buffer.byteLength(prompt.sharedPrefix, 'utf8')).toBeLessThan(REPO_NOTES_LIMIT_BYTES + 2_000);
  });
});
