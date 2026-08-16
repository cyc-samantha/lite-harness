/**
 * What world this run happened in, fixed at admission.
 *
 * A sealed contract answers what was approved. It does not answer what the work
 * was approved *against*, and that is a different question: the same contract,
 * run in March and again in May, can pass and then fail without one byte of it
 * changing. The base branch moved. The gate commands were edited. The engine was
 * upgraded. Evidence bound to the contract alone cannot tell those apart, and
 * the question — "why did this pass then and fail now?" — always arrives long
 * after both worlds are gone.
 *
 * So evidence binds to the contract *and* the basis it was executed on.
 *
 * Keys are snake_case because this IS the record written to the ledger, not a
 * view over one. The same reasoning as `ports/project-capabilities.ts`: a
 * camelCase mirror needs a mapping layer, and a mapping layer is somewhere for
 * the record and the reading of it to drift apart.
 */
import { createHash } from 'node:crypto';

/**
 * Bumped when what a run consumes or produces changes meaning — not when code
 * moves. A contract sealed this year is read by an engine shipped next year, and
 * "can this engine still honour that?" is only answerable if both said so.
 */
export const EXECUTION_PROTOCOL_VERSION = '1';

/** Bumped when `contract-shape.ts` changes what it will admit. */
export const CONTRACT_SCHEMA_VERSION = '1';

export interface ExecutionBasis {
  contract_sha: string;
  base_repo_sha: string;
  project_config_sha: string;
  harness_version: string;
  execution_protocol_version: string;
  contract_schema_version: string;
}

/**
 * The basis, plus what the run was permitted to reach while executing on it.
 *
 * Kept beside the basis rather than inside it: the basis is six strings that
 * hash to one field on every piece of evidence, and permissions are a document.
 * `project_config_sha` already pins them — this carries them in readable form so
 * that answering "what was this run allowed to do" does not require finding the
 * version of a config file that no longer exists.
 */
export interface ExecutionEnvelope {
  basis: ExecutionBasis;
  permissions: unknown;
}

/**
 * Fixed order, because it is what makes the digest stable. Two objects carrying
 * the same basis must hash alike whatever order their keys were written in.
 */
const FIELDS: readonly (keyof ExecutionBasis)[] = [
  'contract_sha',
  'base_repo_sha',
  'project_config_sha',
  'harness_version',
  'execution_protocol_version',
  'contract_schema_version',
];

export class UnknownBasis extends Error {
  constructor(missing: readonly string[]) {
    super(`this run cannot say what it executed against: ${missing.join(', ')} unknown`);
    this.name = 'UnknownBasis';
  }
}

/** The four an engine has to go and observe; the other two it already knows. */
export interface ObservedBasis {
  contractSha: string;
  baseRepoSha: string;
  projectConfigSha: string;
  harnessVersion: string;
}

function read(basis: ExecutionBasis, key: keyof ExecutionBasis): string {
  const value: unknown = basis[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * SAFETY: a basis missing any field is refused rather than recorded with a blank
 * in it. A blank is indistinguishable afterwards from a dimension nobody thought
 * to record, and the whole point of the basis is that a later reader can tell
 * "we did not check that" from "we checked, and it was this". Refusing costs one
 * failed admission; a blank costs the evidence its meaning.
 */
export function sealBasis(observed: ObservedBasis): ExecutionBasis {
  const basis: ExecutionBasis = {
    contract_sha: observed.contractSha,
    base_repo_sha: observed.baseRepoSha,
    project_config_sha: observed.projectConfigSha,
    harness_version: observed.harnessVersion,
    execution_protocol_version: EXECUTION_PROTOCOL_VERSION,
    contract_schema_version: CONTRACT_SCHEMA_VERSION,
  };
  const missing = FIELDS.filter((key) => !read(basis, key));
  if (missing.length > 0) throw new UnknownBasis(missing);
  return basis;
}

/**
 * One field that points back at the whole basis, so it fits somewhere a full
 * record does not — on every criterion's evidence, where six more columns would
 * not be paid for.
 */
export function basisSha(basis: ExecutionBasis): string {
  const missing = FIELDS.filter((key) => !read(basis, key));
  if (missing.length > 0) throw new UnknownBasis(missing);
  const canonical = FIELDS.map((key) => `${key}=${read(basis, key)}`).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}
