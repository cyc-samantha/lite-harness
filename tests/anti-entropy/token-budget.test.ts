/**
 * The always-loaded budget, as something that can fail rather than something
 * everyone agreed to respect.
 *
 * Prompt text is paid for on every spawn, forever, and it competes for attention
 * with the rules that actually constrain the work. Both costs are invisible at the
 * moment someone adds "just one more paragraph", which is why the limit has to be
 * a test rather than a guideline.
 *
 * Bytes rather than tokens: it is the measure available without a tokeniser, and
 * for prose in this repository it tracks closely enough to hold the line.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');

/** ~1,500 tokens of always-loaded rules. */
const RULES_LIMIT_BYTES = 6_000;

/** ~300 tokens per role definition. */
const ROLE_LIMIT_BYTES = 1_200;

describe('always-loaded budget', () => {
  it('keeps the core rules under the always-loaded limit', async () => {
    const { size } = await stat(join(ROOT, 'rules/core.md'));
    expect(size).toBeLessThanOrEqual(RULES_LIMIT_BYTES);
  });

  it('keeps every role definition under its limit', async () => {
    const dir = join(ROOT, 'roles');
    const names = (await readdir(dir)).filter((name) => name.endsWith('.md'));
    expect(names.length).toBeGreaterThan(0);

    const sizes = await Promise.all(
      names.map(async (name) => ({ name, size: (await stat(join(dir, name))).size })),
    );
    expect(sizes.filter((entry) => entry.size > ROLE_LIMIT_BYTES)).toEqual([]);
  });

  it('keeps repository facts out of role definitions', async () => {
    const dir = join(ROOT, 'roles');
    const names = (await readdir(dir)).filter((name) => name.endsWith('.md'));
    const texts = await Promise.all(
      names.map(async (name) => ({ name, text: await readFile(join(dir, name), 'utf8') })),
    );
    const offenders = texts
      .filter(({ text }) => /\b(npm|npx|vitest|eslint|tsc|package\.json)\b/.test(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });
});
