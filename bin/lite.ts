#!/usr/bin/env node
/**
 * The composition root: where one concrete work source is wired to a generic engine.
 *
 * Nothing under engine/ may name a work source, a project, or a host — that rule is
 * what keeps the engine reusable, and a test enforces it. The wiring has to happen
 * somewhere, and this is that somewhere. It is the only file that knows both which
 * adapter is in use and which repository is being worked on.
 *
 * The subcommands below are the deterministic half of a run.
 *
 * The division is not arbitrary. Everything here is a decision a machine can make
 * and be held to — claiming, admitting, running gates, comparing a diff to a
 * scope, turning exit codes into evidence. Everything the orchestrator does
 * instead is a judgement: which files matter, how to satisfy a criterion, whether
 * a diff is sound. Putting a judgement in here would mean faking it, and putting a
 * verdict out there would mean asking a model to grade its own work.
 *
 * Every subcommand is safe to run twice. A run is resumed, not restarted, so a
 * second `pr` call must not open a second pull request.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { parse } from 'yaml';

import { ticketSystemSource } from '../adapters/ticket-system/index.ts';
import { loadProjectConfig, type ProjectConfig } from '../ports/project-capabilities.ts';
import type { Checkpoint, WorkContract, WorkSource } from '../ports/work-source.ts';

import { evidenceFrom } from '../engine/evidence.ts';
import { runLadder, type LadderResult } from '../engine/gates.ts';
import { renewLease } from '../engine/lease.ts';
import { preflight, type PreflightDeps } from '../engine/preflight.ts';
import { assemble, type RolePayload } from '../engine/prompt.ts';
import { branchName, changedPaths, createWorktree, diffAgainst, shaOfPath, trackedFiles, type Repo } from '../engine/repo.ts';
import { describeViolations, scopeViolations } from '../engine/scope-check.ts';
import { canRun, shellRunner } from '../engine/shell.ts';
import { advanced, hasReached, loadState, newRun, saveState, type RunState } from '../engine/state.ts';

/** This harness's own install directory — where roles/ lives. */
const HARNESS_ROOT = resolve(import.meta.dirname, '..');

interface Settings {
  dataDir: string;
  targetRoot: string;
  sourceUrl: string;
  agent: string;
  modelId: string;
}

function settings(): Settings {
  const home = process.env['HOME'] ?? '.';
  return {
    dataDir: process.env['LITE_DATA'] ?? join(home, '.claude', 'lite'),
    targetRoot: resolve(process.env['LITE_TARGET'] ?? process.cwd()),
    sourceUrl: process.env['LITE_SOURCE_URL'] ?? 'http://127.0.0.1:4600',
    agent: process.env['LITE_AGENT'] ?? 'lite-harness',
    // The engine cannot observe which model is driving it, and guessing would put
    // a fabricated value in the ledger. Unset is reported as unset.
    modelId: process.env['LITE_MODEL_ID'] ?? 'unreported',
  };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function projectConfig(targetRoot: string): Promise<ProjectConfig> {
  const path = join(targetRoot, '.harness', 'project.yaml');
  const raw = await readFile(path, 'utf8').catch(() => fail(`no project declaration at ${path}`));
  const loaded = loadProjectConfig(parse(raw));
  if (!loaded.ok) fail(`${path} is not usable:\n${loaded.problems.map((p) => `  ${p.path}: ${p.message}`).join('\n')}`);
  return loaded.config;
}

function preflightDeps(repo: Repo, source: WorkSource): PreflightDeps {
  return {
    shaOf: (uri) => shaOfPath(repo, uri),
    trackedFiles: () => trackedFiles(repo),
    stateOf: (contractId) => source.stateOf(contractId),
    canRun: (command) => canRun(command, repo.runner, repo.root),
  };
}

function runDir(config: Settings, runId: string): string {
  return dirname(join(config.dataDir, 'run', runId, 'state.json'));
}

function worktreeFor(config: Settings, runId: string): string {
  return join(config.dataDir, 'worktrees', runId);
}

async function writeArtifact(config: Settings, runId: string, name: string, body: unknown): Promise<void> {
  await writeFile(join(runDir(config, runId), name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

async function readArtifact<T>(config: Settings, runId: string, name: string): Promise<T> {
  const raw = await readFile(join(runDir(config, runId), name), 'utf8').catch(() =>
    fail(`this run has no ${name} yet`),
  );
  return JSON.parse(raw) as T;
}

async function loadRun(config: Settings, runId: string): Promise<RunState> {
  const state = await loadState(config.dataDir, runId);
  return state ?? fail(`unknown run: ${runId}`);
}

async function contractOf(config: Settings, runId: string): Promise<WorkContract> {
  return readArtifact<WorkContract>(config, runId, 'contract.json');
}

const now = (): string => new Date().toISOString();

/** The actor when the engine itself is reporting, rather than a role. */
const ENGINE = 'engine';

/**
 * Renews the lease, or stops.
 *
 * Renewing per command rather than on a timer is what a session-driven CLI can
 * honestly promise: between two subcommands there is no process alive to beat
 * from. The refusal itself lives in `engine/lease.ts`, where a test can reach it.
 */
async function beat(source: WorkSource, runId: string): Promise<void> {
  await renewLease(source, runId).catch((error: unknown) =>
    fail(`${error instanceof Error ? error.message : String(error)}\nThe work was requeued upstream. Claim it again rather than continuing.`),
  );
}

async function digestOf(path: string): Promise<string> {
  const bytes = await readFile(path).catch(() => undefined);
  return bytes ? createHash('sha256').update(bytes).digest('hex').slice(0, 12) : 'absent';
}

async function harnessVersion(): Promise<string> {
  const raw = await readFile(join(HARNESS_ROOT, 'package.json'), 'utf8').catch(() => '{}');
  return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
}

/**
 * Which actor produced this checkpoint, pinned to the exact text it was running.
 * A role's prompt changes far more often than the harness does, so the name alone
 * would not tell a later reader which implementer they are looking at.
 */
async function actorStamp(role: string, version: string): Promise<string> {
  if (role === ENGINE) return `${ENGINE}@${version}`;
  return `${role}@${await digestOf(join(HARNESS_ROOT, 'roles', `${role}.md`))}`;
}

/**
 * Reports progress upstream with the six fields that make it answerable later.
 *
 * These cost six fields now and a replay of every run in history if they are
 * added afterwards. Nothing in this slice reads them back — the reason to write
 * them is that the question they answer ("which prompt, which config, which
 * model produced this?") can only be asked of runs that already recorded it.
 */
async function sendCheckpoint(
  source: WorkSource,
  config: Settings,
  state: RunState,
  role: string,
  checkpoint: Checkpoint,
): Promise<void> {
  const version = await harnessVersion();
  const telemetry = {
    run_id: state.runId,
    contract_id: state.contractId,
    role: await actorStamp(role, version),
    config_hash: await digestOf(join(config.targetRoot, '.harness', 'project.yaml')),
    model_id: config.modelId,
    harness_version: version,
  };
  await source.checkpoint(state.runId, { ...checkpoint, payload: { ...checkpoint.payload, ...telemetry } });
}

/**
 * Claims the work, admits it, and prepares an isolated worktree — in that order,
 * so a contract that fails admission has cost one HTTP call and no filesystem.
 */
async function commandStart(contractId: string): Promise<void> {
  const config = settings();
  const source = ticketSystemSource({ baseUrl: config.sourceUrl });
  const repo: Repo = { root: config.targetRoot, runner: shellRunner };
  const project = await projectConfig(config.targetRoot);

  const claim = await source.claim(contractId, config.agent);
  const state = newRun(claim.runId, contractId, now());
  await saveState(config.dataDir, state);
  await writeArtifact(config, claim.runId, 'contract.json', claim.contract);

  const verdict = await preflight(claim.contract, project, preflightDeps(repo, source));
  if (!verdict.ok) {
    await sendCheckpoint(source, config, state, ENGINE, {
      step: 'preflight_refused',
      summary: `admission refused: ${verdict.failures.length} problem(s)`,
      payload: { failures: verdict.failures },
    });
    await source.fail(claim.runId);
    fail(verdict.failures.map((entry) => `  [${entry.check}] ${entry.reason}`).join('\n'));
  }

  const worktree = worktreeFor(config, claim.runId);
  const branch = branchName(project.pr.branch_prefix, contractId, claim.runId);
  await createWorktree(repo, { path: worktree, branch, base: project.pr.base });
  await saveState(config.dataDir, { ...advanced(state, 'admitted', now()), worktree, branch });
  await sendCheckpoint(source, config, state, ENGINE, {
    step: 'admitted',
    summary: 'admitted; worktree prepared',
    payload: { branch },
  });

  process.stdout.write(`${JSON.stringify({ runId: claim.runId, worktree, branch }, null, 2)}\n`);
}

async function commandGates(runId: string): Promise<void> {
  const config = settings();
  const state = await loadRun(config, runId);
  await beat(ticketSystemSource({ baseUrl: config.sourceUrl }), runId);
  const contract = await contractOf(config, runId);
  const project = await projectConfig(config.targetRoot);
  const worktree = state.worktree ?? fail('this run has no worktree');

  const ladder = await runLadder(contract, project, { cwd: worktree, runId, env: {} }, shellRunner);
  await writeArtifact(config, runId, 'ladder.json', ladder);
  await saveState(config.dataDir, ladder.passed
    ? advanced(state, 'gates_passed', now())
    : { ...state, gateAttempts: state.gateAttempts + 1, updatedAt: now() });

  const summary = ladder.outcomes.map((outcome) => `${outcome.passed ? 'ok  ' : 'FAIL'} ${outcome.gateId}`);
  process.stdout.write(`${summary.join('\n')}\n`);
  if (!ladder.passed) {
    const red = ladder.outcomes.at(-1);
    process.stdout.write(`\nstopped at ${ladder.stoppedAt}\n\n${red?.output ?? ''}\n`);
    process.exit(2);
  }
}

async function commandScope(runId: string): Promise<void> {
  const config = settings();
  const state = await loadRun(config, runId);
  await beat(ticketSystemSource({ baseUrl: config.sourceUrl }), runId);
  const contract = await contractOf(config, runId);
  const project = await projectConfig(config.targetRoot);
  const repo: Repo = { root: config.targetRoot, runner: shellRunner };
  const worktree = state.worktree ?? fail('this run has no worktree');

  const changed = await changedPaths(repo, worktree, project.pr.base);
  const violations = scopeViolations(changed, contract.scope);
  await writeArtifact(config, runId, 'changed.json', { changed, violations });
  if (violations.length === 0) {
    process.stdout.write(`${changed.length} file(s) changed, all inside scope\n`);
    return;
  }
  process.stderr.write(`change left the contract's boundary:\n${describeViolations(violations).map((v) => `  ${v}`).join('\n')}\n`);
  process.exit(2);
}

async function commandSubmit(runId: string): Promise<void> {
  const config = settings();
  const state = await loadRun(config, runId);
  const contract = await contractOf(config, runId);
  const ladder = await readArtifact<LadderResult>(config, runId, 'ladder.json');
  const source = ticketSystemSource({ baseUrl: config.sourceUrl });
  await beat(source, runId);

  if (hasReached(state, 'submitted')) fail('this run has already submitted its evidence');
  const evidence = evidenceFrom(contract, ladder);
  const verdict = await source.submit(runId, evidence);
  await saveState(config.dataDir, advanced(state, 'submitted', now()));
  await writeArtifact(config, runId, 'verdict.json', verdict);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
}

/**
 * Stores the context pack.
 *
 * It arrives on stdin rather than being written to a file, because the run's state
 * directory sits outside the worktree and the boundary guard — correctly — refuses
 * writes there.
 */
async function commandPack(runId: string): Promise<void> {
  const config = settings();
  const state = await loadRun(config, runId);
  await beat(ticketSystemSource({ baseUrl: config.sourceUrl }), runId);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const pack = Buffer.concat(chunks).toString('utf8').trim();
  if (!pack) fail('the context pack is empty');
  await writeFile(join(runDir(config, runId), 'pack.md'), `${pack}\n`, 'utf8');
  await saveState(config.dataDir, advanced(state, 'packed', now()));
  process.stdout.write(`stored ${pack.split('\n').length} line(s)\n`);
}

/**
 * Renews the lease without doing anything else.
 *
 * Implementing and reviewing happen inside a subagent, where no subcommand is
 * running and therefore nothing is renewing. This is the call the orchestrator
 * makes during those stretches — the alternative is a lease that lapses in the
 * middle of the one phase that reliably takes longest.
 */
async function commandBeat(runId: string): Promise<void> {
  const config = settings();
  const state = await loadRun(config, runId);
  await beat(ticketSystemSource({ baseUrl: config.sourceUrl }), runId);
  process.stdout.write(`lease renewed for ${state.contractId} (phase: ${state.phase})\n`);
}

/**
 * Records the pull request, upstream and locally.
 *
 * The work source has nowhere in `submit` to put a pull request URL, so a
 * checkpoint carries it instead. Without this the ledger shows a run that
 * produced evidence and no way for a person to reach what it produced.
 */
async function commandPr(runId: string, extra: string[]): Promise<void> {
  const config = settings();
  const url = extra[0] ?? fail('usage: pr <runId> <url>');
  const state = await loadRun(config, runId);
  const source = ticketSystemSource({ baseUrl: config.sourceUrl });
  await beat(source, runId);
  if (hasReached(state, 'pr_open')) fail(`this run already recorded a pull request: ${state.prUrl ?? 'url not stored'}`);

  const project = await projectConfig(config.targetRoot);
  const repo: Repo = { root: config.targetRoot, runner: shellRunner };
  const worktree = state.worktree ?? fail('this run has no worktree');
  const files = await changedPaths(repo, worktree, project.pr.base);

  await saveState(config.dataDir, { ...advanced(state, 'pr_open', now()), prUrl: url });
  await sendCheckpoint(source, config, state, ENGINE, {
    step: 'pr_opened',
    summary: `pull request open with ${files.length} file(s) changed`,
    payload: { url, branch: state.branch ?? '', files_changed: files },
  });
  process.stdout.write(`recorded ${url}\n`);
}

async function payloadFor(config: Settings, runId: string, role: string): Promise<RolePayload> {
  const state = await loadRun(config, runId);
  const worktree = state.worktree ?? fail('this run has no worktree');
  if (role === 'context-packer') return { role, repoRoot: config.targetRoot };
  if (role === 'implementer') return implementerPayload(config, runId, worktree);
  if (role === 'reviewer') return reviewerPayload(config, runId, worktree);
  fail(`unknown role: ${role}`);
}

async function implementerPayload(config: Settings, runId: string, worktree: string): Promise<RolePayload> {
  const contextPack = await readFile(join(runDir(config, runId), 'pack.md'), 'utf8').catch(() =>
    fail('no context pack stored yet — run `pack` first'),
  );
  const ladder = await readFile(join(runDir(config, runId), 'ladder.json'), 'utf8').catch(() => '');
  const failure = ladder ? (JSON.parse(ladder) as LadderResult) : undefined;
  const red = failure && !failure.passed ? failure.outcomes.at(-1) : undefined;
  const base = { role: 'implementer' as const, worktree, contextPack };
  return red ? { ...base, gateFailure: `${red.gateId}: ${red.output}` } : base;
}

/**
 * The reviewer's diff is computed here rather than passed in. Handing the caller
 * that job would mean the caller could hand over something else instead.
 */
async function reviewerPayload(config: Settings, runId: string, worktree: string): Promise<RolePayload> {
  const project = await projectConfig(config.targetRoot);
  const repo: Repo = { root: config.targetRoot, runner: shellRunner };
  return { role: 'reviewer', diff: await diffAgainst(repo, worktree, project.pr.base) };
}

/**
 * Prints a role's prompt, fully assembled.
 *
 * The orchestrator calls this instead of composing a prompt itself. That is what
 * makes the slot order and the per-role limits hold in practice rather than in a
 * document nobody rereads.
 */
async function commandPrompt(argument: string): Promise<void> {
  const [runId, role] = argument.split(':');
  if (!runId || !role) fail('usage: prompt <runId>:<context-packer|implementer|reviewer>');
  const config = settings();
  await beat(ticketSystemSource({ baseUrl: config.sourceUrl }), runId);
  const roleText = await readFile(join(HARNESS_ROOT, 'roles', `${role}.md`), 'utf8').catch(() =>
    fail(`no role definition for ${role}`),
  );
  const assembled = assemble({
    project: await projectConfig(config.targetRoot),
    contract: await contractOf(config, runId),
    roleText,
    payload: await payloadFor(config, runId, role),
  });
  process.stdout.write(assembled.text);
}

/** Forwards the local audit trail upstream, where a supervisor can read it. */
async function commandReport(runId: string): Promise<void> {
  const config = settings();
  const state = await loadRun(config, runId);
  const source = ticketSystemSource({ baseUrl: config.sourceUrl });
  await beat(source, runId);
  const path = join(runDir(config, runId), 'audit.jsonl');
  const lines = (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  await sendCheckpoint(source, config, state, ENGINE, {
    step: 'audit',
    summary: `${lines.length} tool call(s) recorded`,
    payload: { calls: lines.map((line) => JSON.parse(line) as unknown) },
  });
  process.stdout.write(`forwarded ${lines.length} audit line(s)\n`);
}

type Command = (argument: string, extra: string[]) => Promise<void>;

const COMMANDS: Record<string, Command> = {
  start: commandStart,
  gates: commandGates,
  scope: commandScope,
  submit: commandSubmit,
  pack: commandPack,
  prompt: commandPrompt,
  beat: commandBeat,
  pr: commandPr,
  report: commandReport,
};

async function main(): Promise<void> {
  const [name, argument, ...extra] = process.argv.slice(2);
  const command = name ? COMMANDS[name] : undefined;
  if (!command || !argument) fail(`usage: lite.ts <${Object.keys(COMMANDS).join('|')}> <id>`);
  await command(argument, extra);
}

await main();
