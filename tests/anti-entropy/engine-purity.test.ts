/**
 * The one test that keeps "pluggable" from becoming a claim nobody checks.
 *
 * Every pressure on a harness pushes the same way: a project behaves slightly
 * differently, the fastest fix is one branch in the engine, and a year later the
 * engine is a pile of project-specific branches that no new project can be added
 * to. The rule survives only if breaking it fails the build.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ENGINE = join(import.meta.dirname, '../../engine');

/**
 * Names of concrete projects and work sources in this ecosystem. The engine may
 * be pointed at any of them and must recognise none of them.
 */
const PROJECT_NAMES = ['factory-map', 'algo-trading', 'ticket-system', 'lite-harness'];

async function engineSources(): Promise<{ name: string; text: string }[]> {
  const names = (await readdir(ENGINE)).filter((name) => name.endsWith('.ts'));
  return Promise.all(
    names.map(async (name) => ({ name, text: await readFile(join(ENGINE, name), 'utf8') })),
  );
}

describe('engine purity', () => {
  it('has sources to check, so a rename cannot silently empty this test', async () => {
    await expect(engineSources()).resolves.not.toHaveLength(0);
  });

  it('never imports an adapter', async () => {
    const offenders = (await engineSources())
      .filter(({ text }) => /from\s+['"][^'"]*adapters\//.test(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('never names a project', async () => {
    const offenders = (await engineSources()).flatMap(({ name, text }) =>
      PROJECT_NAMES.filter((project) => text.includes(project)).map((project) => `${name}: ${project}`),
    );
    expect(offenders).toEqual([]);
  });

  it('never hardcodes a host to talk to', async () => {
    const offenders = (await engineSources())
      .filter(({ text }) => /https?:\/\/(?!\S*example)/.test(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });
});
