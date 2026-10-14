/**
 * Shared test helpers.
 *
 * Everything here reads the real snapshot under `vendor/upstream`, so the tests assert
 * against the bytes the running provider serves rather than against a paraphrase of them.
 */

import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument, readRequiredKeys } from '../lib/frontmatter.js';

export const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
export const snapshotRoot = join(repoRoot, 'vendor', 'upstream');
export const checkoutRoot = join(repoRoot, 'submodule', 'dotnet-skills');

/**
 * The scalar form a description uses upstream.
 *
 * The parser supports only the forms the baseline actually contains (§5.1), so the form
 * has to be derived from the source line rather than inferred from the parse result.
 *
 * @param {string} source - full `SKILL.md` text
 * @returns {'plain' | 'double' | 'single' | 'folded' | 'folded-strip' | 'unknown'}
 */
export function descriptionForm(source) {
  const line = source.split('\n').find((candidate) => candidate.startsWith('description:'));
  if (line === undefined) return 'unknown';
  const value = line.slice('description:'.length).trim();
  const first = value[0];
  if (first === '>') return value === '>-' ? 'folded-strip' : 'folded';
  if (first === '"') return 'double';
  if (first === "'") return 'single';
  return 'plain';
}

/**
 * One skill as the snapshot holds it.
 *
 * @typedef {object} SnapshotSkill
 * @property {string} plugin
 * @property {string} name
 * @property {string} dir
 * @property {string} skillFile
 * @property {string} source
 * @property {Map<string, string>} frontmatter
 * @property {string} body
 * @property {string} description - normalised upstream description
 * @property {boolean} userInvocable
 * @property {string} form
 */

/**
 * @param {string} [root]
 * @returns {SnapshotSkill[]}
 */
export function readSnapshotSkills(root = snapshotRoot) {
  /** @type {SnapshotSkill[]} */
  const skills = [];
  for (const plugin of readdirSync(root, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const skillsDir = join(root, plugin.name, 'skills');
    let entries;
    try {
      entries = readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory()) continue;
      const dir = join(skillsDir, entry.name);
      const skillFile = join(dir, 'SKILL.md');
      const source = readFileSync(skillFile, 'utf8');
      const { frontmatter, body } = parseDocument(source);
      const required = readRequiredKeys(frontmatter);
      if (!required.ok) throw new Error(`${plugin.name}/${entry.name}: ${required.reason}`);
      skills.push({
        plugin: plugin.name,
        name: entry.name,
        dir,
        skillFile,
        source,
        frontmatter,
        body,
        description: required.description,
        userInvocable: required.userInvocable,
        form: descriptionForm(source),
      });
    }
  }
  return skills;
}

/** One skill of the real baseline, by `<plugin>/<skill>`. */
export function requireSkill(skills, key) {
  const found = skills.find((skill) => `${skill.plugin}/${skill.name}` === key);
  if (found === undefined) throw new Error(`snapshot does not contain ${key}`);
  return found;
}

/**
 * Build a throwaway snapshot directory so provider and selection tests can control
 * exactly what the content source sees.
 *
 * @param {Record<string, string>} files - path relative to the snapshot root → file text
 * @returns {{ root: string, dispose: () => void }}
 */
export function makeTempSnapshot(files) {
  const root = mkdtempSync(join(tmpdir(), 'dotnet-skills-test-'));
  for (const [relative, text] of Object.entries(files)) {
    const full = join(root, relative.split('/').join(sep));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return {
    root,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Copy the real snapshot into a throwaway directory that tests may mutate. */
export function cloneSnapshot() {
  const root = mkdtempSync(join(tmpdir(), 'dotnet-skills-clone-'));
  cpSync(snapshotRoot, root, { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * A synthetic population and provenance record for gate tests.
 *
 * Injected skills keep the description-invariant suite independent of both the snapshot
 * range and the development checkout, so a case can state exactly the upstream text it is
 * about — including shapes the baseline has no sample of.
 *
 * @param {Array<{ name: string, plugin?: string, description?: string, markdown?: string }>} specs
 * @returns {{ skills: object[], manifest: object, data: object }}
 */
export function makeFakePopulation(specs) {
  const skills = specs.map((spec) => {
    const plugin = spec.plugin ?? 'dotnet';
    const description = spec.description ?? 'A synthetic skill used by the gate tests.';
    return {
      key: `${plugin}/${spec.name}`,
      plugin,
      name: spec.name,
      description,
      userInvocable: true,
      markdown: spec.markdown ?? `---
name: ${spec.name}
description: ${description}
---
`,
    };
  });
  const byPlugin = new Map();
  for (const skill of skills) {
    if (!byPlugin.has(skill.plugin)) byPlugin.set(skill.plugin, []);
    byPlugin.get(skill.plugin).push(skill.name);
  }
  const manifest = {
    repo: 'https://github.com/dotnet/skills',
    tag: 'v1.0.0',
    commit: 'cb7c10bd32b250459632df9e6fa1350cdaf00b18',
    includedPlugins: [...byPlugin.entries()].map(([name, names]) => ({
      name,
      version: '0.1.0',
      skills: names,
      skillCount: names.length,
    })),
    excludedPlugins: [],
    upstreamInventory: { pluginCount: byPlugin.size, skillCount: skills.length, skills: skills.map((s) => s.name) },
    skillCount: skills.length,
    snapshotSha256: 'unused-in-injected-tests',
  };
  return {
    skills,
    manifest,
    data: {
      upstream: { tag: manifest.tag, commit: manifest.commit },
      license: 'test',
      budget: 320,
      entries: {},
    },
  };
}

/** A 300-character single-line fake authored text, inside the default budget. */
export function fakeText(seed = 'text') {
  return `${seed} ${'x'.repeat(300 - seed.length - 1)}`;
}

/** Write a file under a snapshot root, creating parents. */
export function writeSnapshotFile(root, relative, text) {
  const full = join(root, relative.split('/').join(sep));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text, 'utf8');
  return full;
}
