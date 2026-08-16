/**
 * Assembling a role's prompt, in the one order that lets the cache work.
 *
 * Slots run stablest-first, because a prompt cache reuses a prefix and stops at
 * the first byte that differs:
 *
 *   1. project    identical for every call against a repository, ever
 *                 (its declared gates, plus whatever the repo says about itself)
 *   2. contract   identical for every call within a run
 *   3. role       differs per role, small
 *   4. payload    differs per call
 *
 * Putting the role first — the obvious arrangement, and the one this design
 * started with — breaks the prefix at position one, so two roles in the same run
 * share nothing. Ordering by how widely a slot is shared rather than by how it
 * reads costs nothing and is what makes the sharing real.
 *
 * The payload type is the other reason this file exists. What a role may be told
 * is a property of the role, not a matter of remembering: a reviewer that can be
 * handed the context pack eventually will be, and its second reading stops being
 * independent the moment it is. Here that is not expressible.
 */
import type { ProjectConfig } from '../ports/project-capabilities.ts';
import type { AcceptanceCriterion, WorkContract } from '../ports/work-source.ts';

/**
 * What each role is allowed to receive.
 *
 * The reviewer's payload carries a diff and nothing else. It has no field for the
 * context pack, the repository, or how the implementation went — not because a
 * caller should refrain from passing them, but because there is nowhere to put
 * them.
 */
export type RolePayload =
  | { role: 'context-packer'; repoRoot: string }
  | { role: 'implementer'; worktree: string; contextPack: string; gateFailure?: string }
  | { role: 'reviewer'; diff: string }
  | { role: 'escalation-judge'; history: string[] }
  | { role: 'splitter'; filesChanged: number };

export interface PromptInputs {
  project: ProjectConfig;
  /**
   * What the target repository says about itself — conventions, module map,
   * the places people get caught. Empty when the repository does not have one.
   *
   * It sits in slot 1 beside the project declaration because it shares that
   * slot's property: one document per repository, identical across every call
   * ever made against it, so the cache holds it once.
   */
  repoNotes: string;
  contract: WorkContract;
  roleText: string;
  payload: RolePayload;
}

/**
 * How much of a repository's own notes a run will carry.
 *
 * Always-loaded text is paid for on every spawn and competes for attention with
 * the contract. A repository whose notes exceed this has written a manual rather
 * than an orientation, and the run is better served by the part that fits than
 * by a truncation nobody noticed — so the excess is dropped loudly.
 */
export const REPO_NOTES_LIMIT_BYTES = 8_000;

function renderRepoNotes(notes: string): string {
  const trimmed = notes.trim();
  if (!trimmed) return '';
  if (Buffer.byteLength(trimmed, 'utf8') <= REPO_NOTES_LIMIT_BYTES) return `\n\n## How this codebase works\n\n${trimmed}`;
  const kept = Buffer.from(trimmed, 'utf8').subarray(0, REPO_NOTES_LIMIT_BYTES).toString('utf8');
  return `\n\n## How this codebase works\n\n${kept}\n\n[truncated at ${REPO_NOTES_LIMIT_BYTES} bytes — this repository's notes are over the budget]`;
}

export interface AssembledPrompt {
  /** Slots 1–2: byte-identical across every role in a run. */
  sharedPrefix: string;
  text: string;
}

function renderGate(gate: ProjectConfig['gates'][number]): string {
  const notes = [gate.per_criterion ? 'per criterion' : '', gate.record_only ? 'measurement only' : '']
    .filter(Boolean)
    .join(', ');
  return `- ${gate.id}: \`${gate.run}\`${notes ? ` (${notes})` : ''}`;
}

function renderProject(project: ProjectConfig): string {
  return [
    '## This repository',
    '',
    'Gates, in the order they run. The first red one stops the rest:',
    ...project.gates.map(renderGate),
    '',
    `Paths nothing may change: ${project.protected_paths.join(', ') || '(none)'}`,
    `Branches are based on: ${project.pr.base}`,
  ].join('\n');
}

function renderCriterion(criterion: AcceptanceCriterion): string {
  const proof = criterion.targetTest
    ? `proved by \`${criterion.targetTest.name}\` in \`${criterion.targetTest.file}\``
    : `${criterion.verification} — a person decides this one`;
  return `- **${criterion.id}** ${criterion.text}\n  (${proof})`;
}

function renderContract(contract: WorkContract): string {
  return [
    '## This contract',
    '',
    `${contract.id} — ${contract.title}`,
    '',
    '### Acceptance criteria',
    ...contract.acceptance.map(renderCriterion),
    '',
    '### Boundary',
    `May change: ${contract.scope.include.join(', ')}`,
    `Must not touch: ${contract.scope.exclude.join(', ') || '(nothing named)'}`,
    '',
    '### Constraints',
    ...(contract.constraints.length > 0 ? contract.constraints.map((line) => `- ${line}`) : ['- (none stated)']),
  ].join('\n');
}

function renderPayload(payload: RolePayload): string {
  if (payload.role === 'context-packer') return `## Your task\n\nThe repository is at \`${payload.repoRoot}\`.`;
  if (payload.role === 'reviewer') return `## The diff\n\n\`\`\`diff\n${payload.diff}\n\`\`\``;
  if (payload.role === 'escalation-judge') return `## What happened\n\n${payload.history.map((line) => `- ${line}`).join('\n')}`;
  // The splitter is told how big the change is, not what is in it. Its question
  // is whether the criteria are independent, which the contract answers; a diff
  // would only invite it to review the code instead.
  if (payload.role === 'splitter') return `## Scale\n\nThis change touches ${payload.filesChanged} file(s).`;
  return renderImplementerPayload(payload);
}

function renderImplementerPayload(payload: Extract<RolePayload, { role: 'implementer' }>): string {
  const base = [`## Your task`, '', `Work in \`${payload.worktree}\`.`, '', '### Context pack', payload.contextPack];
  if (!payload.gateFailure) return base.join('\n');
  return [
    ...base,
    '',
    '### A gate came back red',
    '',
    'Fix this here. Do not weaken the test, and do not reach outside the boundary.',
    '',
    '```',
    payload.gateFailure,
    '```',
  ].join('\n');
}

export function assemble(inputs: PromptInputs): AssembledPrompt {
  const slotOne = `${renderProject(inputs.project)}${renderRepoNotes(inputs.repoNotes)}`;
  const sharedPrefix = `${slotOne}\n\n${renderContract(inputs.contract)}`;
  const text = `${sharedPrefix}\n\n${inputs.roleText.trim()}\n\n${renderPayload(inputs.payload)}\n`;
  return { sharedPrefix, text };
}
