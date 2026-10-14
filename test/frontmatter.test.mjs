/**
 * Frontmatter suite — the thirteen cases of doc/dev-plan.md W3.
 *
 * Cases 1–3 run against every real sample of each scalar form, captured from the pinned
 * baseline, so "the parser handles the shape" is never established by a single hand-made
 * example.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  FrontmatterError,
  isSkillName,
  normalizeText,
  parseDocument,
  parseFrontmatterBlock,
  readRequiredKeys,
  splitFrontmatter,
  unknownKeys,
} from '../lib/frontmatter.js';
import { checkoutRoot, descriptionForm, readSnapshotSkills, requireSkill, snapshotRoot } from './helpers.mjs';
import { readUpstreamManifest } from '../lib/snapshot.js';

const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/upstream-descriptions.json', import.meta.url), 'utf8'),
);
const included = fixtures.skills.filter((skill) => !skill.key.startsWith('dotnet-experimental/'));

/**
 * Where to read real `SKILL.md` files from.
 *
 * The frozen fixtures cover all 76 baseline skills, but `vendor/upstream` only ever holds
 * the plugins the current release range includes (three skills during P0). So the
 * all-sample cases prefer the development checkout and fall back to the snapshot, which
 * is what makes this suite meaningful in both environments.
 */
const sampleRoot = existsSync(checkoutRoot) ? join(checkoutRoot, 'plugins') : snapshotRoot;

/** Build a minimal `SKILL.md` with the given frontmatter body. */
function document(frontmatterLines) {
  return `---\n${frontmatterLines.join('\n')}\n---\n\n# Body\n\ntext\n`;
}

test('case 1: every folded block scalar in the baseline folds to trimmed single-space joins', () => {
  const folded = included.filter((skill) => skill.form === 'folded' || skill.form === 'folded-strip');
  assert.equal(folded.length, 40, 'the baseline has 40 folded descriptions (31 ">" and 9 ">-")');
  assert.equal(folded.filter((skill) => skill.form === 'folded').length, 31);
  assert.equal(folded.filter((skill) => skill.form === 'folded-strip').length, 9);

  const skills = readSnapshotSkills(sampleRoot);
  for (const fixture of folded) {
    const skill = requireSkill(skills, fixture.key);
    // The parse result must equal folding the raw block by hand: continuation lines
    // trimmed, joined with one space, then whitespace-normalised.
    assert.equal(skill.description, normalizeText(skill.description));
    assert.equal(skill.description, fixture.description, `${fixture.key} folded text`);
  }
});

test('case 2: every double-quoted scalar has exactly one outer pair stripped', () => {
  const quoted = included.filter((skill) => skill.form === 'double');
  assert.equal(quoted.length, 21, 'the baseline has 21 double-quoted descriptions');

  for (const fixture of quoted) {
    // Two characters is the whole difference between the raw scalar and the parsed value.
    assert.equal(
      fixture.rawScalarLength,
      fixture.chars + 2,
      `${fixture.key}: stripping quotes must account for exactly two characters`,
    );
    const block = parseFrontmatterBlock(`description: "hello world"`);
    assert.equal(block.get('description'), 'hello world');
  }
});

test('case 3: every bare plain scalar is taken verbatim', () => {
  const plain = included.filter((skill) => skill.form === 'plain');
  assert.equal(plain.length, 7, 'the baseline has 7 plain descriptions');
  const skills = readSnapshotSkills(sampleRoot);
  for (const fixture of plain) {
    const skill = requireSkill(skills, fixture.key);
    assert.equal(skill.description, fixture.description);
    assert.equal(skill.frontmatter.get('description'), skill.description);
  }
});

test('case 4: ">" keeps a trailing newline and ">-" does not', () => {
  const keep = parseFrontmatterBlock('description: >\n  one\n  two');
  const strip = parseFrontmatterBlock('description: >-\n  one\n  two');
  assert.equal(keep.get('description'), 'one two\n');
  assert.equal(strip.get('description'), 'one two');
  // The difference is unobservable downstream, which is why §5.1 can keep this rule simple.
  assert.equal(normalizeText(keep.get('description')), normalizeText(strip.get('description')));
});

test('case 5: single-quoted scalars are supported and stripped', () => {
  const block = parseFrontmatterBlock(`description: 'quoted value'`);
  assert.equal(block.get('description'), 'quoted value');
});

test('case 6: a blank line inside a folded block produces a single newline', () => {
  const block = parseFrontmatterBlock('description: >\n  first\n\n  second\nname: x');
  assert.equal(block.get('description'), 'first\nsecond\n', '">" keeps the trailing newline');
  assert.equal(block.get('name'), 'x', 'the block ends at the next key');
  assert.equal(
    parseFrontmatterBlock('description: >-\n  first\n\n  second\nname: x').get('description'),
    'first\nsecond',
  );
});

test('case 7: unknown keys are preserved verbatim and never throw', () => {
  const block = parseFrontmatterBlock('name: a\nallowed-tools: shell, edit\nlicense: MIT');
  assert.deepEqual(unknownKeys(block), { 'allowed-tools': 'shell, edit', license: 'MIT' });
  assert.deepEqual(unknownKeys(parseFrontmatterBlock('name: a\ndescription: b')), {});
});

test('case 8: literal block scalars are rejected', () => {
  assert.throws(() => parseFrontmatterBlock('description: |\n  text'), FrontmatterError);
  assert.throws(() => parseFrontmatterBlock('description: |-\n  text'), FrontmatterError);
});

test('case 9: nested mappings, sequences, anchors and aliases are rejected', () => {
  assert.throws(() => parseFrontmatterBlock('metadata:\n  owner: team'), FrontmatterError);
  assert.throws(() => parseFrontmatterBlock('metadata:\n  - one'), FrontmatterError);
  assert.throws(() => parseFrontmatterBlock('tools:\n  - a'), FrontmatterError);
  assert.throws(() => parseFrontmatterBlock('name: &anchor value'), FrontmatterError);
  assert.throws(() => parseFrontmatterBlock('name: *anchor'), FrontmatterError);
  assert.throws(() => parseFrontmatterBlock('name: !!str value'), FrontmatterError);
  assert.throws(() => parseFrontmatterBlock('name: a\nname: b'), FrontmatterError);
  assert.throws(() => parseFrontmatterBlock('just a sentence without a colon'), FrontmatterError);
  assert.throws(() => parseDocument('# no frontmatter\n'), FrontmatterError);
  assert.throws(() => splitFrontmatter('---\nname: a\n'), FrontmatterError);
});

test('case 10: a missing required key is a diagnostic, not a throw', () => {
  const noName = parseFrontmatterBlock('description: d');
  assert.deepEqual(readRequiredKeys(noName), { ok: false, reason: 'missing required frontmatter key "name"' });

  const noDescription = parseFrontmatterBlock('name: a');
  assert.deepEqual(readRequiredKeys(noDescription), {
    ok: false,
    reason: 'missing required frontmatter key "description"',
  });

  const emptyDescription = parseFrontmatterBlock('name: a\ndescription: "  "');
  assert.equal(readRequiredKeys(emptyDescription).ok, false);

  const document10 = document(['name: a']);
  assert.ok(splitFrontmatter(document10).body.startsWith('\n# Body'));
});

test('case 11: CRLF input parses and the file is never rewritten', () => {
  const crlf = '---\r\nname: crlf-skill\r\ndescription: >\r\n  folded across\r\n  two lines\r\n---\r\n\r\nbody\r\n';
  const parsed = parseDocument(crlf);
  assert.equal(parsed.frontmatter.get('name'), 'crlf-skill');
  assert.equal(parsed.frontmatter.get('description'), 'folded across two lines\n');
  const required = readRequiredKeys(parsed.frontmatter);
  assert.equal(required.ok, true);

  // Reading is a pure operation: the byte length of the source is untouched.
  const before = crlf.length;
  parseDocument(crlf);
  assert.equal(crlf.length, before);
  assert.ok(crlf.includes('\r\n'), 'the CRLF text is still CRLF');
});

test('case 12: illegal names are skipped with a distinct reason', () => {
  for (const name of ['Upper-Case', 'under_score', 'double--dash', '-leading', 'trailing-', 'sp ace', 'áccent']) {
    const result = readRequiredKeys(parseFrontmatterBlock(`name: ${name}\ndescription: d`));
    assert.equal(result.ok, false, `${name} must be rejected`);
    assert.match(result.reason, /skill-name grammar/);
    assert.equal(isSkillName(name), false);
  }
  for (const name of ['a', 'run-tests', 'migrate-mstest-v3-to-v4', 'net10']) {
    assert.equal(isSkillName(name), true, `${name} must be accepted`);
  }
});

test('case 13: every skill in the served snapshot agrees with its frozen fixture', () => {
  const served = readSnapshotSkills(snapshotRoot);
  // The served count is the manifest's own record, so widening the range (P1 ships it plugin by
  // plugin) does not turn a correct snapshot into a failing test.
  const shippedCount = readUpstreamManifest().manifest.skillCount;
  assert.equal(served.length, shippedCount, 'the snapshot serves exactly what UPSTREAM.json records');

  const total = included.reduce((sum, skill) => sum + skill.chars, 0);
  assert.equal(total, 45428, 'the pinned baseline totals 45,428 description characters (spec §2.3)');

  for (const skill of served) {
    const fixture = fixtures.skills.find((candidate) => candidate.key === `${skill.plugin}/${skill.name}`);
    assert.ok(fixture !== undefined, `${skill.name} has no fixture`);
    assert.equal(skill.description, fixture.description, `${skill.name} description`);
    assert.equal(createHash('sha256').update(skill.description).digest('hex'), fixture.sha256);
    assert.equal(descriptionForm(skill.source), fixture.form);
  }

  // Fixture integrity: the captured text still describes the checkout on disk.
  if (existsSync(checkoutRoot)) {
    for (const fixture of included) {
      const [plugin, name] = fixture.key.split('/');
      const source = readFileSync(join(checkoutRoot, 'plugins', plugin, 'skills', name, 'SKILL.md'), 'utf8');
      const parsed = parseDocument(source);
      const required = readRequiredKeys(parsed.frontmatter);
      assert.equal(required.ok, true, fixture.key);
      assert.equal(required.description, fixture.description, `${fixture.key} drifted from the checkout`);
      assert.equal(descriptionForm(source), fixture.form, `${fixture.key} scalar form drifted`);
      assert.equal(
        createHash('sha256').update(required.description).digest('hex'),
        fixture.sha256,
        `${fixture.key} digest`,
      );
    }
  }
});

test('shape census matches the baseline counts the design depends on', () => {
  assert.equal(included.length, 68);
  assert.equal(included.filter((skill) => skill.chars > 500).length, 51);
  assert.equal(included.filter((skill) => skill.hasInvokes).length, 13);
  assert.equal(included.filter((skill) => skill.chars > 500 || skill.hasInvokes).length, 53);
  assert.equal(included.filter((skill) => skill.chars <= 500 && !skill.hasInvokes).length, 15);
  assert.equal(included.filter((skill) => skill.userInvocable === false).length, 3);
  assert.equal(included.reduce((sum, skill) => sum + skill.chars, 0), 45428);
});

/**
 * The two routing labels are strictly bound in the baseline: every entry carries both
 * or neither. Invariants ④ and ⑤ are written as "if and only if" because of exactly
 * this, and these are the numbers they turn into an authoring obligation.
 *
 * Measured, not assumed: the baseline has 47 tagged entries and 21 untagged ones. The
 * six entries doc/spec.md §2.4 names as "carrying neither label" are a subset of the 21,
 * so invariants ④/⑤ are unconstrained for 15 entries beyond those six. The six named
 * entries are the ones whose *routing signal is prose inside a long description*, which
 * is why they are the ones that need human review.
 */
test('tag census: 47 carry both labels, 21 carry neither, none carries only one', () => {
  const both = included.filter((skill) => skill.hasUseFor && skill.hasDoNotUseFor);
  const untagged = included.filter((skill) => !skill.hasUseFor && !skill.hasDoNotUseFor);
  const useForOnly = included.filter((skill) => skill.hasUseFor && !skill.hasDoNotUseFor);
  const doNotUseForOnly = included.filter((skill) => skill.hasDoNotUseFor && !skill.hasUseFor);

  assert.equal(both.length, 47, 'the 47 tagged entries of doc/spec.md §7.5');
  assert.equal(untagged.length, 21);
  assert.equal(useForOnly.length, 0);
  assert.equal(doNotUseForOnly.length, 0);
  assert.equal(both.length + untagged.length, 68);
  assert.equal(both.length + untagged.length - 15, 53, 'the authoring coverage set still holds 53 entries');

  const proseRouting = [
    'dotnet-ai/technology-selection',
    'dotnet-diag/android-tombstone-symbolication',
    'dotnet-diag/apple-crash-symbolication',
    'dotnet-diag/microbenchmarking',
    'dotnet-test/test-anti-patterns',
    'dotnet-test/writing-mstest-tests',
  ];
  for (const key of proseRouting) {
    assert.ok(untagged.some((skill) => skill.key === key), `${key} must be untagged`);
  }
});
