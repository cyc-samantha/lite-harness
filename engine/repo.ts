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

async function gitRaw(repo: Repo, args: string, cwd = repo.root): Promise<string> {
  const result = await repo.runner.run(`git ${args}`, { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args} failed: ${result.output}`);
  return result.output;
}

async function git(repo: Repo, args: string, cwd = repo.root): Promise<string> {
  return (await gitRaw(repo, args, cwd)).trim();
}

export async function trackedFiles(repo: Repo): Promise<string[]> {
  const listing = await git(repo, 'ls-files');
  return listing.split('\n').filter((line) => line.length > 0);
}

/**
 * Every file in the worktree a run could have written, tracked or not.
 *
 * Untracked files are included because a test written during the run has not
 * been committed yet at the moment anything wants to look for it, and a test
 * that cannot be found reads exactly like a test that was never written.
 */
export async function worktreeFiles(repo: Repo, worktree: string): Promise<string[]> {
  const listing = await git(repo, 'ls-files --cached --others --exclude-standard', worktree);
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

/**
 * Which commit the run started from.
 *
 * Recorded at admission rather than read back later, because the point of it is
 * to pin a moving reference: `main` in March and `main` in May are the same name
 * and not the same world.
 */
export async function baseSha(repo: Repo, base: string): Promise<string> {
  return git(repo, `rev-parse ${q(base)}`);
}

export interface WorktreeRequest {
  path: string;
  branch: string;
  base: string;
}

/** How much of a run id is enough to tell two attempts apart in a branch name. */
const RUN_SUFFIX_LENGTH = 8;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-._]+|[-._]+$/g, '');
}

/**
 * A branch name git will accept, unique to this run.
 *
 * Two things make the obvious `prefix + contractId` wrong. Contract ids are
 * `<adapter>:<spec>:<slice>` by convention and a colon is not legal in a ref, so
 * the branch cannot be created at all — a failure that lands after the work is
 * already claimed upstream. And a contract that is retried would ask for a
 * branch that already exists, so the second attempt either fails on a collision
 * or silently continues the first attempt's work.
 *
 * The run id in the suffix is what makes the branch answerable afterwards: given
 * a branch, the ledger says which attempt produced it.
 *
 * SAFETY: an id that survives sanitising as nothing is refused rather than
 * quietly becoming a bare prefix, which would name the branch after no contract
 * in particular.
 */
export function branchName(prefix: string, contractId: string, runId: string): string {
  const slug = slugify(contractId);
  if (!slug) throw new Error(`contract id has nothing a branch name can be built from: ${JSON.stringify(contractId)}`);
  const suffix = slugify(runId).slice(0, RUN_SUFFIX_LENGTH);
  if (!suffix) throw new Error(`run id has nothing a branch name can be built from: ${JSON.stringify(runId)}`);
  return `${prefix}${slug}-${suffix}`;
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

/**
 * The path in one `git status --porcelain` line.
 *
 * The first two columns are the index and worktree status and either may be a
 * space, so the path starts at column three and the leading whitespace is
 * significant — which is why this reads unmodified output rather than trimmed
 * output. A rename is reported as `old -> new`; the run changed the new one.
 */
function porcelainPath(line: string): string {
  const path = line.slice(3).trim();
  const renamed = path.split(' -> ');
  return (renamed.at(-1) ?? path).trim();
}

/** Paths the run has touched, committed or not, relative to the worktree. */
export async function changedPaths(repo: Repo, worktree: string, base: string): Promise<string[]> {
  const committed = await git(repo, `diff --name-only ${q(base)}...HEAD`, worktree);
  const pending = await gitRaw(repo, 'status --porcelain', worktree);
  const working = pending.split('\n').filter((line) => line.length > 3).map(porcelainPath);
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
