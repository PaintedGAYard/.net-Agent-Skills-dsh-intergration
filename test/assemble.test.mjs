/**
 * Assembly suite — `tools/assemble-descriptions.mjs`.
 *
 * P1 wrote 53 authored entries through this tool, and an upstream tag that moves rewrites part of them
 * again (§7.7), so its rules are load-bearing rather than scaffolding. Each case here is a rule the
 * authoring gate would otherwise have to catch *after* a text was published.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  assembleDrafts,
  BUDGET,
  clauses,
  fitEntry,
  mergeEntries,
  parseArgv,
  renderAsProse,
  renderWithLabels,
  validateDraft,
} from '../tools/assemble-descriptions.mjs';

/** A pack entry shaped like `tools/descriptions.mjs prepare` emits. */
const packEntry = (key, overrides = {}) => ({
  key,
  chars: 700,
  sourceSha256: 'a'.repeat(64),
  pointersToKeep: [],
  pointersDroppable: [],
  requiresUseFor: false,
  requiresDoNotUseFor: false,
  ...overrides,
});

const packOf = (...entries) => ({ entries });

test('the labels shape renders the two labels upstream has, and only those', () => {
  const spec = {
    kind: 'labels',
    prefix: 'Do a thing for .NET projects.',
    use: ['first trigger', 'second trigger'],
    pointers: [],
    extras: ['unrelated work'],
  };
  assert.equal(
    renderWithLabels(spec, ['first trigger', 'second trigger'], ['unrelated work']),
    'Do a thing for .NET projects. USE FOR: first trigger, second trigger. DO NOT USE FOR: unrelated work.',
  );
  // With no droppable negative and no pointer the head stands alone: a `DO NOT USE FOR:` with nothing
  // after it would claim a boundary the upstream text never drew.
  assert.equal(
    renderWithLabels(spec, ['first trigger'], []),
    'Do a thing for .NET projects. USE FOR: first trigger.',
  );
});

test('the prose shape never grows a label, and honours the upstream lead-ins', () => {
  const spec = {
    kind: 'prose',
    prefix: 'Review test code for anti-patterns.',
    body: ['assertion gaps', 'flakiness'],
    negatives: ['direct API rewrites (use writing-mstest-tests)'],
    bodyLead: 'Use when:',
    negativeLead: 'Do not use for:',
  };
  const text = renderAsProse(spec, spec.body, spec.negatives);
  assert.equal(
    text,
    'Review test code for anti-patterns. Use when: assertion gaps, flakiness. Do not use for: direct API rewrites (use writing-mstest-tests).',
  );
  // Invariant ④ is bidirectional: `DO NOT USE FOR:` would contain `USE FOR:` and trip the check that
  // the prose shape exists to satisfy.
  assert.equal(text.includes('USE FOR:'), false);

  // Without a lead-in the default reads as a sentence, which is what the baseline's own prose does.
  assert.equal(
    renderAsProse({ prefix: 'Review test code.' }, ['magic values'], ['unrelated work']),
    'Review test code. Catches magic values. Not for unrelated work.',
  );
  assert.equal(
    renderAsProse({ prefix: 'Review test code.' }, ['magic values'], ['a', 'b']),
    'Review test code. Catches magic values. Not for a or b.',
  );
});

test('pointer clauses are mandatory in both shapes', () => {
  const labels = clauses({
    kind: 'labels',
    prefix: 'p',
    use: ['u1', 'u2'],
    pointers: ['other work (use other-skill)'],
    extras: ['an extra negative'],
  });
  assert.deepEqual(
    labels.map((item) => [item.text, item.mandatory]),
    [['u1', true], ['u2', false], ['other work (use other-skill)', true], ['an extra negative', false]],
  );

  // The prose shape has no `pointers` field, so the marker comes from the `(use …)` form. Getting this
  // wrong is not hypothetical: it silently dropped a required pointer from maui-shell-navigation.
  const prose = clauses({
    kind: 'prose',
    prefix: 'p',
    body: ['b1', 'b2'],
    negatives: ['deep linking', 'data binding (use maui-data-binding)', 'other apps'],
  });
  assert.deepEqual(
    prose.map((item) => [item.text, item.mandatory]),
    [['b1', true], ['b2', false], ['deep linking', false], ['data binding (use maui-data-binding)', true], ['other apps', false]],
  );
});

test('at least one negative survives even when none carries a pointer', () => {
  const items = clauses({ kind: 'labels', prefix: 'p', use: ['u1'], pointers: [], extras: ['first', 'second'] });
  assert.equal(items.find((item) => item.text === 'first').mandatory, true);
  assert.equal(items.find((item) => item.text === 'second').mandatory, false);

  const prose = clauses({ kind: 'prose', prefix: 'p', body: ['b1'], negatives: ['a', 'b'] });
  assert.equal(prose.find((item) => item.text === 'a').mandatory, true);
});

test('fitting drops droppable clauses body-first and keeps every mandatory one', () => {
  const spec = {
    kind: 'labels',
    prefix: 'x'.repeat(60),
    use: ['u'.repeat(40), 'v'.repeat(40), 'w'.repeat(40)],
    pointers: ['keep me (use other-skill)'],
    extras: ['extra one', 'extra two'],
  };
  const text = fitEntry(spec);
  assert.ok(text.length <= BUDGET, text.length.toString());
  assert.ok(text.includes('keep me (use other-skill)'), 'the pointer is not droppable');
  // Body clauses go before negatives: prose examples are worth less than a stated boundary.
  assert.ok(text.includes('extra one'), 'the first extra negative is mandatory when no pointer exists');
  assert.ok(text.includes('u'.repeat(40)), 'the first body clause is mandatory');

  // A mandatory set that cannot fit is left over-long on purpose, for validation to reject: a silent
  // truncation would publish a text missing a clause upstream requires.
  const impossible = fitEntry({ kind: 'labels', prefix: 'p', use: ['u'], pointers: ['x'.repeat(BUDGET)], extras: [] });
  assert.ok(impossible.length > BUDGET);
});

test('validation reports every mechanical rule it can break', () => {
  const entry = packEntry('a/skill', { requiresUseFor: true, requiresDoNotUseFor: true, pointersToKeep: ['other-skill'] });
  assert.deepEqual(validateDraft('p. USE FOR: a. DO NOT USE FOR: b (use other-skill).', entry), []);

  const long = validateDraft(`${'x'.repeat(BUDGET + 1)} USE FOR: a. DO NOT USE FOR: b (use other-skill).`, entry);
  assert.match(long.join('; '), /over budget/);
  assert.match(
    validateDraft('p. USE FOR: a <b>. DO NOT USE FOR: c (use other-skill).', entry).join('; '),
    /cannot carry/,
  );
  assert.match(
    validateDraft('p. USE FOR: a\nb. DO NOT USE FOR: c (use other-skill).', entry).join('; '),
    /cannot carry/,
  );
  assert.match(
    validateDraft('p. USE FOR: a. DO NOT USE FOR: c (use other-skill). INVOKES: dotnet build.', entry).join('; '),
    /INVOKES:/,
  );
  assert.match(validateDraft('p. USE FOR: a.', entry).join('; '), /DO NOT USE FOR: presence/);
  assert.match(validateDraft('p. USE FOR: a. DO NOT USE FOR: b.', entry).join('; '), /lost the pointer to other-skill/);
  // The reverse direction: adding a label upstream does not have is just as wrong.
  assert.match(
    validateDraft('p. USE FOR: a. DO NOT USE FOR: b.', packEntry('a/skill')).join('; '),
    /USE FOR: presence does not match upstream/,
  );
  assert.deepEqual(validateDraft('p.', undefined), ['no entry in the authoring pack']);
});

test('assembleDrafts separates accepted texts from rejections instead of writing both', () => {
  const specs = {
    'a/good': { kind: 'labels', prefix: 'Good skill.', use: ['trigger'], pointers: [], extras: ['nope'] },
    'a/over-budget': { kind: 'labels', prefix: 'x'.repeat(BUDGET), use: ['u'], pointers: [], extras: [] },
  };
  const pack = packOf(
    packEntry('a/good', { requiresUseFor: true, requiresDoNotUseFor: true }),
    packEntry('a/over-budget', { requiresUseFor: true }),
  );
  const { drafts, rejected } = assembleDrafts(specs, pack);
  assert.deepEqual(Object.keys(drafts), ['a/good']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].key, 'a/over-budget');
  assert.match(rejected[0].problems.join('; '), /over budget/);
});

test('mergeEntries takes the fingerprint from the pack, never from the spec', () => {
  const pack = packOf(packEntry('a/skill', { chars: 777, sourceSha256: 'b'.repeat(64) }));
  const merged = mergeEntries(
    { upstream: { tag: 'v1.0.0' }, budget: 320, entries: { 'z/older': { text: 'kept', sourceChars: 1, sourceSha256: 'c', authoredRevision: 1 } } },
    { 'a/skill': 'New text. USE FOR: a.' },
    pack,
  );
  assert.deepEqual(merged.entries['a/skill'], {
    text: 'New text. USE FOR: a.',
    sourceChars: 777,
    sourceSha256: 'b'.repeat(64),
    authoredRevision: 1,
  });
  // Existing entries survive, and keys stay sorted so a batch is reviewable as a diff.
  assert.deepEqual(Object.keys(merged.entries), ['a/skill', 'z/older']);
  assert.equal(merged.entries['z/older'].text, 'kept');
  assert.equal(merged.upstream.tag, 'v1.0.0');
});

test('parseArgv wants a specs path and defaults to the prepare output and the data file', () => {
  assert.equal(typeof parseArgv([]), 'string');
  assert.equal(typeof parseArgv(['--input']), 'string');
  assert.equal(typeof parseArgv(['--nope']), 'string');
  assert.equal(typeof parseArgv(['a.json', 'b.json']), 'string');
  assert.deepEqual(parseArgv(['specs.json']), {
    specs: 'specs.json',
    input: '.authoring/descriptions-input.json',
    data: 'data/descriptions.json',
    dryRun: false,
  });
  assert.deepEqual(parseArgv(['specs.json', '--dry-run', '--data', 'other.json']), {
    specs: 'specs.json',
    input: '.authoring/descriptions-input.json',
    data: 'other.json',
    dryRun: true,
  });
});

test('the real specs files still assemble to the texts they published', () => {
  // A regression guard with teeth: the specs and the data file are both in the repository, so the tool
  // is only as trustworthy as its ability to reproduce what it wrote. These two batches were assembled
  // with it; the earlier ones were written inline, so there is nothing to reproduce for them.
  const specsFiles = ['batch3-dotnet-test.json', 'batch4-maui-upgrade-template.json'];
  const pack = JSON.parse(readFileSync(new URL('../.authoring/descriptions-input.json', import.meta.url), 'utf8'));
  const data = JSON.parse(readFileSync(new URL('../data/descriptions.json', import.meta.url), 'utf8'));
  let reproduced = 0;
  for (const name of specsFiles) {
    const specs = JSON.parse(readFileSync(new URL(`../drafting/authoring-specs/${name}`, import.meta.url), 'utf8'));
    const { drafts, rejected } = assembleDrafts(specs, pack);
    assert.deepEqual(rejected, [], `${name} must assemble cleanly`);
    for (const [key, text] of Object.entries(drafts)) {
      assert.equal(data.entries[key]?.text, text, `${key} drifted from its spec`);
      reproduced += 1;
    }
  }
  // The guard is worthless if it silently found nothing to check.
  assert.equal(reproduced, 30, 'the 12 dotnet-test and 18 maui/upgrade/template entries reproduced');
});

test('the tool is not part of the shipped bundle', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.files.some((entry) => entry.startsWith('tools')), false);
});
