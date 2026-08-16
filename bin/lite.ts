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

import { basisSha, sealBasis, type ExecutionBasis } from '../engine/envelope.ts';
import { evidenceFrom, type TestLocator } from '../engine/evidence.ts';
import { classify, errorSignature, type FailureAction, type Observation } from '../engine/failure-table.ts';
import { runLadder, type GateOutcome, type LadderResult } from '../engine/gates.ts';
import { renewLease } from '../engine/lease.ts';
import { preflight, type PreflightDeps } from '../engine/preflight.ts';
import { assemble, type RolePayload } from '../engine/prompt.ts';
import { baseSha, branchName, changedPaths, createWorktree, diffAgainst, shaOfPath, trackedFiles, worktreeFiles, type Repo } from '../engine/repo.ts';
import { describeViolations, scopeViolations } from '../engine/scope-check.ts';
import { canRun, shellRunner } from '../engine/shell.ts';
import { advanced, elapsedMinutes, hasReached, loadState, newRun, saveState, type RunState } from '../engine/state.ts';

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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

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

/**
 * SAFETY: unlike `digestOf`, an unreadable file here stops the run. A role stamp
 * that reads `absent` is a slightly poorer audit trail; a basis that reads
 * `absent` is a run claiming to know what it executed against when it does not.
 */
async function requiredDigest(path: string): Promise<string> {
  const digest = await digestOf(path);
  return digest === 'absent' ? fail(`cannot digest ${path}, so this run cannot record what it executed against`) : digest;
}

const CONFIG_PATH = ['.harness', 'project.yaml'] as const;

/** Fixes the world at admission: the seal, the commit, the declarations, the engine. */
async function observeBasis(config: Settings, repo: Repo, base: string, sealVersion: string): Promise<ExecutionBasis> {
  return sealBasis({
    contractSha: sealVersion,
    baseRepoSha: await baseSha(repo, base).catch(() => fail(`cannot resolve ${base} in ${repo.root}`)),
    projectConfigSha: await requiredDigest(join(config.targetRoot, ...CONFIG_PATH)),
    harnessVersion: await harnessVersion(),
  });
}

async function basisOf(config: Settings, runId: string): Promise<ExecutionBasis> {
  return readArtifact<ExecutionBasis>(config, runId, 'basis.json');
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

/** Everything a progress report needs to say who wrote it and from what world. */
interface Reporter {
  source: WorkSource;
  config: Settings;
  state: RunState;
  basis: ExecutionBasis;
}

/**
 * Reports progress upstream, stamped with the world the run is executing in.
 *
 * The basis is the expensive half to add late — every run already in the ledger
 * would have to be replayed to acquire it, and the worlds they ran in are gone.
 * `model_id` rides along beside it rather than inside it: the engine cannot
 * observe which model is driving, so it is reported, not established, and it
 * must not sit in a record whose whole claim is that it was observed.
 */
async function sendCheckpoint(to: Reporter, role: string, checkpoint: Checkpoint): Promise<void> {
  const telemetry = {
    run_id: to.state.runId,
    contract_id: to.state.contractId,
    role: await actorStamp(role, to.basis.harness_version),
    model_id: to.config.modelId,
    execution_basis: to.basis,
    envelope_sha: basisSha(to.basis),
  };
  await to.source.checkpoint(to.state.runId, { ...checkpoint, payload: { ...checkpoint.payload, ...telemetry } });
}

/**
 * How many runs one contract may have before a person looks at it.
 *
 * The two retry limits count different things and must not be conflated. Inside
 * a run, a red gate is retried by the implementer that wrote the code. At this
 * level, a whole run failed and a fresh one starts from nothing. Leave either
 * uncapped and the other multiplies it.
 */
const RUN_ATTEMPT_LIMIT = 2;

/**
 * SAFETY: a history that cannot be read stops the claim rather than allowing it.
 * This cap is the only thing counting run attempts — the work source records
 * them and does not limit them — so treating an unreadable history as "no
 * attempts yet" would remove the limit exactly when the source is unhealthy,
 * which is when runs are most likely to be failing and being retried.
 */
async function refuseExhaustedContract(source: WorkSource, contractId: string): Promise<void> {
  const spent = await source.attemptsSpent(contractId).catch((error: unknown) =>
    fail(`cannot count the attempts already spent on ${contractId}: ${error instanceof Error ? error.message : String(error)}`),
  );
  if (spent < RUN_ATTEMPT_LIMIT) return;
  fail(`${contractId} has already had ${spent} run(s) and the limit is ${RUN_ATTEMPT_LIMIT}. A third attempt at unchanged work is a person's decision, not this run's.`);
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

  await refuseExhaustedContract(source, contractId);
  // Losing a race to claim is an ordinary outcome of polling a shared queue, not
  // a crash. A stack trace here would tell an operator to debug the harness when
  // the correct response is to take the next contract.
  const claim = await source.claim(contractId, config.agent).catch((error: unknown) =>
    fail(`could not claim ${contractId}: ${error instanceof Error ? error.message : String(error)}`),
  );
  const state = newRun(claim.runId, contractId, now());
  await saveState(config.dataDir, state);
  await writeArtifact(config, claim.runId, 'contract.json', claim.contract);

  const basis = await observeBasis(config, repo, project.pr.base, claim.sealVersion);
  await writeArtifact(config, claim.runId, 'basis.json', basis);
  const to: Reporter = { source, config, state, basis };

  const verdict = await preflight(claim.contract, project, preflightDeps(repo, source));
  if (!verdict.ok) {
    await sendCheckpoint(to, ENGINE, {
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
  await sendCheckpoint(to, ENGINE, {
    step: 'admitted',
    summary: 'admitted; worktree prepared',
    payload: { branch },
  });

  process.stdout.write(`${JSON.stringify({ runId: claim.runId, worktree, branch }, null, 2)}\n`);
}

/**
 * How many rungs a run may execute, and how long it may take.
 *
 * These are the executor's limits, not the project's, so they are not in
 * `project.yaml`: a target repository declares what it can do, not how much of
 * somebody else's budget a run may spend on it. Both are things the engine can
 * count without asking a model what it thinks it used.
 */
function ceiling(): { maxGateRuns: number; maxWallMinutes: number } {
  return {
    maxGateRuns: Number(process.env['LITE_MAX_GATE_RUNS'] ?? 30),
    maxWallMinutes: Number(process.env['LITE_MAX_WALL_MINUTES'] ?? 90),
  };
}

/** Retries of this same gate, counting the red that just happened. */
function attemptsOn(state: RunState, gateId: string): number {
  return state.lastRed?.gateId === gateId ? state.gateAttempts + 1 : 1;
}

function observe(state: RunState, red: GateOutcome, gateRuns: number): Observation {
  const sameGate = state.lastRed?.gateId === red.gateId;
  return {
    redGate: { gateId: red.gateId, exitCode: red.exitCode, output: red.output },
    ...(sameGate && state.lastRed ? { previousSignature: state.lastRed.signature } : {}),
    attemptsOnThisGate: attemptsOn(state, red.gateId),
    sealBroken: false,
    scopeViolations: 0,
    baseMoved: false,
    budget: { gateRuns, wallMinutes: elapsedMinutes(state, now()), ...ceiling() },
  };
}

/**
 * A red rung the orchestrator should repair in place exits 2; anything it must
 * not simply retry exits 3. The distinction is the whole point of the table —
 * without it every failure looks like "try again", which is how a run spends its
 * budget discovering nothing.
 */
const RETRYABLE: readonly FailureAction[] = ['retry', 'retry_in_place', 'rebase_and_retry'];

async function commandGates(runId: string): Promise<void> {
  const config = settings();
  const state = await loadRun(config, runId);
  await beat(ticketSystemSource({ baseUrl: config.sourceUrl }), runId);
  const contract = await contractOf(config, runId);
  const project = await projectConfig(config.targetRoot);
  const worktree = state.worktree ?? fail('this run has no worktree');

  const ladder = await runLadder(contract, project, { cwd: worktree, runId, env: {} }, shellRunner);
  await writeArtifact(config, runId, 'ladder.json', ladder);
  const gateRuns = state.gateRuns + ladder.outcomes.length;

  process.stdout.write(`${ladder.outcomes.map((o) => `${o.passed ? 'ok  ' : 'FAIL'} ${o.gateId}`).join('\n')}\n`);
  if (ladder.passed) {
    await saveState(config.dataDir, { ...advanced(state, 'gates_passed', now()), gateRuns, gateAttempts: 0 });
    return;
  }
  await reportRed(config, state, ladder, gateRuns);
}

async function reportRed(config: Settings, state: RunState, ladder: LadderResult, gateRuns: number): Promise<void> {
  const red = ladder.outcomes.at(-1) ?? fail('the ladder failed without a failing rung, which it cannot do');
  const decision = classify(observe(state, red, gateRuns));
  await saveState(config.dataDir, {
    ...state,
    gateRuns,
    gateAttempts: attemptsOn(state, red.gateId),
    lastRed: { gateId: red.gateId, signature: errorSignature(red.output) },
    updatedAt: now(),
  });

  process.stdout.write(`\nstopped at ${ladder.stoppedAt}\n\n${red.output}\n`);
  process.stdout.write(`\n${decision.category} → ${decision.action}\n${decision.why}\n`);
  process.exit(RETRYABLE.includes(decision.action) ? 2 : 3);
}

/**
 * Reports why this run is handing the work back, and hands it back.
 *
 * The packet arrives on stdin because its useful content is a judgement — what
 * was seen, what was tried, what should change — and that is the orchestrator's
 * to write. What this command guarantees is that the judgement reaches the
 * ledger and that the work is released rather than left to time out.
 *
 * `amend` is the third road, and the one most often missing: a run that finds the
 * sealed contract self-contradictory should neither quietly build something else
 * nor simply give up. Both of those are worse than saying so.
 */
async function commandEscalate(runId: string, extra: string[]): Promise<void> {
  const config = settings();
  const state = await loadRun(config, runId);
  const source = ticketSystemSource({ baseUrl: config.sourceUrl });
  const amending = extra[0] === 'amend';
  const packet = await readStdin();
  if (!packet) fail('an escalation with no account of what happened is worth nothing — write the packet on stdin');

  await sendCheckpoint({ source, config, state, basis: await basisOf(config, runId) }, ENGINE, {
    step: amending ? 'amendment_proposed' : 'escalated',
    summary: packet.split('\n')[0]?.slice(0, 200) ?? 'escalated',
    payload: { packet, phase: state.phase, gate_runs: state.gateRuns, last_red: state.lastRed ?? null },
  });
  await source.fail(runId);
  process.stdout.write(`${amending ? 'amendment proposed' : 'escalated'}; the work is back with its source\n`);
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

  // Before the lease, not after: submitting settles the run and releases the
  // lease, so a replayed submit would otherwise be told its lease had lapsed and
  // to claim the work again — which is how finished work gets done twice.
  if (hasReached(state, 'submitted')) fail('this run has already submitted its evidence');
  await beat(source, runId);
  const evidence = evidenceFrom({
    contract,
    ladder,
    locate: await namedTests(config, state),
    envelopeSha: basisSha(await basisOf(config, runId)),
  });
  const verdict = await source.submit(runId, evidence);
  await saveState(config.dataDir, advanced(state, 'submitted', now()));
  await writeArtifact(config, runId, 'verdict.json', verdict);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
}

/**
 * Finds the tests the contract names, so a green rung can be believed.
 *
 * A criterion's `file` is written relative to wherever the test runner runs,
 * which is the project's business and not the engine's — so the match is on the
 * end of the path rather than the whole of it. The name is looked for as literal
 * text in that file, which is the most any engine can check without knowing the
 * language it is reading.
 */
async function namedTests(config: Settings, state: RunState): Promise<TestLocator> {
  const worktree = state.worktree ?? fail('this run has no worktree');
  const repo: Repo = { root: config.targetRoot, runner: shellRunner };
  const files = await worktreeFiles(repo, worktree);
  const contents = new Map<string, string>();
  for (const path of files) contents.set(path, await readFile(join(worktree, path), 'utf8').catch(() => ''));

  return (criterion) => {
    const test = criterion.targetTest;
    if (!test) return false;
    const candidates = files.filter((path) => path === test.file || path.endsWith(`/${test.file}`));
    return candidates.some((path) => (contents.get(path) ?? '').includes(test.name));
  };
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
  const pack = await readStdin();
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
  // Asked of the local record before the network, so the answer to "has this
  // already happened" never depends on the run still being live.
  if (hasReached(state, 'pr_open')) fail(`this run already recorded a pull request: ${state.prUrl ?? 'url not stored'}`);
  await beat(source, runId);

  const project = await projectConfig(config.targetRoot);
  const repo: Repo = { root: config.targetRoot, runner: shellRunner };
  const worktree = state.worktree ?? fail('this run has no worktree');
  const files = await changedPaths(repo, worktree, project.pr.base);

  await saveState(config.dataDir, { ...advanced(state, 'pr_open', now()), prUrl: url });
  await sendCheckpoint({ source, config, state, basis: await basisOf(config, runId) }, ENGINE, {
    step: 'pr_opened',
    summary: `pull request open with ${files.length} file(s) changed`,
    payload: { url, branch: state.branch ?? '', files_changed: files },
  });
  process.stdout.write(`recorded ${url}\n`);
}

async function payloadFor(config: Settings, runId: string, role: string): Promise<RolePayload> {
  const state = await loadRun(config, runId);
  if (role === 'context-packer') return { role, repoRoot: config.targetRoot };
  if (role === 'escalation-judge') return { role, history: await failureHistory(config, state) };
  const worktree = state.worktree ?? fail('this run has no worktree');
  if (role === 'implementer') return implementerPayload(config, runId, worktree);
  if (role === 'reviewer') return reviewerPayload(config, runId, worktree);
  if (role === 'splitter') return splitterPayload(config, state, worktree);
  fail(`unknown role: ${role}`);
}

/**
 * What this run has been through, in the terms the table decided them in.
 *
 * The judge gets the history and not the repository. It is being asked whether
 * the contract can be delivered at all, and a judge that can go and look will
 * start solving the problem instead of answering the question.
 */
async function failureHistory(config: Settings, state: RunState): Promise<string[]> {
  const ladder = await readFile(join(runDir(config, state.runId), 'ladder.json'), 'utf8').catch(() => '');
  const result = ladder ? (JSON.parse(ladder) as LadderResult) : undefined;
  const red = result && !result.passed ? result.outcomes.at(-1) : undefined;
  return [
    `phase reached: ${state.phase}`,
    `gate rungs run: ${state.gateRuns}, retries on the last red gate: ${state.gateAttempts}`,
    `elapsed: ${Math.round(elapsedMinutes(state, now()))} minute(s)`,
    ...(red ? [`last red: ${red.gateId} exited ${red.exitCode}`, `output: ${red.output.slice(-2_000)}`] : []),
  ];
}

async function splitterPayload(config: Settings, state: RunState, worktree: string): Promise<RolePayload> {
  const project = await projectConfig(config.targetRoot);
  const repo: Repo = { root: config.targetRoot, runner: shellRunner };
  const changed = await changedPaths(repo, worktree, project.pr.base);
  return { role: 'splitter', filesChanged: changed.length };
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
  if (!runId || !role) fail('usage: prompt <runId>:<context-packer|implementer|reviewer|splitter|escalation-judge>');
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
  await sendCheckpoint({ source, config, state, basis: await basisOf(config, runId) }, ENGINE, {
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
  escalate: commandEscalate,
  report: commandReport,
};

async function main(): Promise<void> {
  const [name, argument, ...extra] = process.argv.slice(2);
  const command = name ? COMMANDS[name] : undefined;
  if (!command || !argument) fail(`usage: lite.ts <${Object.keys(COMMANDS).join('|')}> <id>`);
  await command(argument, extra);
}

await main();
