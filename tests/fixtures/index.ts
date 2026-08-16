/**
 * The baseline a rejection scenario mutates.
 *
 * Every preflight test starts from a contract and a project that pass, changes
 * exactly one thing, and asserts which check fires. Sharing one baseline is what
 * makes the assertion meaningful: if a test fails, the mutation is the only
 * candidate explanation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { loadProjectConfig, type ProjectConfig } from '../../ports/project-capabilities.ts';
import type { WorkContract, WorkItemState } from '../../ports/work-source.ts';
import type { PreflightDeps } from '../../engine/preflight.ts';

const HERE = import.meta.dirname;

export const SEALED_SHA = 'b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c';

function read(name: string): string {
  return readFileSync(join(HERE, name), 'utf8');
}

export function validContract(): WorkContract {
  return JSON.parse(read('valid-contract.json')) as WorkContract;
}

export function validProject(): ProjectConfig {
  const loaded = loadProjectConfig(parse(read('valid-project.yaml')));
  if (!loaded.ok) throw new Error(`fixture project.yaml does not load: ${JSON.stringify(loaded.problems)}`);
  return loaded.config;
}

export const TRACKED_FILES = [
  'src/board/export.ts',
  'src/board/render.ts',
  'src/board/legacy/old-export.ts',
  'src/api/routes.ts',
  'package-lock.json',
  'tests/board/export.test.ts',
];

export interface DepsOverrides {
  shaOf?: PreflightDeps['shaOf'];
  trackedFiles?: PreflightDeps['trackedFiles'];
  stateOf?: PreflightDeps['stateOf'];
  canRun?: PreflightDeps['canRun'];
  secretPresent?: PreflightDeps['secretPresent'];
}

/** A world in which the baseline passes, so any failure is the test's own mutation. */
export function workingDeps(overrides: DepsOverrides = {}): PreflightDeps {
  return {
    shaOf: overrides.shaOf ?? (async () => SEALED_SHA),
    trackedFiles: overrides.trackedFiles ?? (async () => TRACKED_FILES),
    stateOf: overrides.stateOf ?? (async (): Promise<WorkItemState> => 'done'),
    canRun: overrides.canRun ?? (async () => true),
    secretPresent: overrides.secretPresent ?? ((): boolean => true),
  };
}
