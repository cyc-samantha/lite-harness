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

/**
 * The only schema revision this engine understands.
 *
 * Bumped to 2 when `permissions` became required. A version 1 file has not
 * declared what its runs may reach, and defaulting it silently would be the
 * whole point of the block missed.
 */
export const SUPPORTED_VERSION = 2;

/**
 * What a run may reach, beyond the files it may edit.
 *
 * Path scope is not execution scope. An agent that stays entirely inside
 * `src/payment.ts` — no scope violation, a clean diff, every gate green — can
 * still call an external API, drop a table, rotate a credential, or move money.
 * The filesystem boundary does not touch any of that, and on a financial
 * platform it is the smaller half of the question.
 *
 * DECLARATION, NOT ENFORCEMENT. Today this records what a repository intends;
 * only the filesystem and secret boundaries are actually enforced, by hooks.
 * Making the rest bite needs a real sandbox — network namespaces, a credential
 * broker, an isolated database — and that is a slice of its own. The shape is
 * here first because a declaration nobody wrote cannot be backfilled: it would
 * mean asking, a year from now, what every past run was allowed to do.
 *
 * Everything defaults to denied, so a repository that says nothing has said no.
 */
const permissionsSchema = z
  .object({
    /** Hosts a run may reach. Empty means none. */
    network_out: z.array(nonBlank).default([]),
    /** Datastores a run may read from, and separately write to. */
    database_read: z.array(nonBlank).default([]),
    database_write: z.array(nonBlank).default([]),
    /** Named credentials a run may use. Never patterns — a pattern grants what nobody read. */
    secrets: z.array(nonBlank).default([]),
    /** Whether a run may change infrastructure, and whether it may touch production at all. */
    infrastructure_mutation: z.boolean().default(false),
    production_access: z.boolean().default(false),
  })
  .strict();

export type Permissions = z.infer<typeof permissionsSchema>;

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
    // WHY required with defaulted members: `permissions: {}` is a repository
    // saying "we considered this and grant nothing", and no key at all is a
    // repository that never considered it. Only the first is a declaration.
    permissions: permissionsSchema,
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
