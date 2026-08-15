/**
 * The git operations a run needs, and no more.
 *
 * Every one of these runs against an explicit directory. Nothing here ever
 * changes what the target repository has checked out — a run works in a worktree
 * it created, so a person can keep using the repository while it does.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandRunner } from './shell.ts';

export interface Repo {
  root: string;
  runner: CommandRunner;
}

async function git(repo: Repo, args: string, cwd = repo.root): Promise<string> {
  const result = await repo.runner.run(`git ${args}`, { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args} failed: ${result.output}`);
  return result.output.trim();
}

export async function trackedFiles(repo: Repo): Promise<string[]> {
  const listing = await git(repo, 'ls-files');
  return listing.split('\n').filter((line) => line.length > 0);
}

/**
 * SAFETY: an unreadable reference resolves to undefined rather than to a digest
 * of nothing. Preflight treats that as a broken seal, which is the correct
 * reading — a reference the run cannot open is one it cannot claim to have read.
 */
export async function shaOfPath(repo: Repo, relativePath: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(join(repo.root, relativePath));
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return undefined;
  }
}

export interface WorktreeRequest {
  path: string;
  branch: string;
  base: string;
}

/**
 * A branch name git will accept, derived from a contract id.
 *
 * Contract ids are `<adapter>:<spec>:<slice>` by convention and a colon is not
 * legal in a ref, so joining a prefix to an id verbatim produces a name git
 * refuses. That failure lands after the work has already been claimed upstream,
 * which is the most expensive moment to discover it.
 *
 * SAFETY: an id that survives sanitising as nothing is refused rather than
 * turned into a bare prefix. Every such contract would otherwise collapse onto
 * the same branch, and the second run would fail on a collision whose cause is
 * nowhere in the message.
 */
export function branchName(prefix: string, contractId: string): string {
  const slug = contractId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-._]+|[-._]+$/g, '');
  if (!slug) throw new Error(`contract id has nothing a branch name can be built from: ${JSON.stringify(contractId)}`);
  return `${prefix}${slug}`;
}

export async function createWorktree(repo: Repo, request: WorktreeRequest): Promise<void> {
  await git(repo, `worktree add -b ${q(request.branch)} ${q(request.path)} ${q(request.base)}`);
}

export async function removeWorktree(repo: Repo, path: string): Promise<void> {
  await git(repo, `worktree remove --force ${q(path)}`);
}

function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Paths the run has touched, committed or not, relative to the worktree. */
export async function changedPaths(repo: Repo, worktree: string, base: string): Promise<string[]> {
  const committed = await git(repo, `diff --name-only ${q(base)}...HEAD`, worktree);
  const pending = await git(repo, 'status --porcelain', worktree);
  const working = pending.split('\n').map((line) => line.slice(3).trim());
  const all = [...committed.split('\n'), ...working].filter((path) => path.length > 0);
  return [...new Set(all)];
}

/** Everything this run changed, as a patch — committed work and working tree alike. */
export async function diffAgainst(repo: Repo, worktree: string, base: string): Promise<string> {
  return git(repo, `diff ${q(base)}`, worktree);
}

/**
 * Stages the named paths only. `git add -A` would sweep in whatever else is
 * sitting in the worktree — a stray credential file, a local scratch note — and
 * the run has no way to know what it just committed.
 */
export async function commitPaths(repo: Repo, worktree: string, paths: string[], message: string): Promise<void> {
  if (paths.length === 0) return;
  await git(repo, `add -- ${paths.map(q).join(' ')}`, worktree);
  await git(repo, `commit -m ${q(message)}`, worktree);
}
