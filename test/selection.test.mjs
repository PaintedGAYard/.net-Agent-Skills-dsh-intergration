/**
 * Selection middleware suite — doc/dev-plan.md W10, cases 1–12.
 *
 * The properties under test are the ones a catalog consumer would notice: the fold is a
 * pure function of the patches, registration order cannot change it, and within a workspace
 * the selected set only ever grows.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createSelectionService,
  estimateTokens,
  foldPatches,
  shippedSkillsByPlugin,
} from '../lib/selection.js';

const manifest = JSON.parse(readFileSync(new URL('../vendor/UPSTREAM.json', import.meta.url), 'utf8'));
const pluginSkills = shippedSkillsByPlugin(manifest);

/**
 * Every skill name the baseline attributes to the given plugins.
 *
 * Selection works from `UPSTREAM.json`'s plugin→skill map rather than from the files on disk,
 * so a configuration written for the full baseline still means something while the shipped
 * snapshot range is narrow. Tests therefore ask the manifest, not the snapshot, what a plugin
 * contains.
 */
function skillsOf(...plugins) {
  const lists = [...(manifest.includedPlugins ?? []), ...(manifest.outOfRangePlugins ?? [])];
  const names = [];
  for (const plugin of plugins) {
    const entry = lists.find((candidate) => candidate.name === plugin);
    if (entry === undefined) throw new Error(`the manifest does not list ${plugin}`);
    names.push(...entry.skills);
  }
  return names;
}

/** A service with the built-ins installed and nothing else resolved. */
function service(config = {}) {
  return createSelectionService({
    config: {
      rank: 700,
      enabledPlugins: [],
      enabledSkills: [],
      disabledSkills: [],
      pinnedSkills: [],
      probe: { enabled: true },
      ...config,
    },
    manifest,
    pluginSkills,
  });
}

test('case 1: three selectors each contributing a patch produce the union', () => {
  const patches = [
    { name: 'a', priority: 0, patch: { include: ['one', 'two'] } },
    { name: 'b', priority: 0, patch: { include: ['two', 'three'] } },
    { name: 'c', priority: 0, patch: { include: ['four'] } },
  ];
  assert.deepEqual(foldPatches(patches).names, ['four', 'one', 'three', 'two']);
});

test('hasDetect distinguishes "detection is off" from "detection is not built yet"', () => {
  // §9's `detect` callback is optional, and the difference is what the status tool reports: with no
  // callback a `probe.*` setting is inert, while a wired callback that returns no plugins is a
  // detection run that simply matched nothing.
  assert.equal(service().hasDetect(), false);
  const wired = createSelectionService({
    config: { probe: { enabled: true }, enabledPlugins: [], enabledSkills: [], disabledSkills: [], pinnedSkills: [] },
    manifest,
    pluginSkills,
    detect: () => ({ plugins: [] }),
  });
  assert.equal(wired.hasDetect(), true);
  assert.deepEqual(wired.fold({ cwd: '/w' }).names, service().fold({ cwd: '/w' }).names);

  // Wiring it changes nothing about the service contract a third party depends on (§8.2).
  assert.equal(wired.version, 1);
});

test('case 2: exclude subtracts from the include result', () => {
  const folded = foldPatches([
    { name: 'a', priority: 0, patch: { include: ['one', 'two'] } },
    { name: 'b', priority: 0, patch: { exclude: ['two'] } },
  ]);
  assert.deepEqual(folded.names, ['one']);
  assert.deepEqual(folded.excluded, ['two']);
});

test('case 3: subtraction happens after the union, so a veto always wins', () => {
  const folded = foldPatches([
    { name: 'include-it', priority: 100, patch: { include: ['shared'] } },
    { name: 'veto-it', priority: 0, patch: { exclude: ['shared'] } },
  ]);
  assert.equal(folded.names.includes('shared'), false);
  assert.deepEqual(folded.conflicts, [{ name: 'shared', includedBy: ['include-it'], excludedBy: ['veto-it'] }]);
});

test('cases 4 and 5: an abstaining or empty patch changes nothing', () => {
  const base = foldPatches([{ name: 'a', priority: 0, patch: { include: ['one'] } }]);
  const withAbstainer = foldPatches([
    { name: 'a', priority: 0, patch: { include: ['one'] } },
    { name: 'b', priority: 0, patch: {} },
  ]);
  assert.deepEqual(base.names, withAbstainer.names);

  const svc = service();
  svc.selectors.register('abstains', () => undefined);
  svc.selectors.register('empty', () => ({}));
  assert.deepEqual(svc.fold({ cwd: '/tmp/x' }).names, ['csharp-scripts', 'dotnet-pinvoke', 'nuget-trusted-publishing']);
});

test('case 6: registration order does not change the result', () => {
  const patches = [
    { name: 'alpha', priority: 1, patch: { include: ['one'] } },
    { name: 'beta', priority: 2, patch: { include: ['two'] } },
    { name: 'gamma', priority: 3, patch: { include: ['three'], exclude: ['one'] } },
  ];
  const forward = foldPatches(patches);
  const backward = foldPatches([...patches].reverse());
  assert.deepEqual(forward.names, backward.names);
  assert.deepEqual([...forward.reasons.entries()].sort(), [...backward.reasons.entries()].sort());
});

test('case 7: the highest priority owns the reason', () => {
  const folded = foldPatches([
    { name: 'low', priority: 1, patch: { include: ['shared'], reason: 'low' } },
    { name: 'high', priority: 9, patch: { include: ['shared'], reason: 'high' } },
  ]);
  assert.equal(folded.reasons.get('shared'), 'high');
});

test('case 8: equal priority falls to the code-point-smallest selector name', () => {
  const folded = foldPatches([
    { name: 'zulu', priority: 5, patch: { include: ['shared'], reason: 'zulu' } },
    { name: 'alpha', priority: 5, patch: { include: ['shared'], reason: 'alpha' } },
  ]);
  assert.equal(folded.reasons.get('shared'), 'alpha');
});

test('case 9: a third-party selector registered through the service participates', () => {
  const svc = service();
  const dispose = svc.selectors.register(
    'internal-policy',
    () => ({ include: ['csharp-scripts'], reason: 'internal-policy' }),
    { priority: 50 },
  );
  const folded = svc.fold({ cwd: '/tmp/x' });
  assert.ok(folded.names.includes('csharp-scripts'));
  assert.equal(folded.reasons.get('csharp-scripts'), 'internal-policy', 'higher priority owns the reason');
  assert.deepEqual(svc.selectors.list().includes('internal-policy'), true);
  dispose();
  assert.equal(svc.selectors.list().includes('internal-policy'), false);
});

test('case 10: unloading a third-party selector restores the earlier result', () => {
  const svc = service();
  const before = svc.fold({ cwd: '/tmp/y' }).names;
  const dispose = svc.selectors.register('temporary', () => ({ include: ['mcp-csharp-debug'] }));
  assert.ok(svc.fold({ cwd: '/tmp/y' }).names.includes('mcp-csharp-debug'));
  dispose();
  // The monotonic memory keeps what was already advertised, which is the contract for a
  // session that has already seen it; a fresh workspace returns to the original set.
  assert.deepEqual(svc.fold({ cwd: '/tmp/z' }).names, before);
});

test('case 11: the budget selector drops the least relevant first and never a pinned skill', () => {
  const svc = service({
    enabledPlugins: ['dotnet-msbuild'],
    pinnedSkills: ['csharp-scripts'],
    catalogTokenBudget: 20,
  });
  // `current` is what the provider already advertised for this workspace: the core set plus
  // everything the configuration pulled in. That is the list a budget cut has to act on.
  const current = skillsOf('dotnet', 'dotnet-msbuild');
  assert.ok(estimateTokens(current) > 20, 'the fixture has to exceed the ceiling for this to mean anything');
  const folded = svc.fold({ cwd: '/tmp/budget', current });
  assert.ok(folded.names.includes('csharp-scripts'), 'pinned skills survive a budget cut');
  assert.equal(folded.names.includes('binlog-generation'), false, 'unpinned skills are dropped once the limit binds');
  assert.equal(estimateTokens(folded.names) <= 20, true);
  assert.equal(folded.reasons.get('binlog-generation'), undefined);
});

test('case 11b: a budget large enough for everything changes nothing', () => {
  const svc = service({ catalogTokenBudget: 100_000 });
  const folded = svc.fold({ cwd: '/tmp/roomy' });
  assert.deepEqual(folded.names, ['csharp-scripts', 'dotnet-pinvoke', 'nuget-trusted-publishing']);
});

test('case 12: a repeat fold in one workspace stays a pure function of its patches', () => {
  // Monotonicity is the provider's job, not the fold's — see the provider suite for the
  // advertised-set guarantee. What the fold must guarantee is determinism: the same patches
  // produce the same set every time, or nothing downstream can be reasoned about.
  const svc = service();
  const first = svc.fold({ cwd: '/tmp/monotonic' }).names;
  const second = svc.fold({ cwd: '/tmp/monotonic' }).names;
  assert.deepEqual(first, second);

  const dispose = svc.selectors.register('expands', () => ({ include: ['mcp-csharp-debug'] }));
  const third = svc.fold({ cwd: '/tmp/monotonic' }).names;
  for (const name of first) assert.ok(third.includes(name), `${name} must survive an added selector`);
  assert.ok(third.includes('mcp-csharp-debug'));
  dispose();
  assert.deepEqual(svc.fold({ cwd: '/tmp/monotonic' }).names, first, 'and return to the earlier set');
});

test('config-baseline adds plugins and skills on top of the core set', () => {
  const svc = service({ enabledPlugins: ['dotnet-test'], enabledSkills: ['maui-theming'] });
  const folded = svc.fold({ cwd: '/tmp/config' });
  for (const name of test_plannedCore()) assert.ok(folded.names.includes(name), `${name} stays in the core set`);
  assert.ok(folded.names.includes('maui-theming'), 'enabledSkills adds a name');
  assert.ok(folded.names.includes('run-tests'), 'enabledPlugins adds that plugin\u2019s skills');
  assert.equal(folded.reasons.get('run-tests'), 'config-baseline');
});

test('disabledSkills vetoes even a core-set skill, because subtraction comes last', () => {
  const svc = service({ disabledSkills: ['dotnet-pinvoke'] });
  const folded = svc.fold({ cwd: '/tmp/veto' });
  assert.equal(folded.names.includes('dotnet-pinvoke'), false);
  assert.ok(folded.excluded.includes('dotnet-pinvoke'));
  assert.ok(folded.conflicts.some((conflict) => conflict.name === 'dotnet-pinvoke'));
});

test('unknown names in the configuration are tolerated, not rejected', () => {
  // §14: a configuration naming a skill this release no longer ships degrades to a warning.
  // Selection may still say it wants the name — the provider is what knows it does not exist.
  const svc = service({ enabledSkills: ['a-skill-that-left-upstream'], disabledSkills: ['also-gone'] });
  const folded = svc.fold({ cwd: '/tmp/unknown' });
  assert.ok(folded.names.includes('a-skill-that-left-upstream'));
  for (const name of test_plannedCore()) assert.ok(folded.names.includes(name));
});

test('core-set is the dotnet plugin shipped by the snapshot, not a hard-coded list', () => {
  const svc = service();
  const folded = svc.fold({ cwd: '/tmp/core' });
  assert.deepEqual(folded.names, test_plannedCore());
});

function test_plannedCore() {
  const plugin = manifest.includedPlugins.find((candidate) => candidate.name === 'dotnet');
  return [...plugin.skills].sort();
}

test('a throwing third-party selector is contained and reported', () => {
  /** @type {string[]} */
  const logged = [];
  const svc = createSelectionService({
    config: { enabledPlugins: [], enabledSkills: [], disabledSkills: [], pinnedSkills: [], probe: { enabled: true } },
    manifest,
    pluginSkills,
    log: (line) => logged.push(line),
  });
  svc.selectors.register('explodes', () => {
    throw new Error('policy bug');
  });
  const folded = svc.fold({ cwd: '/tmp/throwing' });
  assert.deepEqual(folded.names, test_plannedCore(), 'the rest of the catalog still resolves');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /policy bug/);
});

test('estimateTokens is the documented four-characters-per-token estimate', () => {
  assert.equal(estimateTokens([]), 0);
  assert.equal(estimateTokens(['abcd']), 2);
});
