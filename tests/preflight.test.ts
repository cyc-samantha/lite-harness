/**
 * One rejection scenario per admission check.
 *
 * Each starts from a baseline that passes, changes exactly one thing, and asserts
 * that the named check is the one that fires. The baseline test at the top is what
 * makes the rest trustworthy: without it, a scenario could be passing because the
 * fixture is broken in some unrelated way.
 */
import { describe, expect, it } from 'vitest';

import { preflight, type PreflightCheck, type PreflightResult } from '../engine/preflight.ts';

import { validContract, validProject, workingDeps, type DepsOverrides } from './fixtures/index.ts';
import type { WorkContract } from '../ports/work-source.ts';
import type { ProjectConfig } from '../ports/project-capabilities.ts';

type Mutate = (contract: WorkContract, project: ProjectConfig) => void;

async function runWith(mutate: Mutate = () => {}, overrides: DepsOverrides = {}): Promise<PreflightResult> {
  const contract = validContract();
  const project = validProject();
  mutate(contract, project);
  return preflight(contract, project, workingDeps(overrides));
}

function checksIn(result: PreflightResult): PreflightCheck[] {
  return result.ok ? [] : result.failures.map((entry) => entry.check);
}

function reasonsIn(result: PreflightResult): string {
  return result.ok ? '' : result.failures.map((entry) => entry.reason).join(' | ');
}

describe('the baseline', () => {
  it('is admitted, so every rejection below is caused by its own mutation', async () => {
    await expect(runWith()).resolves.toEqual({ ok: true });
  });
});

describe('admission checks', () => {
  it('1. refuses a contract whose executable_test criterion names no test', async () => {
    const result = await runWith((contract) => {
      delete contract.acceptance[0]!.targetTest;
    });
    expect(checksIn(result)).toEqual(['contract_shape']);
    expect(reasonsIn(result)).toContain('AC-01');
  });

  it('1b. refuses a contract with an empty scope.include', async () => {
    const result = await runWith((contract) => {
      contract.scope.include = [];
    });
    expect(checksIn(result)).toEqual(['contract_shape']);
  });

  it('2. refuses a contract whose sealed context has since changed', async () => {
    const result = await runWith(undefined, { shaOf: async () => 'a-different-digest' });
    expect(checksIn(result)).toEqual(['seal_integrity']);
    expect(reasonsIn(result)).toContain('changed since the contract was sealed');
  });

  it('3. refuses work its own authority marks human-only', async () => {
    const result = await runWith((contract) => {
      contract.authority.automationLevel = 'human-only';
    });
    expect(checksIn(result)).toEqual(['authority']);
  });

  it('4. refuses a contract whose dependency has not completed', async () => {
    const result = await runWith(
      (contract) => {
        contract.dependsOn = ['WC-0000'];
      },
      { stateOf: async () => 'running' },
    );
    expect(checksIn(result)).toEqual(['dependencies']);
    expect(reasonsIn(result)).toContain('WC-0000 is running');
  });

  it('5. refuses executable tests the project declares no way to run', async () => {
    const result = await runWith((_contract, project) => {
      project.gates = project.gates.filter((gate) => !gate.per_criterion);
    });
    expect(checksIn(result)).toEqual(['capability_match']);
    expect(reasonsIn(result)).toContain('per_criterion');
  });

  it('5b. refuses a criterion whose mechanism the engine cannot evidence', async () => {
    const result = await runWith((contract) => {
      contract.acceptance[1]!.verification = 'deterministic_assertion';
      delete contract.acceptance[1]!.targetTest;
    });
    expect(checksIn(result)).toEqual(['unevidenceable_criterion']);
    expect(reasonsIn(result)).toContain('AC-02');
  });

  it('6. refuses a scope pattern that matches nothing in the repository', async () => {
    const result = await runWith((contract) => {
      contract.scope.include = ['src/does-not-exist/**'];
    });
    expect(checksIn(result)).toEqual(['scope_resolvable']);
    expect(reasonsIn(result)).toContain('src/does-not-exist/**');
  });

  it('7. refuses a scope that reaches into a protected path', async () => {
    const result = await runWith((contract) => {
      contract.scope.include = ['package-lock.json'];
    });
    expect(checksIn(result)).toEqual(['protected_path_conflict']);
    expect(reasonsIn(result)).toContain('package-lock.json');
  });

  it('8. refuses a gate whose command cannot be executed here', async () => {
    const result = await runWith(undefined, { canRun: async (command) => !command.includes('vitest') });
    expect(checksIn(result)).toContain('environment_ready');
    expect(reasonsIn(result)).toContain('target_test');
  });
});

describe('unevaluable input', () => {
  it('refuses when a context reference cannot be resolved at all', async () => {
    const result = await runWith(undefined, { shaOf: async () => undefined });
    expect(checksIn(result)).toEqual(['seal_integrity']);
    expect(reasonsIn(result)).toContain('could not be resolved');
  });

  it('refuses when the work source has never heard of a dependency', async () => {
    const result = await runWith(
      (contract) => {
        contract.dependsOn = ['WC-9999'];
      },
      { stateOf: async () => undefined },
    );
    expect(checksIn(result)).toEqual(['dependencies']);
    expect(reasonsIn(result)).toContain('unknown to this work source');
  });

  it('refuses a project declaration whose version this engine does not understand', async () => {
    const { loadProjectConfig } = await import('../ports/project-capabilities.ts');
    const loaded = loadProjectConfig({ version: 99, gates: [], pr: { base: 'main' } });
    expect(loaded.ok).toBe(false);
    expect(loaded.ok === false && loaded.problems[0]?.message).toContain('unsupported project.yaml version');
  });
});

/**
 * The three the seal can be read for but the engine cannot ask about. Each pairs
 * a case where the contract says the thing is settled with one where it does not,
 * because a check that refuses everything and a check that refuses the right
 * thing are indistinguishable from the refusing side alone.
 */
describe('what the seal has to say for itself', () => {
  it('refuses a criterion that is still a proposal rather than a requirement', async () => {
    const result = await runWith((contract) => {
      contract.acceptance[1]!.provenance = 'proposed';
    });
    expect(checksIn(result)).toEqual(['unaccepted_proposal']);
    expect(reasonsIn(result)).toContain('AC-02');
  });

  it('admits a criterion a person authored', async () => {
    await expect(
      runWith((contract) => {
        contract.acceptance[1]!.provenance = 'human_authored';
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('refuses a blocking decision the seal does not record an answer to', async () => {
    const result = await runWith((contract) => {
      contract.blockingDecisions = [{ id: 'WC-9', question: 'which currency?', owner: 'ana', deferred: false }];
    });
    expect(checksIn(result)).toEqual(['unanswered_decision']);
    expect(reasonsIn(result)).toContain('ana');
  });

  it('admits a decision somebody deliberately deferred', async () => {
    await expect(
      runWith((contract) => {
        contract.blockingDecisions = [{ id: 'WC-9', question: 'which currency?', owner: 'ana', deferred: true }];
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('admits a decision the seal carries the answer to', async () => {
    await expect(
      runWith((contract) => {
        contract.blockingDecisions = [
          { id: 'WC-9', question: 'which currency?', owner: 'ana', deferred: false, answer: 'GBP' },
        ];
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('treats a blank answer as no answer rather than as a resolution', async () => {
    const result = await runWith((contract) => {
      contract.blockingDecisions = [{ id: 'WC-9', question: 'q', owner: 'ana', deferred: false, answer: '   ' }];
    });
    expect(checksIn(result)).toEqual(['unanswered_decision']);
  });

  it('refuses unrecoverable work the seal carries no signature for', async () => {
    const result = await runWith((contract) => {
      contract.irreversibility = 'rewrite';
    });
    expect(checksIn(result)).toEqual(['missing_signature']);
  });

  it('refuses critical work the seal carries no signature for', async () => {
    const result = await runWith((contract) => {
      contract.risk = 'critical';
    });
    expect(checksIn(result)).toEqual(['missing_signature']);
  });

  it('admits unrecoverable work once the seal carries the signature', async () => {
    await expect(
      runWith((contract) => {
        contract.irreversibility = 'rewrite';
        contract.signature = { by: 'ana', at: '2026-08-16T00:00:00Z' };
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('refuses a contract that never declared whether it has blocking decisions', async () => {
    const result = await runWith((contract) => {
      delete (contract as Partial<WorkContract>).blockingDecisions;
    });
    expect(checksIn(result)).toEqual(['contract_shape']);
    expect(reasonsIn(result)).toContain('blockingDecisions');
  });
});

describe('cost of a rejection', () => {
  it('reads no source file — admission is contract shape and declared capability only', async () => {
    let sourceReads = 0;
    await runWith(
      (contract) => {
        contract.scope.include = ['src/does-not-exist/**'];
      },
      {
        trackedFiles: async () => {
          sourceReads += 1;
          return ['src/board/export.ts'];
        },
      },
    );
    expect(sourceReads).toBe(1);
  });
});
