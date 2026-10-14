/**
 * Pointer extraction and classification — doc/dev-plan.md W4 cases 13–20.
 *
 * The point of these cases is that pointer handling needs no natural-language processing:
 * loose extraction plus a name lookup separates real pointers from English sentences, and
 * the lookup is the part that carries the precision.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  censusPointers,
  classifyPointers,
  extractPointerTokens,
  nameUniverse,
} from '../lib/pointers.js';

const manifest = JSON.parse(readFileSync(new URL('../vendor/UPSTREAM.json', import.meta.url), 'utf8'));
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/upstream-descriptions.json', import.meta.url), 'utf8'));
const names = nameUniverse(manifest);

/** The in-range skills of the pinned baseline, as the census sees them. */
const inRange = (() => {
  const known = new Set();
  for (const plugin of [
    ...(manifest.includedPlugins ?? []),
    ...(manifest.excludedPlugins ?? []),
    ...(manifest.outOfRangePlugins ?? []),
  ]) {
    for (const skill of plugin.skills ?? []) known.add(skill);
  }
  return fixtures.skills
    .filter((skill) => known.has(skill.key.split('/')[1]) && !skill.key.startsWith('dotnet-experimental/'))
    .map((skill) => ({ key: skill.key, description: skill.description }));
})();

test('case 15: a trailing qualifier does not hide the pointer', () => {
  const tokens = extractPointerTokens('Runs tests (use run-tests for all of these) and that is it.');
  assert.deepEqual(tokens, ['run-tests']);
  assert.deepEqual(extractPointerTokens('(use migrate-mstest-v1v2-to-v3 first)'), ['migrate-mstest-v1v2-to-v3']);
  assert.deepEqual(extractPointerTokens('(use build-perf-diagnostics after baselining)'), ['build-perf-diagnostics']);
  assert.deepEqual(extractPointerTokens('(use build-perf-baseline first)'), ['build-perf-baseline']);
});

test('case 16: a glob is not a name', () => {
  const tokens = extractPointerTokens('Migrate older MSTest suites (use migrate-mstest-* skills) in order.');
  assert.deepEqual(tokens, ['migrate-mstest']);
  assert.deepEqual(classifyPointers('(use migrate-mstest-* skills)', names).required, []);
  assert.deepEqual(classifyPointers('(use migrate-mstest-* skills)', names).dangling, []);
});

test('case 17: ordinary English clauses produce no obligations', () => {
  const clauses = [
    '(use Grid or StackLayout)',
    '(use Grid and StackLayout)',
    '(use Python with PyTorch/TensorFlow, then export to ONNX for .NET inference)',
    '(use standard xUnit and NSubstitute patterns)',
    '(use conditional compilation and partial classes)',
    '(use Microsoft.Maui.Controls.Maps)',
    '(use .NET MAUI animation APIs)',
  ];
  for (const clause of clauses) {
    const classified = classifyPointers(clause, names);
    assert.deepEqual(classified.required, [], `${clause} must not create a pointer obligation`);
    assert.deepEqual(classified.dangling, [], `${clause} must not report a dangling pointer`);
  }
});

test('case 18: a plugin name is not a skill name', () => {
  assert.equal(names.universe.has('dotnet-msbuild'), false, 'dotnet-msbuild is a plugin, not a skill');
  assert.deepEqual(classifyPointers('(use dotnet-msbuild plugin)', names).required, []);
  assert.deepEqual(extractPointerTokens('(use crap-score skill)'), ['crap-score']);
  assert.deepEqual(classifyPointers('(use crap-score skill)', names).required, ['crap-score']);
});

test('case 19: a pointer inside DO NOT USE FOR: counts exactly as much', () => {
  const description =
    'Binlog analysis. USE FOR: build failures. DO NOT USE FOR: analyzing an existing binlog ' +
    '(use binlog-failure-analysis instead).';
  const classified = classifyPointers(description, names);
  assert.deepEqual(classified.required, ['binlog-failure-analysis']);
  // Extraction does not segment: the same tokens appear with and without the label context.
  assert.deepEqual(extractPointerTokens('analyzing an existing binlog (use binlog-failure-analysis instead)'), [
    'binlog-failure-analysis',
  ]);
});

test('case 20: prepare and verify share one implementation, so their results cannot differ', () => {
  // Both paths call extractPointerTokens; this asserts the classification is a pure function
  // of the text, so calling it twice — as prepare then verify would — cannot drift.
  for (const skill of inRange) {
    const first = JSON.stringify(classifyPointers(skill.description, names));
    const second = JSON.stringify(classifyPointers(skill.description, names));
    assert.equal(first, second, `${skill.key} classification must be deterministic`);
  }
});

test('the baseline census matches doc/spec.md §2.8', () => {
  const census = censusPointers(inRange, names);
  assert.equal(inRange.length, 68);
  assert.equal(census.required.size, 32, '32 distinct in-range skills are pointed at');
  assert.equal(68 - census.required.size, 36, '36 in-range skills are never pointed at');

  const top = [...census.byTarget.entries()].sort((a, b) => b[1].length - a[1].length);
  assert.deepEqual(top[0], [
    'build-perf-diagnostics',
    [
      'dotnet-msbuild/binlog-failure-analysis',
      'dotnet-msbuild/build-parallelism',
      'dotnet-msbuild/build-perf-baseline',
      'dotnet-msbuild/eval-performance',
      'dotnet-msbuild/resolve-project-references',
    ],
  ]);
  assert.equal(top[1][1].length, 3, 'the next tier is pointed at three times');
  assert.equal(top[2][1].length, 3);
});

/**
 * `writing-mstest-tests` and `test-anti-patterns` are the two densest targets in the whole
 * baseline, but four of each one's five inbound pointers come from `dotnet-experimental`
 * descriptions, which this release neither ships nor authors. Inside the 68-skill popu-
 * lation each has exactly one inbound pointer, and that is the number pointer conservation
 * has to satisfy.
 */
test('pointer density is counted over the population this release authors', () => {
  const census = censusPointers(inRange, names);
  assert.equal(census.byTarget.get('writing-mstest-tests')?.length, 1);
  assert.equal(census.byTarget.get('test-anti-patterns')?.length, 1);
  assert.equal(census.byTarget.get('build-perf-diagnostics')?.length, 5);
  assert.equal(census.byTarget.get('incremental-build')?.length, 3);
  assert.equal(census.byTarget.get('maui-shell-navigation')?.length, 3);
  assert.equal(census.byTarget.get('mcp-csharp-debug')?.length, 3);
  assert.equal(census.byTarget.get('template-discovery')?.length, 3);
});

test('dangling pointers are reported, never silently dropped', () => {
  const census = censusPointers(inRange, names);
  // Measured on the pinned baseline: the only surviving dangling reference is the one the
  // uncovered `test-anti-patterns` description makes. Pointers to excluded `exp-*` skills
  // otherwise live inside the excluded descriptions themselves, which this release does not
  // author (§7.6 discusses four targets; the census is what the tooling must trust).
  assert.deepEqual([...census.dangling.keys()], ['exp-test-smell-detection']);
  assert.deepEqual(census.dangling.get('exp-test-smell-detection'), ['dotnet-test/test-anti-patterns']);
});

test('names that appear only as prose-ish fragments are not classified as pointers', () => {
  // Without the leading boundary anchor the scan reports `ython`, `rid`, `aps` and friends.
  const prose = '(use Python with PyTorch/TensorFlow, then export to ONNX for .NET inference)';
  for (const fragment of ['ython', 'orch', 'ensor', 'rid', 'aps', 'ayout', 'ith']) {
    assert.equal(extractPointerTokens(prose).includes(fragment), false, `${fragment} must not be extracted`);
  }
});

test('the name universe separates "real but excluded" from "not a name"', () => {
  assert.equal(names.universe.size, 76);
  assert.equal(names.included.size, 68);
  assert.equal(names.universe.has('exp-test-smell-detection'), true);
  assert.equal(names.included.has('exp-test-smell-detection'), false);
  assert.equal(names.universe.has('totally-made-up-skill'), false);
});
