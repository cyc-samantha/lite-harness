/**
 * What a command inherits from the machine it runs on.
 *
 * A declared boundary the runtime contradicts is worse than no boundary: with
 * `permissions.secrets` defaulting to an empty grant, a child spawned with the
 * operator's whole environment holds every credential that operator holds. The
 * declaration said none and the runtime gave all — and nothing in between ever
 * reported the disagreement.
 *
 * Subtraction is what closes that, and it is the only control here that cannot
 * be talked around. A guard that inspects command strings is defeated by one
 * indirection, because every command it permits is an arbitrary program; a
 * credential that is not in the environment is not reachable by any spelling of
 * any command. `aws s3 rb` with no key is a non-zero exit, and nobody had to
 * recognise it.
 *
 * SCOPE. This governs what the ENGINE spawns — gate ladders, git, probes. An
 * agent's own shell is a different surface: its environment comes from the
 * session that started it, which this process never sees. The boundary there is
 * `hooks/bash-boundary.sh`, and it is a weaker kind of boundary.
 */
import type { ProjectConfig } from '../ports/project-capabilities.ts';

/**
 * Without these a shell finds no binary and git finds no configuration, so every
 * gate fails for a reason unrelated to the work. None of them carries authority
 * to reach anything: they say where programs live, not what may be opened.
 */
export const BASE_NAMES: readonly string[] = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];

/**
 * SAFETY: names only, never values. This error is printed, logged and forwarded
 * upstream as a checkpoint, and a credential that reaches any of those has
 * leaked whether or not the run went on to use it.
 */
export class SecretUnavailable extends Error {
  constructor(names: readonly string[]) {
    super(`project.yaml grants ${names.join(', ')}, and this machine exports no such variable`);
    this.name = 'SecretUnavailable';
  }
}

export interface EnvironmentRequest {
  project: ProjectConfig;
  runId: string;
  /** What the engine exports about the run itself, so the run's own guards can see it. */
  run: Record<string, string>;
  ambient: NodeJS.ProcessEnv;
}

function inherited(names: readonly string[], ambient: NodeJS.ProcessEnv): Record<string, string> {
  const present = names.map((name) => [name, ambient[name]] as const).filter(([, value]) => value !== undefined);
  return Object.fromEntries(present) as Record<string, string>;
}

/**
 * The floor every spawned command gets, and the default in `shell.ts`.
 *
 * WHY a default rather than a required argument: a call site that forgets is the
 * likeliest way this boundary is lost, and a forgotten argument should fail
 * closed rather than fall through to the ambient environment.
 */
export function baseEnvironment(ambient: NodeJS.ProcessEnv): Record<string, string> {
  return inherited(BASE_NAMES, ambient);
}

/** Granted names this machine cannot supply — an admission problem, not a gate problem. */
export function missingSecrets(project: ProjectConfig, ambient: NodeJS.ProcessEnv): string[] {
  return project.permissions.secrets.filter((name) => !ambient[name]);
}

function declared(project: ProjectConfig, runId: string): Record<string, string> {
  const substituted = Object.entries(project.env.vars).map(([name, value]) => [name, value.replaceAll('{run_id}', runId)]);
  return Object.fromEntries(substituted) as Record<string, string>;
}

/**
 * SAFETY: a granted name this machine does not export refuses rather than
 * quietly resolving to absent. The project declared the run needs it; running
 * without it produces an authentication failure that reads like a code defect,
 * and an implementer will spend its repair budget on the wrong file.
 */
export function gateEnvironment(request: EnvironmentRequest): Record<string, string> {
  const missing = missingSecrets(request.project, request.ambient);
  if (missing.length > 0) throw new SecretUnavailable(missing);
  return {
    ...baseEnvironment(request.ambient),
    ...inherited(request.project.permissions.secrets, request.ambient),
    ...declared(request.project, request.runId),
    ...request.run,
  };
}
