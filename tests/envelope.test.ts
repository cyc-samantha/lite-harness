/**
 * The execution basis, and the one property that makes it worth recording.
 *
 * A basis with a hole in it is worse than no basis: it reads like a complete
 * answer. Both entry points therefore refuse an incomplete one rather than
 * hashing whatever is present, and the tests below feed each of them an
 * unevaluable input to prove it.
 */
import { describe, expect, it } from 'vitest';

import {
  basisSha,
  CONTRACT_SCHEMA_VERSION,
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionBasis,
  type ObservedBasis,
  sealBasis,
  UnknownBasis,
} from '../engine/envelope.ts';

const OBSERVED: ObservedBasis = {
  contractSha: 'v-4489f70f',
  baseRepoSha: '1e52c70aa1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectConfigSha: 'a0b1c2d3e4f5',
  harnessVersion: '0.3.0',
};

describe('what a run records about the world it ran in', () => {
  it('carries the four it observed and the two it already knew', () => {
    const basis = sealBasis(OBSERVED);
    expect(basis.contract_sha).toBe('v-4489f70f');
    expect(basis.base_repo_sha).toBe(OBSERVED.baseRepoSha);
    expect(basis.execution_protocol_version).toBe(EXECUTION_PROTOCOL_VERSION);
    expect(basis.contract_schema_version).toBe(CONTRACT_SCHEMA_VERSION);
  });

  it('gives the same basis the same digest whatever order it was written in', () => {
    const forwards = sealBasis(OBSERVED);
    const backwards = Object.fromEntries(Object.entries(forwards).reverse()) as ExecutionBasis;
    expect(basisSha(backwards)).toEqual(basisSha(forwards));
  });

  it('tells two worlds apart when only the base moved', () => {
    const moved = sealBasis({ ...OBSERVED, baseRepoSha: 'xyz999aa1b2c3d4e5f60718293a4b5c6d7e8f90' });
    expect(basisSha(moved)).not.toEqual(basisSha(sealBasis(OBSERVED)));
  });

  it('tells two worlds apart when only the gate declarations changed', () => {
    const edited = sealBasis({ ...OBSERVED, projectConfigSha: 'ffffffffffff' });
    expect(basisSha(edited)).not.toEqual(basisSha(sealBasis(OBSERVED)));
  });
});

describe('an incomplete basis', () => {
  it('refuses at sealing rather than recording a blank', () => {
    expect(() => sealBasis({ ...OBSERVED, baseRepoSha: '' })).toThrow(UnknownBasis);
  });

  it('names which dimension it could not establish', () => {
    expect(() => sealBasis({ ...OBSERVED, contractSha: '   ' })).toThrow(/contract_sha/);
  });

  it('refuses at hashing too, so a record built elsewhere cannot slip past', () => {
    const holed = { ...sealBasis(OBSERVED), project_config_sha: '' };
    expect(() => basisSha(holed)).toThrow(UnknownBasis);
  });

  it('treats a field of the wrong type as unknown rather than stringifying it', () => {
    const wrong = { ...sealBasis(OBSERVED), harness_version: undefined } as unknown as ExecutionBasis;
    expect(() => basisSha(wrong)).toThrow(UnknownBasis);
  });
});
