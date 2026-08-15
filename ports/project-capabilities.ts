/**
 * What a target repository can do, declared by the repository itself.
 *
 * This is the whole of the engine's knowledge about any given codebase. Adding a
 * gate, changing a test runner, or onboarding a new project is an edit to this
 * file in that project — never a change to the engine. If the engine ever needs
 * to know something about a project that cannot be said here, that is the signal
 * to extend this schema, not to special-case the project.
 *
 * Keys are snake_case because this schema IS the file format, not a view over it.
 * A camelCase mirror would need a mapping layer, and a mapping layer is one more
 * place for the declaration and the engine's reading of it to drift apart.
 */
import { z } from 'zod';

const nonBlank = z.string().trim().min(1);

/** The only schema revision this engine understands. */
export const SUPPORTED_VERSION = 1;

/**
 * A command whose exit code is a verdict.
 *
 * `per_criterion` expands the gate once for every `executable_test` acceptance
 * criterion, substituting `{file}` and `{name}` — this is what lets one
 * declaration serve `vitest -t`, `pytest -k`, and `rspec -e` alike.
 *
 * `record_only` runs the command and keeps its output as a measurement without
 * letting it stop the run. A threshold nobody has data for is a guess, and a gate
 * that fails on a guess gets routed around until it means nothing.
 */
const gateSchema = z
  .object({
    id: nonBlank,
    run: nonBlank,
    per_criterion: z.boolean().default(false),
    record_only: z.boolean().default(false),
  })
  .strict();

/**
 * Per-run isolation, so two runs on one machine do not fight over ports,
 * temporary directories, or databases. `{run_id}` is substituted at run time.
 */
const envSchema = z
  .object({
    ports: z
      .object({ base: z.number().int().positive(), stride: z.number().int().positive() })
      .strict()
      .optional(),
    tmp: nonBlank.optional(),
    vars: z.record(nonBlank).default({}),
  })
  .strict();

const prSchema = z
  .object({
    base: nonBlank,
    branch_prefix: nonBlank.default('agent/'),
    size_soft_limit: z.number().int().positive().default(10),
  })
  .strict();

export const projectConfigSchema = z
  .object({
    version: z.number().int(),
    env: envSchema.default({ vars: {} }),
    gates: z.array(gateSchema).min(1),
    protected_paths: z.array(nonBlank).default([]),
    pr: prSchema,
  })
  .strict();

export type Gate = z.infer<typeof gateSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface ConfigProblem {
  path: string;
  message: string;
}

export type ConfigLoad =
  | { ok: true; config: ProjectConfig }
  | { ok: false; problems: ConfigProblem[] };

function unsupportedVersion(found: unknown): ConfigLoad {
  const message = `unsupported project.yaml version: ${JSON.stringify(found)} (this engine understands ${SUPPORTED_VERSION})`;
  return { ok: false, problems: [{ path: 'version', message }] };
}

function asProblems(error: z.ZodError): ConfigProblem[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message }));
}

function declaredVersion(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return undefined;
  return (raw as Record<string, unknown>)['version'];
}

/**
 * Parses a project declaration, refusing anything it cannot fully understand.
 *
 * SAFETY: an unrecognised `version` is refused outright rather than parsed on a
 * best-effort basis. A newer declaration read by an older engine would silently
 * drop whichever gates the engine does not yet know about, and a run that skips a
 * gate nobody noticed is exactly the failure this layer exists to prevent.
 */
export function loadProjectConfig(raw: unknown): ConfigLoad {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, problems: [{ path: '(root)', message: 'project.yaml is empty or not a mapping' }] };
  }
  if (declaredVersion(raw) !== SUPPORTED_VERSION) return unsupportedVersion(declaredVersion(raw));

  const parsed = projectConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: asProblems(parsed.error) };
  return { ok: true, config: parsed.data };
}
