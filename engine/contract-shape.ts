/**
 * Whether a contract is shaped well enough to execute.
 *
 * This is not the wire-format check an adapter performs. An adapter proves the
 * response was the kind of document it expected; this proves the document
 * describes work an agent could actually finish and be judged on. A source with
 * a strong readiness gate will pass every rule here, and a source with no gate at
 * all — an issue tracker, a folder of YAML — will not. The engine cannot tell
 * which kind of source it is talking to, so it asks either way.
 */
import { z } from 'zod';

import type { WorkContract } from '../ports/work-source.ts';

const nonBlank = z.string().trim().min(1);

const targetTest = z.object({ file: nonBlank, name: nonBlank }).passthrough();

const criterion = z.object({
  id: nonBlank,
  text: nonBlank,
  verification: z.enum(['executable_test', 'deterministic_assertion', 'human_review', 'rubric']),
  targetTest: targetTest.optional(),
});

/**
 * WHY: an `executable_test` criterion with no named test reads as verifiable and
 * is not. Without the name, the run has to guess which test proves the criterion,
 * and a guess is what the evidence gate exists to remove.
 */
function requireTargetTest(value: z.infer<typeof criterion>, ctx: z.RefinementCtx): void {
  if (value.verification !== 'executable_test' || value.targetTest) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['targetTest'],
    message: `${value.id} is an executable_test criterion but names no test`,
  });
}

/** Evidence is reported per criterion id, so duplicates make a run's own report ambiguous. */
function requireUniqueIds(value: { acceptance: { id: string }[] }, ctx: z.RefinementCtx): void {
  const ids = value.acceptance.map((entry) => entry.id);
  if (new Set(ids).size === ids.length) return;
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['acceptance'], message: 'acceptance criterion ids must be unique' });
}

export const executableContractSchema = z
  .object({
    id: nonBlank,
    title: nonBlank,
    target: nonBlank,
    scope: z.object({ include: z.array(nonBlank).min(1), exclude: z.array(nonBlank) }),
    acceptance: z.array(criterion.superRefine(requireTargetTest)).min(1),
    context: z.array(z.object({ uri: nonBlank, contentSha: nonBlank, why: nonBlank }).passthrough()),
    authority: z.object({ automationLevel: nonBlank }).passthrough(),
    dependsOn: z.array(z.string()),
    // WHY required rather than defaulted: `blockingDecisions: []` and no key at
    // all look identical once parsed, and they mean "we considered this and
    // there are none" versus "nobody considered it". Only the first is safe to
    // execute, so the declaration has to be written down to count.
    blockingDecisions: z.array(z.object({ id: nonBlank, question: nonBlank, owner: nonBlank, deferred: z.boolean() }).passthrough()),
  })
  .passthrough()
  .superRefine(requireUniqueIds);

export function shapeProblems(contract: WorkContract): string[] {
  const parsed = executableContractSchema.safeParse(contract);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}
