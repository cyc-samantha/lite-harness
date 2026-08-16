/**
 * The boundary that cannot be talked around, and the tests that keep it that way.
 *
 * Two of these exist because the subtraction is one character from being undone:
 * `{ ...process.env, ... }` is a plausible-looking edit, it makes every awkward
 * gate failure go away, and nothing else in the suite would notice.
 */
import { describe, expect, it } from 'vitest';

import { BASE_NAMES, SecretUnavailable, baseEnvironment, gateEnvironment, missingSecrets } from '../engine/environment.ts';
import { shellRunner } from '../engine/shell.ts';
import type { ProjectConfig } from '../ports/project-capabilities.ts';

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    version: 2,
    env: { vars: {} },
    gates: [{ id: 'test', run: 'true', per_criterion: false, record_only: false }],
    protected_paths: [],
    permissions: {
      network_out: [],
      database_read: [],
      database_write: [],
      secrets: [],
      infrastructure_mutation: false,
      production_access: false,
    },
    pr: { base: 'main', branch_prefix: 'agent/', size_soft_limit: 10 },
    ...overrides,
  };
}

const AMBIENT = {
  PATH: '/usr/bin',
  HOME: '/home/someone',
  AWS_SECRET_ACCESS_KEY: 'not-a-real-key',
  DATABASE_URL: 'postgres://somewhere',
};

describe('the floor a command runs on', () => {
  it('carries what a shell needs to function', () => {
    expect(baseEnvironment(AMBIENT)).toEqual({ PATH: '/usr/bin', HOME: '/home/someone' });
  });

  it('omits a name it has no value for rather than defining it empty', () => {
    expect(Object.keys(baseEnvironment({ PATH: '/usr/bin' }))).toEqual(['PATH']);
  });

  it('grants no name that carries authority to reach anything', () => {
    const reaching = ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'DATABASE_URL', 'KUBECONFIG', 'AWS_PROFILE'];
    expect(BASE_NAMES.filter((name) => reaching.includes(name))).toEqual([]);
  });
});

describe('what the declaration actually grants', () => {
  it('withholds an ambient credential the project did not name', () => {
    const built = gateEnvironment({ project: project(), runId: 'r1', run: {}, ambient: AMBIENT });
    expect(built['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  });

  it('passes exactly the credential the project named', () => {
    const granted = project({ permissions: { ...project().permissions, secrets: ['DATABASE_URL'] } });
    const built = gateEnvironment({ project: granted, runId: 'r1', run: {}, ambient: AMBIENT });
    expect(built['DATABASE_URL']).toBe('postgres://somewhere');
    expect(built['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  });

  it('carries the values the project declared, with the run substituted in', () => {
    const declaring = project({ env: { vars: { TMPDIR_HINT: '/tmp/{run_id}', CI: 'true' } } });
    const built = gateEnvironment({ project: declaring, runId: 'run-7', run: {}, ambient: AMBIENT });
    expect(built['TMPDIR_HINT']).toBe('/tmp/run-7');
    expect(built['CI']).toBe('true');
  });

  it('tells the run about itself, so its own guards can see a run is in flight', () => {
    const run = { LITE_RUN_ID: 'run-7', LITE_WORKTREE: '/w/run-7', LITE_RUN_DIR: '/d/run-7' };
    const built = gateEnvironment({ project: project(), runId: 'run-7', run, ambient: AMBIENT });
    expect(built).toMatchObject(run);
  });
});

describe('a grant this machine cannot honour', () => {
  it('refuses rather than resolving the name to absent', () => {
    const granted = project({ permissions: { ...project().permissions, secrets: ['NOT_SET_ANYWHERE'] } });
    const build = (): unknown => gateEnvironment({ project: granted, runId: 'r1', run: {}, ambient: AMBIENT });
    expect(build).toThrow(SecretUnavailable);
  });

  it('names the variable and never its value', () => {
    const granted = project({ permissions: { ...project().permissions, secrets: ['DATABASE_URL', 'ABSENT'] } });
    expect(missingSecrets(granted, AMBIENT)).toEqual(['ABSENT']);
    try {
      gateEnvironment({ project: granted, runId: 'r1', run: {}, ambient: { ...AMBIENT, DATABASE_URL: '' } });
      expect.unreachable('a missing grant must refuse');
    } catch (error) {
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).not.toContain('postgres://somewhere');
    }
  });

  it('treats an exported-but-empty variable as absent, because it grants nothing', () => {
    const granted = project({ permissions: { ...project().permissions, secrets: ['BLANK'] } });
    expect(missingSecrets(granted, { ...AMBIENT, BLANK: '' })).toEqual(['BLANK']);
  });
});

describe('the spawned process, not just the object we built', () => {
  it('cannot see an ambient credential when the caller states no environment', async () => {
    process.env['LITE_TEST_FAKE_CREDENTIAL'] = 'must-not-leak';
    const result = await shellRunner.run('echo "[${LITE_TEST_FAKE_CREDENTIAL:-absent}]"', { cwd: process.cwd() });
    delete process.env['LITE_TEST_FAKE_CREDENTIAL'];
    expect(result.output).toContain('[absent]');
  });

  it('still finds its own binaries, or every gate fails for an unrelated reason', async () => {
    const result = await shellRunner.run('command -v bash >/dev/null && echo found', { cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('found');
  });
});
