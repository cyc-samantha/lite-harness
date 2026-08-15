/**
 * Whether the change stayed inside the boundary the contract stated.
 *
 * Declared scope is a prediction made before the work; this is the fact
 * afterwards. Comparing them is cheap and catches the failure mode a passing test
 * suite cannot: a change that works and was not the change anyone agreed to.
 *
 * This does not make concurrent runs safe. It narrows what one run touched, which
 * lowers the odds of two runs colliding — the guarantee comes from serialising the
 * merge, not from anything asserted here.
 */
import { minimatch } from 'minimatch';

import type { Scope } from '../ports/work-source.ts';

export interface ScopeViolation {
  path: string;
  reason: 'outside include' | 'matches exclude';
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern));
}

function violationFor(path: string, scope: Scope): ScopeViolation | undefined {
  if (matchesAny(path, scope.exclude)) return { path, reason: 'matches exclude' };
  if (!matchesAny(path, scope.include)) return { path, reason: 'outside include' };
  return undefined;
}

export function scopeViolations(changedPaths: string[], scope: Scope): ScopeViolation[] {
  return changedPaths
    .map((path) => violationFor(path, scope))
    .filter((violation) => violation !== undefined);
}

export function describeViolations(violations: ScopeViolation[]): string[] {
  return violations.map((violation) => `${violation.path} (${violation.reason})`);
}
