/**
 * Description authoring suite — doc/dev-plan.md W4, cases 1–24.
 *
 * Cases 2–14 and 21–24 run against an injected population so that each one states exactly
 * the upstream shape it is about. Cases 1 and 15–20 additionally exercise the real gates
 * over the real repository, because a gate that only ever sees fixtures is not a gate.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  cap,
  checkEntryContent,
  checkEntryForm,
  loadDescriptions,
  needsAuthoring,
  readPopulation,
  resolveDescription,
  verifyDescriptions,
} from '../lib/descriptions.js';
import { nameUniverse } from '../lib/pointers.js';
import { descriptionsPath, packageRoot, readUpstreamManifest } from '../lib/snapshot.js';
import { fakeText, makeFakePopulation } from './helpers.mjs';

const manifestRead = readUpstreamManifest();
assert.equal(manifestRead.ok, true, 'the repository must carry vendor/UPSTREAM.json');
const realManifest = manifestRead.manifest;
const realData = JSON.parse(readFileSync(descriptionsPath, 'utf8'));

/**
 * The real population restricted to the baseline's in-range names.
 *
 * `verify` scopes coverage to the plugins the snapshot actually ships — three during P0 —
 * which is the right scoping for a gate that must pass on a narrowed range. Cases about the
 * *baseline's* shape (pointer density, the 53-entry coverage set) inject this wider
 * population explicitly instead of pretending the snapshot already carries it.
 */
const inRangeSkills = (() => {
  const names = nameUniverse(realManifest);
  return readPopulation().skills.filter((skill) => names.included.has(skill.name));
})();

/** Run the gate over an injected population, with one entry patched in. */
function gate(specs, entry, options = {}) {
  const fake = makeFakePopulation(specs);
  const first = fake.skills[0];
  return verifyDescriptions({
    manifest: fake.manifest,
    data: { ...fake.data, entries: entry === undefined ? {} : { [first.key]: entry } },
    skills: fake.skills,
    checkSnapshot: false,
    ...options,
  });
}

/** The default synthetic skill: long enough to fall under the coverage rule. */
const LONG = 'A'.repeat(600);
const longSpec = {
  name: 'alpha-skill',
  description: `Runs alpha things for .NET projects. USE FOR: alpha work. DO NOT USE FOR: beta work. ${LONG}`,
};
const longEntry = {
  text: 'Runs alpha things. USE FOR: alpha work. DO NOT USE FOR: beta work.',
  sourceChars: longSpec.description.length,
  sourceSha256: createHash('sha256').update(longSpec.description).digest('hex'),
  authoredRevision: 1,
};

test('case 1: verify passes on the current repository state', () => {
  const result = verifyDescriptions({ manifest: realManifest, data: realData });
  assert.deepEqual(result.problems, []);
  // Derived, not hard-coded: the range grows plugin by plugin (P1), and every added plugin that needs
  // authoring changes these counts. A baked-in number makes each batch look like a regression.
  assert.equal(result.counts.entries, Object.keys(realData.entries).length);
  assert.equal(result.counts.gaps, 0, 'the shipped range covers every in-range skill that needs authoring');
  assert.equal(result.counts.population, 76, 'the checkout supplies the whole pinned ref as context');
  // The census is scoped to the shipped range, so every target it demands must be a shipped name.
  const shipped = new Set((realManifest.includedPlugins ?? []).flatMap((plugin) => plugin.skills ?? []));
  for (const target of result.census.required.keys()) assert.ok(shipped.has(target), `${target} is outside the range`);
});

test('the coverage scope follows the snapshot range, not the baseline', () => {
  // The same population and data, but told that all eleven marketplace plugins ship.
  const wideManifest = {
    ...realManifest,
    includedPlugins: [
      ...realManifest.includedPlugins,
      ...(realManifest.outOfRangePlugins ?? []).map((plugin) => ({ ...plugin, version: '0.1.0' })),
    ],
  };
  const result = verifyDescriptions({ manifest: wideManifest, data: realData, skills: inRangeSkills });
  const coverageRule = inRangeSkills.filter((skill) => needsAuthoring(skill.description)).length;
  const authored = Object.keys(realData.entries).length;
  const expectedGaps = Math.max(coverageRule - authored, 0);
  assert.equal(result.counts.gaps, expectedGaps, 'the unwritten entries surface as coverage gaps');
  if (expectedGaps > 0) {
    assert.ok(result.problems.some((problem) => problem.includes(`⑧ ${expectedGaps} in-range skills`)));
  } else {
    // Every in-range skill is authored now, so there is no coverage problem to find. The case is about
    // *scoping*, which the census assertion below states directly and which does not depend on gaps.
    assert.equal(
      result.problems.some((problem) => problem.includes('⑧')),
      false,
      'a fully authored range must not report a coverage gap',
    );
  }
  assert.equal(result.census.required.size, 32, 'the baseline points at 32 distinct in-range skills');
});

test('case 2: one character over budget is caught with its invariant number', () => {
  const overByOne = 'x'.repeat(321);
  assert.equal(overByOne.length, 321);
  assert.deepEqual(checkEntryForm({ key: 'k', text: overByOne, budget: 320 }), [
    'k: ① length 321 exceeds the budget 320',
  ]);
  const result = gate([longSpec], { ...longEntry, text: overByOne });
  assert.ok(result.problems.some((problem) => /① length 321 exceeds the budget 320/.test(problem)));
});

test('case 3: a newline violates invariant ②', () => {
  const result = gate([longSpec], { ...longEntry, text: 'line one\nline two' });
  assert.ok(result.problems.some((problem) => /② contains a newline or tab/.test(problem)));
});

test('case 4: an angle bracket violates invariant ③', () => {
  const result = gate([longSpec], { ...longEntry, text: 'uses <available_skills> to route' });
  assert.ok(result.problems.some((problem) => /③ contains an angle bracket/.test(problem)));
});

test('case 5: dropping a USE FOR: label the upstream text has violates ④', () => {
  // The authored text must not mention `USE FOR:` at all. `DO NOT USE FOR:` is not a
  // substitute: it does not contain the positive label as a substring, which is exactly the
  // reading invariant ④ encodes.
  const result = gate([longSpec], { ...longEntry, text: 'Runs alpha work for .NET projects.' });
  assert.ok(result.problems.some((problem) => /④ dropped the "USE FOR:" label/.test(problem)));

  const stillThere = gate([longSpec], longEntry);
  assert.deepEqual(stillThere.problems.filter((problem) => /④/.test(problem)), []);
});

test('case 6: inventing a USE FOR: label violates ④ in the other direction', () => {
  const spec = { name: 'alpha-skill', description: `Runs alpha things. ${'A'.repeat(600)}` };
  const result = gate([spec], { ...longEntry, text: 'Runs alpha things. USE FOR: alpha work.' });
  assert.ok(result.problems.some((problem) => /④ invented a "USE FOR:" label/.test(problem)));
});

test('case 7: inventing a DO NOT USE FOR: label violates ⑤', () => {
  const spec = { name: 'alpha-skill', description: `Runs alpha things. ${'A'.repeat(600)}` };
  const result = gate([spec], { ...longEntry, text: 'Runs alpha things. DO NOT USE FOR: beta.' });
  assert.ok(result.problems.some((problem) => /⑤ invented a "DO NOT USE FOR:" label/.test(problem)));
});

test('case 8: leaving INVOKES: in the catalog text violates ⑥', () => {
  const spec = { name: 'alpha-skill', description: `Runs things. INVOKES: shell, edit. ${'A'.repeat(600)}` };
  const result = gate([spec], { ...longEntry, text: 'Runs things. INVOKES: shell, edit.' });
  assert.ok(result.problems.some((problem) => /⑥ still contains the INVOKES:/.test(problem)));
});

test('case 9: a stale sourceSha256 is reported as drift', () => {
  const result = gate([longSpec], { ...longEntry, sourceSha256: 'deadbeef' });
  assert.ok(result.problems.some((problem) => /drift — sourceSha256 deadbeef/.test(problem)));
});

test('case 10: a missing coverage entry is a coverage gap', () => {
  const result = gate([longSpec], undefined);
  assert.ok(result.problems.some((problem) => /⑧ 1 in-range skills .* have no entry/.test(problem)));
  assert.match(result.problems[0], /dotnet\/alpha-skill \(6\d\d chars\)/);

  // --allow-gaps downgrades exactly this class of problem and nothing else.
  const relaxed = gate([longSpec], undefined, { allowGaps: true });
  assert.deepEqual(relaxed.problems, []);
  assert.equal(relaxed.warnings.length, 1);

  // A short upstream description is not in the coverage set, so it needs no entry.
  const short = { name: 'alpha-skill', description: 'Short and already within the downstream limit.' };
  assert.deepEqual(gate([short], undefined).problems, []);
});

test('case 11: an entry for a skill that does not exist is an orphan', () => {
  const fake = makeFakePopulation([longSpec]);
  const result = verifyDescriptions({
    manifest: fake.manifest,
    data: { ...fake.data, entries: { 'dotnet/ghost-skill': longEntry } },
    skills: fake.skills,
    checkSnapshot: false,
  });
  assert.ok(result.problems.some((problem) => /⑨ orphan entry dotnet\/ghost-skill/.test(problem)));
});

test('case 12: a changed upstream tag violates ⑩', () => {
  const fake = makeFakePopulation([longSpec]);
  const result = verifyDescriptions({
    manifest: fake.manifest,
    data: { ...fake.data, upstream: { tag: 'v0.9.0', commit: fake.manifest.commit } },
    skills: fake.skills,
    checkSnapshot: false,
  });
  assert.ok(result.problems.some((problem) => /⑩ upstream mismatch/.test(problem)));
});

test('case 13: dropping a required pointer violates ⑦', () => {
  const spec = {
    name: 'alpha-skill',
    description: `Runs alpha things (use writing-mstest-tests for all of these). ${'A'.repeat(460)}`,
  };
  const names = nameUniverse(realManifest);
  const upstreamNames = new Set(realManifest.upstreamInventory.skills);
  assert.ok(upstreamNames.has('writing-mstest-tests'));

  const dropped = checkEntryContent({
    key: spec.key ?? 'dotnet/alpha-skill',
    text: 'Runs alpha things.',
    upstream: spec.description,
    names,
  });
  assert.ok(dropped.violations.some((violation) => /⑦ dropped the pointer to writing-mstest-tests/.test(violation)));

  const kept = checkEntryContent({
    key: 'dotnet/alpha-skill',
    text: 'Runs alpha things (use writing-mstest-tests for all of these).',
    upstream: spec.description,
    names,
  });
  assert.deepEqual(kept.violations, []);
});

test('case 14: dropping a pointer to an excluded skill is allowed but reported', () => {
  const names = nameUniverse(realManifest);
  const upstream = 'Audits test quality (use exp-test-smell-detection instead) across a suite.';
  const result = checkEntryContent({
    key: 'dotnet-test/test-anti-patterns',
    text: 'Audits test quality across a suite.',
    upstream,
    names,
  });
  assert.deepEqual(result.violations, [], 'a dangling pointer may be dropped');
  assert.deepEqual(result.droppedPointers, []);
});

test('case 15: the gate reports the dangling pointers it measured on the real baseline', () => {
  // A dangling pointer is a name that cannot be loaded in this range. The shipped range is a moving
  // target (P1 grows it plugin by plugin), so the assertion is the rule: everything reported dangling
  // must be unloadable, and a dangling pointer is reported rather than counted as a violation.
  const unloadable = new Set([
    ...(realManifest.excludedPlugins ?? []).flatMap((plugin) => plugin.skills ?? []),
    ...(realManifest.outOfRangePlugins ?? []).flatMap((plugin) => plugin.skills ?? []),
  ]);
  const shipped = verifyDescriptions({ manifest: realManifest, data: realData });
  for (const target of shipped.census.dangling.keys()) {
    assert.ok(unloadable.has(target), `${target} is loadable, so nothing may drop it`);
  }
  assert.equal(
    shipped.problems.some((problem) => problem.includes('⑦')),
    false,
    'a pointer to an unloadable name is reported, not a violation',
  );

  const wideManifest = {
    ...realManifest,
    includedPlugins: [
      ...realManifest.includedPlugins,
      ...(realManifest.outOfRangePlugins ?? []).map((plugin) => ({ ...plugin, version: '0.1.0' })),
    ],
  };
  const baseline = verifyDescriptions({
    manifest: wideManifest,
    data: realData,
    skills: inRangeSkills,
    allowGaps: true,
  });
  assert.deepEqual([...baseline.census.dangling.keys()], ['exp-test-smell-detection']);
  assert.deepEqual(baseline.census.dangling.get('exp-test-smell-detection'), ['dotnet-test/test-anti-patterns']);
});

test('case 16: the baseline coverage set is exactly the 53 entries the plan budgets for', () => {
  assert.equal(inRangeSkills.length, 68);
  assert.equal(inRangeSkills.filter((skill) => needsAuthoring(skill.description)).length, 53);
});

test('case 21: cap shortens to fit, ellipsis included', () => {
  assert.equal(cap('abcdefgh', 5), 'ab...');
});

test('case 22: cap leaves text that already fits alone', () => {
  assert.equal(cap('abc', 3), 'abc');
  assert.equal(cap('abc', 10), 'abc');
});

test('case 23: cap never returns an empty string', () => {
  assert.equal(cap('abc', 1), 'a');
  assert.equal(cap('abc', 0), 'a');
  assert.equal(cap('abc', -5), 'a');
  assert.equal(cap('', 5), '');
  assert.notEqual(cap('any text at all', 2), '');
});

test('case 24: an over-budget entry degrades to upstream text at load time and never throws', () => {
  const spec = { name: 'alpha-skill', description: `Upstream text. ${'A'.repeat(400)}` };
  const fake = makeFakePopulation([spec]);
  const dataPath = `${packageRoot}/test/fixtures/does-not-exist.json`;
  const missing = loadDescriptions({ path: dataPath, manifest: fake.manifest });
  assert.deepEqual([...missing.entries.keys()], []);
  assert.equal(missing.diagnostics.length, 1);
  assert.match(missing.diagnostics[0], /cannot read/);

  const synthetic = loadDescriptions({
    path: descriptionsPath,
    manifest: realManifest,
    budget: 50,
  });
  // Both shipped entries exceed a 50-character budget, so both are rejected — with a reason,
  // and with the rest of the catalog untouched.
  assert.equal(synthetic.entries.size, 0);
  assert.ok(synthetic.diagnostics.some((line) => /① length \d+ exceeds the budget 50/.test(line)));
  assert.ok(synthetic.diagnostics.some((line) => /falling back to the upstream description/.test(line)));

  const resolved = resolveDescription({
    key: 'dotnet/dotnet-pinvoke',
    upstreamDescription: 'Upstream text.',
    descriptions: synthetic,
    mode: 'authored',
    maxLength: 500,
  });
  assert.deepEqual(resolved, { text: 'Upstream text.', source: 'verbatim' });
});

test('resolveDescription reports which of the three origins produced the text', () => {
  const entry = { text: fakeText('authored') };
  const definitions = { entries: new Map([['dotnet/alpha-skill', entry]]) };
  assert.deepEqual(
    resolveDescription({
      key: 'dotnet/alpha-skill',
      upstreamDescription: 'upstream',
      descriptions: definitions,
      mode: 'authored',
      maxLength: 500,
    }),
    { text: entry.text, source: 'authored' },
  );
  assert.deepEqual(
    resolveDescription({
      key: 'dotnet/alpha-skill',
      upstreamDescription: 'upstream',
      descriptions: definitions,
      mode: 'verbatim',
      maxLength: 500,
    }),
    { text: 'upstream', source: 'verbatim' },
  );
  assert.deepEqual(
    resolveDescription({
      key: 'dotnet/alpha-skill',
      upstreamDescription: 'upstream',
      descriptions: definitions,
      mode: 'authored',
      maxLength: 20,
    }),
    { text: `${entry.text.slice(0, 17)}...`, source: 'capped' },
  );
});

test('the shipped authored texts satisfy every formal invariant on their own', () => {
  const names = nameUniverse(realManifest);
  const population = readPopulation();
  const byKey = new Map(population.skills.map((skill) => [skill.key, skill]));
  for (const [key, entry] of Object.entries(realData.entries)) {
    assert.deepEqual(checkEntryForm({ key, text: entry.text, budget: realData.budget }), [], key);
    const skill = byKey.get(key);
    assert.ok(skill !== undefined, `${key} must exist in the population`);
    assert.equal(entry.sourceChars, skill.description.length, `${key} sourceChars`);
    assert.equal(
      entry.sourceSha256,
      createHash('sha256').update(skill.description).digest('hex'),
      `${key} sourceSha256`,
    );
    assert.deepEqual(checkEntryContent({ key, text: entry.text, upstream: skill.description, names }).violations, []);
    assert.ok(!entry.text.includes('INVOKES:'), `${key} must not keep the INVOKES: section`);
  }
});

test('metadata preservation: the INVOKES section survives as data after the text drops it', () => {
  const skill = readPopulation().skills.find((candidate) => candidate.name === 'nuget-trusted-publishing');
  assert.ok(skill.description.includes('INVOKES:'));
  assert.ok(!realData.entries['dotnet/nuget-trusted-publishing'].text.includes('INVOKES:'));
});
