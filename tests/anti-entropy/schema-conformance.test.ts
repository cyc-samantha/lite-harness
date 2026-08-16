/**
 * That the two things crossing the engine's boundary still mean what it thinks.
 *
 * A project declaration and a contract both arrive from outside this repository
 * and both are read by code that assumes a shape. When either format moves, the
 * failure would otherwise appear mid-run as a missing gate or an absent scope —
 * long after the point where it could be understood.
 */
import { describe, expect, it } from 'vitest';

import { parseContract } from '../../adapters/ticket-system/wire.ts';
import { loadProjectConfig } from '../../ports/project-capabilities.ts';
import { validProject } from '../fixtures/index.ts';

const WIRE_CONTRACT = {
  id: 'WC-0001',
  title: 'A contract as the work source puts it on the wire',
  source: { kind: 'spec', ref: 'specs/x.md' },
  target: 'some-repo',
  scope: { include: ['src/**'], exclude: [] },
  constraints: [],
  acceptance: [
    {
      id: 'AC-01',
      text: 'it holds',
      verification: 'executable_test',
      target_test: { file: 'tests/x.test.ts', name: 'holds' },
      provenance: 'human_authored',
      source_ref: 'specs/x.md#L1',
    },
  ],
  context: [{ uri: 'specs/x.md', content_sha: 'abc', retrieved_at: '2026-08-15T00:00:00Z', why: 'the spec' }],
  authority: { allowed: ['edit src'], requires_human: [], automation_level: 'agent-with-review' },
  irreversibility: 'refactor',
  risk: 'low',
  depends_on: [],
  blocking_decisions: [],
};

describe('the contract format', () => {
  it('maps the wire document onto the shape the engine reads', () => {
    const contract = parseContract(WIRE_CONTRACT);
    expect(contract.acceptance[0]?.targetTest).toEqual({ file: 'tests/x.test.ts', name: 'holds' });
    expect(contract.context[0]?.contentSha).toBe('abc');
    expect(contract.authority.automationLevel).toBe('agent-with-review');
  });

  it('keeps fields it does not use from leaking into the engine', () => {
    const contract = parseContract(WIRE_CONTRACT) as unknown as Record<string, unknown>;
    expect(contract['blocking_decisions']).toBeUndefined();
    expect(contract['source']).toBeUndefined();
  });

  it('refuses a document it cannot read rather than passing on a partial one', () => {
    const { scope: _dropped, ...withoutScope } = WIRE_CONTRACT;
    expect(() => parseContract(withoutScope)).toThrowError(/cannot read/);
  });
});

describe('the project declaration format', () => {
  it('loads the shipped example', () => {
    expect(validProject().gates.some((gate) => gate.per_criterion)).toBe(true);
  });

  it('refuses a version this engine does not understand', () => {
    const loaded = loadProjectConfig({ version: 99, gates: [{ id: 'x', run: 'true' }], pr: { base: 'main' } });
    expect(loaded.ok).toBe(false);
  });

  it('refuses a key it does not recognise, rather than ignoring it', () => {
    const loaded = loadProjectConfig({
      version: 1,
      gates: [{ id: 'x', run: 'true' }],
      pr: { base: 'main' },
      gatez: [],
    });
    expect(loaded.ok).toBe(false);
  });

  it('refuses a declaration with no gates at all', () => {
    const loaded = loadProjectConfig({ version: 1, gates: [], pr: { base: 'main' } });
    expect(loaded.ok).toBe(false);
  });
});
