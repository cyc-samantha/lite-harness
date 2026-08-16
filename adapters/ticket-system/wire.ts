/**
 * The shape agent-ticket-system puts on the wire, and how it becomes a WorkContract.
 *
 * This file is the entire coupling between the engine and one particular work
 * source. Everything upstream-specific lives here — snake_case keys, fields the
 * engine has no use for, the fact that a claim and a contract arrive from two
 * different endpoints. When the upstream schema moves, this is where it breaks,
 * and nothing in engine/ has to be read to fix it.
 *
 * SAFETY: the response is validated rather than cast. It arrives over HTTP from a
 * service this process does not control, and a contract that is merely assumed to
 * have a scope is one an agent could execute without a boundary.
 */
import { z } from 'zod';

import type { WorkContract } from '../../ports/work-source.ts';

const nonBlank = z.string().trim().min(1);

const wireCriterion = z
  .object({
    id: nonBlank,
    text: nonBlank,
    verification: z.enum(['executable_test', 'deterministic_assertion', 'human_review', 'rubric']),
    target_test: z.object({ file: nonBlank, name: nonBlank }).optional(),
    provenance: z.enum(['derived', 'human_authored', 'proposed']).optional(),
  })
  .passthrough();

/**
 * `answer` is optional because this source records answers in its own database
 * rather than in the seal. Reading it when present is what lets that change
 * without the engine changing too.
 */
const wireDecision = z
  .object({
    id: nonBlank,
    question: nonBlank,
    owner: nonBlank,
    deferred: z.boolean(),
    answer: nonBlank.optional(),
  })
  .passthrough();

const wireSignature = z.object({ by: nonBlank, at: nonBlank }).passthrough();

const wireContextRef = z
  .object({ uri: nonBlank, content_sha: nonBlank, why: nonBlank })
  .passthrough();

const wireAuthority = z
  .object({
    allowed: z.array(nonBlank),
    requires_human: z.array(nonBlank),
    automation_level: z.enum([
      'human-only',
      'human-approves',
      'agent-with-review',
      'agent-autonomous',
      'deterministic',
    ]),
  })
  .passthrough();

export const wireContractSchema = z
  .object({
    id: nonBlank,
    title: nonBlank,
    target: nonBlank,
    scope: z.object({ include: z.array(z.string()), exclude: z.array(z.string()) }),
    constraints: z.array(z.string()).default([]),
    acceptance: z.array(wireCriterion),
    context: z.array(wireContextRef).default([]),
    authority: wireAuthority,
    irreversibility: z.enum(['refactor', 'migration', 'rewrite']),
    risk: z.enum(['low', 'medium', 'high', 'critical']),
    depends_on: z.array(z.string()).default([]),
    blocking_decisions: z.array(wireDecision).default([]),
    signature: wireSignature.optional(),
  })
  .passthrough();

export type WireContract = z.infer<typeof wireContractSchema>;

function toCriterion(wire: WireContract['acceptance'][number]) {
  const base = { id: wire.id, text: wire.text, verification: wire.verification };
  const provenanced = wire.provenance ? { ...base, provenance: wire.provenance } : base;
  return wire.target_test ? { ...provenanced, targetTest: { ...wire.target_test } } : provenanced;
}

function toDecision(wire: WireContract['blocking_decisions'][number]) {
  const base = { id: wire.id, question: wire.question, owner: wire.owner, deferred: wire.deferred };
  return wire.answer ? { ...base, answer: wire.answer } : base;
}

export function toWorkContract(wire: WireContract): WorkContract {
  return {
    id: wire.id,
    title: wire.title,
    target: wire.target,
    scope: { include: [...wire.scope.include], exclude: [...wire.scope.exclude] },
    constraints: [...wire.constraints],
    acceptance: wire.acceptance.map(toCriterion),
    context: wire.context.map((ref) => ({ uri: ref.uri, contentSha: ref.content_sha, why: ref.why })),
    authority: {
      allowed: [...wire.authority.allowed],
      requiresHuman: [...wire.authority.requires_human],
      automationLevel: wire.authority.automation_level,
    },
    irreversibility: wire.irreversibility,
    risk: wire.risk,
    dependsOn: [...wire.depends_on],
    blockingDecisions: wire.blocking_decisions.map(toDecision),
    ...(wire.signature ? { signature: { by: wire.signature.by, at: wire.signature.at } } : {}),
  };
}

export function parseContract(raw: unknown): WorkContract {
  const parsed = wireContractSchema.safeParse(raw);
  if (parsed.success) return toWorkContract(parsed.data);
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`work source returned a contract this engine cannot read — ${detail}`);
}
