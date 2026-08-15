/**
 * Reading what a run actually changed.
 *
 * The scope check is only as good as this list. The first real run reported that
 * a file it had just edited was outside the contract's boundary, because the
 * path it compared was `arness-factory-map/…`: `git status --porcelain` puts the
 * index and worktree status in the first two columns, either of which may be a
 * space, and the shared git helper trimmed the output before the columns were
 * counted. Only the first line was affected, so the mangling was one path per
 * run — the kind that reads as a genuine scope violation.
 */
import { describe, expect, it } from 'vitest';

import { changedPaths, type Repo } from '../engine/repo.ts';
import type { CommandResult, CommandRunner, RunOptions } from '../engine/shell.ts';

function repoReporting(diff: string, status: string): Repo {
  const runner: CommandRunner = {
    async run(command: string, _options: RunOptions): Promise<CommandResult> {
      if (command.includes('status --porcelain')) return { exitCode: 0, output: status };
      if (command.includes('diff --name-only')) return { exitCode: 0, output: diff };
      return { exitCode: 0, output: '' };
    },
  };
  return { root: '/target', runner };
}

const MODIFIED = ' M src/one.ts\n M src/two.ts\n';

describe('paths a run has changed', () => {
  it('keeps the first path whole when the status column is a space', async () => {
    const repo = repoReporting('', MODIFIED);
    await expect(changedPaths(repo, '/worktree', 'main')).resolves.toEqual(['src/one.ts', 'src/two.ts']);
  });

  it('reads staged, unstaged, and untracked lines alike', async () => {
    const repo = repoReporting('', 'M  staged.ts\n M unstaged.ts\n?? untracked.ts\n');
    await expect(changedPaths(repo, '/worktree', 'main')).resolves.toEqual([
      'staged.ts',
      'unstaged.ts',
      'untracked.ts',
    ]);
  });

  it('reports a rename by where the content now lives', async () => {
    const repo = repoReporting('', 'R  src/old.ts -> src/new.ts\n');
    await expect(changedPaths(repo, '/worktree', 'main')).resolves.toEqual(['src/new.ts']);
  });

  it('merges committed work with the working tree, without duplicates', async () => {
    const repo = repoReporting('src/one.ts\nsrc/three.ts\n', MODIFIED);
    await expect(changedPaths(repo, '/worktree', 'main')).resolves.toEqual([
      'src/one.ts',
      'src/three.ts',
      'src/two.ts',
    ]);
  });

  it('reports nothing rather than an empty path when nothing changed', async () => {
    const repo = repoReporting('', '');
    await expect(changedPaths(repo, '/worktree', 'main')).resolves.toEqual([]);
  });
});
