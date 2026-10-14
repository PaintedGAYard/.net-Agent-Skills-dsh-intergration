/**
 * Provider suite — doc/dev-plan.md W5, cases 1–10.
 *
 * The provider sits on the boundary the host validates most strictly: a bad candidate does not
 * merely get skipped, it takes the whole layer's catalog read down with it. These cases drive
 * that boundary with deliberately broken inputs.
 */

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadDescriptions } from '../lib/descriptions.js';
import { createProvider, createJournal, validateCandidate } from '../lib/provider.js';
import { createSnapshotSource } from '../lib/source-snapshot.js';
import { descriptionsPath, readUpstreamManifest, snapshotRoot } from '../lib/snapshot.js';
import { cloneSnapshot, makeTempSnapshot, writeSnapshotFile } from './helpers.mjs';

const manifest = readUpstreamManifest().manifest;
/** What this snapshot ships, read from the manifest so a range change is not a test change. */
const SHIPPED = (manifest.includedPlugins ?? []).flatMap((plugin) => plugin.skills ?? []);

const descriptions = loadDescriptions({ path: descriptionsPath, manifest });

/** A selection service that picks exactly the given names. */
function stubSelection(names, extra = {}) {
  return {
    version: 1,
    fold: () => ({ names: [...names], reasons: new Map(names.map((name) => [name, 'test'])) }),
    ownerOf: new Map(),
    selectors: { register: () => () => {}, list: () => [], unregister: () => {} },
    ...extra,
  };
}

/** Build a provider over a snapshot root, selecting every skill that root contains. */
function providerFor(root, options = {}) {
  const source = createSnapshotSource({ root });
  const names = [...source.pluginSkills().values()].flat();
  const journal = createJournal();
  const provider = createProvider({
    source,
    selection: options.selection ?? stubSelection(names),
    descriptions: options.descriptions ?? descriptions,
    config: options.config ?? { rank: 700, descriptionMode: 'authored', catalogDescriptionMaxLength: 500 },
    journal,
  });
  return { provider, source, journal };
}

test('case 1: the normal path returns complete candidates with every required field', async () => {
  const { provider, journal, source } = providerFor(snapshotRoot);
  const observation = await provider.list({ cwd: process.cwd() });

  assert.equal(observation.complete, true);
  assert.deepEqual(observation.candidates.map((candidate) => candidate.name), [...SHIPPED].sort());
  assert.equal(provider.name, 'dotnet-agent-skills');
  assert.equal(journal.rank, 700);

  for (const candidate of observation.candidates) {
    assert.equal(candidate.provider, 'dotnet-agent-skills');
    assert.equal(candidate.source, 'bundled');
    assert.equal(candidate.rank, 700);
    assert.equal(candidate.whenToUse, undefined, 'upstream never uses whenToUse, so v1 never sets it');
    // The path is per-plugin: the shipped range spans several plugins, so the assertion derives the
    // directory from the candidate's own metadata instead of assuming the `dotnet` one.
    const plugin = candidate.metadata.plugin;
    // `userInvocable` comes from the skill's own frontmatter, and the baseline does contain
    // `user-invocable: false` skills, so the expectation is read from the source rather than assumed.
    const record = source.resolve(plugin).skills.find((skill) => skill.name === candidate.name);
    assert.deepEqual(candidate.invocation, {
      modelInvocable: true,
      userInvocable: record.userInvocable,
    });
    assert.equal(candidate.path, join(snapshotRoot, plugin, 'skills', candidate.name, 'SKILL.md'));
    assert.deepEqual(candidate.resourceBase, {
      kind: 'directory',
      path: join(snapshotRoot, plugin, 'skills', candidate.name),
    });
    assert.equal(candidate.locator.skill, candidate.name);
    assert.equal(candidate.description.length > 0, true);
    assert.ok(['authored', 'verbatim', 'capped'].includes(candidate.metadata.descriptionSource));
    assert.equal(candidate.metadata.plugin, plugin, 'the candidate carries the plugin it came from');
    assert.equal(typeof candidate.metadata.upstreamDescriptionChars, 'number');
    assert.equal(validateCandidate(candidate), undefined);
  }
});

test('cases 2, 3 and 4: self-validation rejects every shape the host would throw on', () => {
  const valid = {
    name: 'alpha-skill',
    description: 'text',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: 'dotnet-agent-skills',
    rank: 700,
    locator: {},
  };
  assert.equal(validateCandidate(valid), undefined);

  assert.match(validateCandidate({ ...valid, provider: 'someone-else' }), /expected "dotnet-agent-skills"/);
  assert.match(validateCandidate({ ...valid, rank: Number.NaN }), /rank is not a finite number/);
  assert.match(validateCandidate({ ...valid, rank: '700' }), /rank is not a finite number/);
  assert.match(validateCandidate({ ...valid, invocation: { modelInvocable: true } }), /userInvocable/);
  assert.match(validateCandidate({ ...valid, invocation: { userInvocable: true } }), /modelInvocable/);
  assert.match(validateCandidate({ ...valid, name: 'Not-A-Skill' }), /not a valid skill name/);
  assert.match(validateCandidate({ ...valid, description: '' }), /description is empty/);
  assert.match(validateCandidate({ ...valid, path: 42 }), /path is not a string/);
  assert.match(validateCandidate({ ...valid, locator: null }), /locator is not an object/);
  assert.match(validateCandidate({ ...valid, resourceBase: { kind: 'directory' } }), /resourceBase.path/);
});

test('case 2b: a candidate the host would reject never leaves the provider, and completes false', async () => {
  // A source whose candidates are sabotaged in transit: the provider must catch it before the
  // host's own validation does, and must still return the candidates it could build.
  const source = createSnapshotSource({ root: snapshotRoot });
  const corrupt = (resolved) => {
    if (resolved === undefined) return resolved;
    return {
      ...resolved,
      // Corrupt a skill the selection does pick, in a way only the provider can see: the name
      // stays valid, so the source's own checks pass and candidate self-validation has to catch it.
      skills: resolved.skills.map((skill) => (skill.name === 'dotnet-pinvoke' ? { ...skill, bodyPath: 42 } : skill)),
    };
  };
  const sabotaged = {
    ...source,
    resolve: (plugin) => corrupt(source.resolve(plugin)),
    inspect: (plugin) => corrupt(source.inspect(plugin)),
  };
  const journal = createJournal();
  const provider = createProvider({
    source: sabotaged,
    selection: stubSelection(SHIPPED),
    descriptions,
    config: {},
    journal,
  });
  const observation = await provider.list({});
  assert.equal(observation.complete, false, 'a skipped candidate makes the observation incomplete');
  // Everything the selection picked survives except the one sabotaged skill, whatever the range is.
  assert.equal(observation.candidates.length, SHIPPED.length - 1);
  assert.equal(
    observation.candidates.some((candidate) => candidate.name === 'dotnet-pinvoke'),
    false,
    'the invalid candidate never reaches the host',
  );
  assert.ok(journal.notes.some((note) => /dotnet-pinvoke failed self-validation: path is not a string/.test(note)));
});

test('case 5: a missing snapshot root makes list() incomplete, never throwing', async () => {
  const { root, dispose } = cloneSnapshot();
  const { provider, journal } = providerFor(root);
  rmSync(root, { recursive: true, force: true });
  try {
    const observation = await provider.list({});
    assert.equal(observation.complete, false);
    assert.deepEqual(observation.candidates, []);
    assert.ok(journal.notes.some((note) => /absent from the snapshot|snapshot read failed|missing from the snapshot/.test(note)));
  } finally {
    dispose();
  }
});

test('case 6: an invalid SKILL.md is skipped and recorded, the rest still resolve', async () => {
  const { root, dispose } = cloneSnapshot();
  try {
    writeSnapshotFile(
      root,
      'dotnet/skills/broken-skill/SKILL.md',
      '---\nname: broken-skill\ndescription: |\n  literal blocks are not supported\n---\n\nbody\n',
    );
    const { provider, journal } = providerFor(root);
    const observation = await provider.list({});
    assert.equal(observation.complete, false);
    assert.deepEqual(observation.candidates.map((candidate) => candidate.name), [...SHIPPED].sort());
    assert.ok(journal.notes.some((note) => /broken-skill.*literal block scalars/.test(note)));
  } finally {
    dispose();
  }
});

test('case 6b: a skill whose frontmatter name disagrees with its directory is skipped', async () => {
  const { root, dispose } = cloneSnapshot();
  try {
    writeSnapshotFile(root, 'dotnet/skills/renamed-skill/SKILL.md', '---\nname: something-else\ndescription: text\n---\n');
    const { provider, journal } = providerFor(root);
    const observation = await provider.list({});
    assert.equal(observation.complete, false);
    assert.ok(journal.notes.some((note) => /does not match the directory/.test(note)));
  } finally {
    dispose();
  }
});

test('case 7: get() re-reads the file, so an edit between calls is visible', async () => {
  const { root, dispose } = cloneSnapshot();
  try {
    const { provider } = providerFor(root);
    const observation = await provider.list({});
    const candidate = observation.candidates.find((entry) => entry.name === 'csharp-scripts');
    const first = await provider.get(candidate, {});
    assert.match(first.content, /csharp-scripts|single-file/s);

    const path = candidate.locator.bodyPath;
    const edited = `${readFileSync(path, 'utf8')}\n<!-- edited by the test -->\n`;
    writeFileSync(path, edited, 'utf8');

    const second = await provider.get(candidate, {});
    assert.notEqual(second.content, first.content, 'a definition is never cached');
    assert.equal(second.content, edited);
    assert.equal(second.name, candidate.name, 'the definition name must equal the candidate name');
  } finally {
    dispose();
  }
});

test('case 8: get() returns undefined once the body is gone', async () => {
  const { root, dispose } = cloneSnapshot();
  try {
    const { provider } = providerFor(root);
    const observation = await provider.list({});
    const candidate = observation.candidates[0];
    rmSync(candidate.locator.bodyPath, { force: true });
    assert.equal(await provider.get(candidate, {}), undefined);
  } finally {
    dispose();
  }
});

test('case 9: user-invocable false stays in the catalog with only userInvocable cleared', async () => {
  const { root, dispose } = cloneSnapshot();
  try {
    writeSnapshotFile(
      root,
      'dotnet/skills/hidden-from-slash/SKILL.md',
      '---\nname: hidden-from-slash\ndescription: Reference data for a synthetic case.\nuser-invocable: false\n---\n\nbody\n',
    );
    const { provider } = providerFor(root);
    const observation = await provider.list({});
    const candidate = observation.candidates.find((entry) => entry.name === 'hidden-from-slash');
    assert.ok(candidate !== undefined, 'the skill is still routable by the model');
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: false });
  } finally {
    dispose();
  }
});

test('case 10: descriptionMode verbatim uses the upstream text for everything', async () => {
  const { provider } = providerFor(snapshotRoot, {
    config: { rank: 700, descriptionMode: 'verbatim', catalogDescriptionMaxLength: 500 },
  });
  const observation = await provider.list({});
  const pinvoke = observation.candidates.find((candidate) => candidate.name === 'dotnet-pinvoke');
  const nuget = observation.candidates.find((candidate) => candidate.name === 'nuget-trusted-publishing');
  for (const candidate of observation.candidates) {
    assert.equal(candidate.metadata.descriptionSource, 'verbatim');
  }
  // Verbatim means verbatim: the authored text is not consulted, and the upstream INVOKES:
  // section the authoring pass removes comes straight back.
  assert.notEqual(pinvoke.description, descriptions.entries.get('dotnet/dotnet-pinvoke').text);
  assert.match(pinvoke.description, /DO NOT USE FOR: COM interop/);
  assert.match(nuget.description, /INVOKES:/);
  assert.equal(nuget.description, nuget.metadata.upstreamDescription);
});

test('verbatim mode still respects the downstream ceiling', async () => {
  const { provider } = providerFor(snapshotRoot, {
    config: { rank: 700, descriptionMode: 'verbatim', catalogDescriptionMaxLength: 500 },
  });
  const observation = await provider.list({});
  for (const candidate of observation.candidates) {
    assert.ok(candidate.description.length <= 500, `${candidate.name} must fit the downstream limit`);
  }
  // dotnet-pinvoke is 538 characters upstream, so the default ceiling truncates it — mid-word,
  // with the ellipsis inside the budget, exactly as §7.9 describes.
  const pinvoke = observation.candidates.find((candidate) => candidate.name === 'dotnet-pinvoke');
  assert.equal(pinvoke.description.length, 500);
  assert.ok(pinvoke.description.endsWith('...'));
});

test('authored mode substitutes the reviewed text and reports its origin', async () => {
  const { provider } = providerFor(snapshotRoot);
  const observation = await provider.list({});
  const pinvoke = observation.candidates.find((candidate) => candidate.name === 'dotnet-pinvoke');
  assert.equal(pinvoke.metadata.descriptionSource, 'authored');
  assert.equal(pinvoke.description, descriptions.entries.get('dotnet/dotnet-pinvoke').text);
  assert.equal(pinvoke.metadata.upstreamDescriptionChars, 538);
  assert.equal(pinvoke.metadata.upstreamInvokes, undefined);

  const nuget = observation.candidates.find((candidate) => candidate.name === 'nuget-trusted-publishing');
  assert.match(nuget.metadata.upstreamInvokes, /^INVOKES:/);
  assert.equal(nuget.description.includes('INVOKES:'), false);
});

test('lowering the ceiling below the authored budget caps deterministically', async () => {
  const { provider } = providerFor(snapshotRoot, {
    config: { rank: 700, descriptionMode: 'authored', catalogDescriptionMaxLength: 60 },
  });
  const observation = await provider.list({});
  for (const candidate of observation.candidates) {
    assert.ok(candidate.description.length <= 60, `${candidate.name} must respect the ceiling`);
  }
  // The two authored entries are 315 and 303 characters, so a 60-character ceiling caps them.
  const pinvoke = observation.candidates.find((candidate) => candidate.name === 'dotnet-pinvoke');
  assert.equal(pinvoke.description.length, 60);
  assert.equal(pinvoke.description.endsWith('...'), true);
  assert.equal(pinvoke.metadata.descriptionSource, 'capped');
  // And the upstream text is still recorded in full, so nothing is lost.
  assert.equal(pinvoke.metadata.upstreamDescriptionChars, 538);
});

test('a ceiling above the authored budget changes nothing', async () => {
  const { provider } = providerFor(snapshotRoot, {
    config: { rank: 700, descriptionMode: 'authored', catalogDescriptionMaxLength: 500 },
  });
  const observation = await provider.list({});
  const pinvoke = observation.candidates.find((candidate) => candidate.name === 'dotnet-pinvoke');
  assert.equal(pinvoke.metadata.descriptionSource, 'authored');
  assert.equal(pinvoke.description, descriptions.entries.get('dotnet/dotnet-pinvoke').text);
});

test('the advertised set only grows within one workspace', async () => {
  const journal = createJournal();
  let selected = ['csharp-scripts'];
  const selection = {
    fold: () => ({ names: [...selected], reasons: new Map(selected.map((name) => [name, 'test'])) }),
  };
  const provider = createProvider({
    source: createSnapshotSource({ root: snapshotRoot }),
    selection,
    descriptions,
    config: { rank: 700, descriptionMode: 'authored', catalogDescriptionMaxLength: 500 },
    journal,
  });

  const first = await provider.list({ cwd: '/w/one' });
  assert.deepEqual(first.candidates.map((candidate) => candidate.name), ['csharp-scripts']);

  // The same workspace now selects more: it grows, which is allowed.
  selected = [...SHIPPED];
  const second = await provider.list({ cwd: '/w/one' });
  assert.deepEqual(second.candidates.map((candidate) => candidate.name), [...SHIPPED].sort());

  // The selection shrinks again — and the workspace that already saw those skills keeps them,
  // because a shrinking catalog makes the host publish a replacement catalog and breaks the
  // prompt cache (§6.2 hard rule two).
  selected = ['csharp-scripts'];
  const third = await provider.list({ cwd: '/w/one' });
  assert.deepEqual(third.candidates.map((candidate) => candidate.name), [...SHIPPED].sort());

  // A workspace with no history is unaffected by another workspace's memory.
  const other = await provider.list({ cwd: '/w/two' });
  assert.deepEqual(other.candidates.map((candidate) => candidate.name), ['csharp-scripts']);
  assert.equal(other.complete, true);
  assert.deepEqual(journal.monotonic, { workspace: '/w/two', advertised: 1, selected: 1 });
});

test('a selection naming an unknown skill is a note, not an incomplete observation', async () => {
  const journal = createJournal();
  const provider = createProvider({
    source: createSnapshotSource({ root: snapshotRoot }),
    selection: stubSelection(['csharp-scripts', 'no-such-skill']),
    descriptions,
    config: {},
    journal,
  });
  const observation = await provider.list({});
  assert.equal(observation.complete, true);
  assert.deepEqual(observation.candidates.map((candidate) => candidate.name), ['csharp-scripts']);
  assert.ok(journal.notes.some((note) => /no-such-skill/.test(note)));
});

test('a folding selection that throws cannot escape list()', async () => {
  const journal = createJournal();
  const provider = createProvider({
    source: createSnapshotSource({ root: snapshotRoot }),
    selection: {
      fold: () => {
        throw new Error('selector meltdown');
      },
    },
    descriptions,
    config: {},
    journal,
  });
  const observation = await provider.list({});
  assert.deepEqual(observation.candidates, []);
  assert.equal(observation.complete, true, 'an empty selection is an answer, not a failure');
  assert.ok(journal.notes.some((note) => /selection fold failed: selector meltdown/.test(note)));
});

test('a synthetic snapshot proves resourceBase and path stay platform-readable', async () => {
  const { root, dispose } = makeTempSnapshot({
    'demo/plugin.json': JSON.stringify({ name: 'demo', version: '0.1.0', skills: ['./skills/'] }),
    'demo/skills/with-references/SKILL.md': '---\nname: with-references\ndescription: A skill with a references folder.\n---\n\nSee `references/one.md`.\n',
    'demo/skills/with-references/references/one.md': '# One\n',
    'demo/skills/with-scripts/SKILL.md': '---\nname: with-scripts\ndescription: A skill with a PowerShell script.\n---\n\nRun `scripts/Do-Thing.ps1`.\n',
    'demo/skills/with-scripts/scripts/Do-Thing.ps1': 'Write-Output "hi"\n',
  });
  try {
    const { provider } = providerFor(root);
    const observation = await provider.list({ cwd: root === '' ? undefined : '/somewhere' });
    assert.equal(observation.complete, true);
    const withReferences = observation.candidates.find((candidate) => candidate.name === 'with-references');
    const withScripts = observation.candidates.find((candidate) => candidate.name === 'with-scripts');
    assert.deepEqual(withReferences.resourceBase, {
      kind: 'directory',
      path: join(root, 'demo', 'skills', 'with-references'),
    });
    // The body is reachable from resourceBase, which is what makes relative references work.
    assert.equal(
      readFileSync(join(withReferences.resourceBase.path, 'references', 'one.md'), 'utf8'),
      '# One\n',
    );
    assert.equal(
      readFileSync(join(withScripts.resourceBase.path, 'scripts', 'Do-Thing.ps1'), 'utf8'),
      'Write-Output "hi"\n',
    );
    assert.equal(withScripts.path, join(root, 'demo', 'skills', 'with-scripts', 'SKILL.md'));
  } finally {
    dispose();
  }
});

test('catalogue metadata records the resources each skill ships', async () => {
  const source = createSnapshotSource({ root: snapshotRoot });
  const pinvoke = source.resolve('dotnet').skills.find((skill) => skill.name === 'dotnet-pinvoke');
  assert.deepEqual(pinvoke.resources, { references: 2 });
  assert.deepEqual(source.diagnostics(), []);
});
