/**
 * Assembling a role's prompt, in the one order that lets the cache work.
 *
 * Slots run stablest-first, because a prompt cache reuses a prefix and stops at
 * the first byte that differs:
 *
 *   1. project    identical for every call against a repository, ever
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
  | { role: 'reviewer'; diff: string };

export interface PromptInputs {
  project: ProjectConfig;
  contract: WorkContract;
  roleText: string;
  payload: RolePayload;
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
  const sharedPrefix = `${renderProject(inputs.project)}\n\n${renderContract(inputs.contract)}`;
  const text = `${sharedPrefix}\n\n${inputs.roleText.trim()}\n\n${renderPayload(inputs.payload)}\n`;
  return { sharedPrefix, text };
}
