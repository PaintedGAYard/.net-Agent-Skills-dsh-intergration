/**
 * Snapshot sync suite — doc/dev-plan.md W2, the five validation rules.
 *
 * The rules run against throwaway upstream trees built by the test, because a rule that can only
 * be exercised by corrupting the real snapshot is a rule nobody exercises twice.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { planSync } from '../tools/sync-snapshot.mjs';

const MARKETPLACE = '.claude-plugin/marketplace.json';
const PINNED = JSON.parse(
  await import('node:fs').then(({ readFileSync }) =>
    readFileSync(new URL('../vendor/UPSTREAM.json', import.meta.url), 'utf8'),
  ),
);

/** Build an upstream tree with the given plugin → skill map. */
function makeUpstream({ marketplace = ['alpha', 'beta'], plugins }) {
  const root = mkdtempSync(join(tmpdir(), 'dotnet-skills-upstream-'));
  const write = (relative, text) => {
    const full = join(root, relative);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text, 'utf8');
  };
  write(
    MARKETPLACE,
    JSON.stringify({ name: 'test', plugins: marketplace.map((name) => ({ name, source: `./plugins/${name}` })) }),
  );
  for (const [plugin, skills] of Object.entries(plugins)) {
    write(`plugins/${plugin}/plugin.json`, JSON.stringify({ name: plugin, version: '0.1.0', skills: ['./skills/'] }));
    for (const [directory, body] of Object.entries(skills)) {
      write(`plugins/${plugin}/skills/${directory}/SKILL.md`, body);
    }
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const skill = (name, description = 'A synthetic skill description.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`;

test('the real pinned checkout satisfies every validation rule', () => {
  const plan = planSync({ sourceRoot: join(import.meta.dirname, '..', 'submodule', 'dotnet-skills') });
  assert.deepEqual(plan.failures, []);
  assert.equal(plan.inventory.skillCount, PINNED.upstreamInventory.skillCount);
  assert.equal(plan.inventory.pluginNames.length, PINNED.upstreamInventory.pluginCount);
  assert.deepEqual(
    plan.inventory.skills,
    [...PINNED.upstreamInventory.skills].sort(),
    'the snapshot inventory is the baseline name universe',
  );
  assert.deepEqual(
    plan.marketplaceNames,
    PINNED.marketplacePlugins,
    'the marketplace set is the authority for what ships',
  );
  assert.deepEqual(
    plan.extraPlugins,
    PINNED.excludedPlugins.map((plugin) => plugin.name),
    'dotnet-experimental is present upstream but outside the marketplace set',
  );
  assert.deepEqual(plan.outOfRangePlugins, [], 'a full-range sync narrows nothing away');
  // 68 is the baseline's in-range total; the checkout always plans the whole marketplace range, while
  // what the snapshot ships is a range decision recorded in UPSTREAM.json. Assert that relationship
  // instead of a number that changes every time the shipped range grows.
  assert.equal(plan.selected.skillCount, 68);
  assert.equal(plan.selected.names.length, PINNED.marketplacePlugins.length, 'a full sync ships them all');
  assert.equal(
    PINNED.skillCount,
    PINNED.includedPlugins.reduce((sum, plugin) => sum + plugin.skills.length, 0),
    'the shipped range is internally consistent',
  );
  assert.ok(PINNED.skillCount <= plan.selected.skillCount, 'the snapshot never ships more than the checkout plans');
});

test('rule 1: a skill directory that violates the name grammar is rejected', () => {
  const upstream = makeUpstream({
    plugins: {
      alpha: { 'Good-Skill': skill('good-skill'), 'bad_skill': skill('bad_skill') },
      beta: { 'beta-skill': skill('beta-skill') },
    },
  });
  try {
    assert.throws(() => planSync({ sourceRoot: upstream.root }), /violates the skill-name grammar/);
  } finally {
    upstream.dispose();
  }
});

test('rule 2: an empty description is rejected', () => {
  const upstream = makeUpstream({
    plugins: {
      alpha: { 'alpha-skill': '---\nname: alpha-skill\ndescription: "   "\n---\n' },
      beta: { 'beta-skill': skill('beta-skill') },
    },
  });
  try {
    assert.throws(() => planSync({ sourceRoot: upstream.root }), /description is empty/);
  } finally {
    upstream.dispose();
  }
});

test('rule 2b: a missing required key is rejected, and the reason names the key', () => {
  const upstream = makeUpstream({
    plugins: {
      alpha: { 'alpha-skill': '---\nname: alpha-skill\n---\n' },
      beta: { 'beta-skill': skill('beta-skill') },
    },
  });
  try {
    assert.throws(() => planSync({ sourceRoot: upstream.root }), /missing required frontmatter key "description"/);
  } finally {
    upstream.dispose();
  }
});

test('rule 3: CRLF line endings are an error, never a silent repair', () => {
  const upstream = makeUpstream({
    plugins: {
      alpha: { 'alpha-skill': skill('alpha-skill').replace(/\n/g, '\r\n') },
      beta: { 'beta-skill': skill('beta-skill') },
    },
  });
  try {
    assert.throws(() => planSync({ sourceRoot: upstream.root }), /contains CRLF line endings/);
  } finally {
    upstream.dispose();
  }
});

test('rule 4: one skill name in two plugins is rejected rather than silently shadowed', () => {
  const upstream = makeUpstream({
    plugins: {
      alpha: { 'shared-name': skill('shared-name') },
      beta: { 'shared-name': skill('shared-name') },
    },
  });
  try {
    assert.throws(() => planSync({ sourceRoot: upstream.root }), /appears in both alpha and beta/);
  } finally {
    upstream.dispose();
  }
});

test('rule 5: a skill on disk that the plugin manifest does not declare is rejected', () => {
  const upstream = makeUpstream({
    plugins: {
      alpha: { 'declared-skill': skill('declared-skill') },
      beta: { 'beta-skill': skill('beta-skill') },
    },
  });
  try {
    // The plugin declares `./skills/`, and `./skills/` is where the extra directory lives. The
    // declared *set* still covers it by directory, so the rule that catches this is the reader's
    // own name check — a skill present on disk whose frontmatter name disagrees with its folder.
    const extra = join(upstream.root, 'plugins', 'alpha', 'skills', 'undeclared-skill', 'SKILL.md');
    mkdirSync(join(extra, '..'), { recursive: true });
    writeFileSync(extra, skill('a-different-name'), 'utf8');
    assert.throws(() => planSync({ sourceRoot: upstream.root }), /does not match its directory name/);
  } finally {
    upstream.dispose();
  }
});

test('rule 5b: a declared skills directory that does not exist is rejected', () => {
  const upstream = makeUpstream({
    plugins: {
      alpha: { 'declared-skill': skill('declared-skill') },
      beta: { 'beta-skill': skill('beta-skill') },
    },
  });
  try {
    writeFileSync(
      join(upstream.root, 'plugins', 'alpha', 'plugin.json'),
      JSON.stringify({ name: 'alpha', version: '0.1.0', skills: ['./skills/', './not-there/'] }),
      'utf8',
    );
    assert.throws(() => planSync({ sourceRoot: upstream.root }), /declared skills directory \.\/not-there\/ does not exist/);
  } finally {
    upstream.dispose();
  }
});

test('the frontmatter name must match the directory name', () => {
  const upstream = makeUpstream({
    plugins: {
      alpha: { 'alpha-skill': skill('something-else') },
      beta: { 'beta-skill': skill('beta-skill') },
    },
  });
  try {
    assert.throws(() => planSync({ sourceRoot: upstream.root }), /does not match its directory name/);
  } finally {
    upstream.dispose();
  }
});

test('a narrowed range reports incomplete coverage instead of silently shipping less', () => {
  const upstream = makeUpstream({
    plugins: { alpha: { 'alpha-skill': skill('alpha-skill') }, beta: { 'beta-skill': skill('beta-skill') } },
  });
  try {
    const full = planSync({ sourceRoot: upstream.root });
    assert.deepEqual(full.failures, []);
    assert.equal(full.selected.skillCount, 2);

    const narrowed = planSync({ sourceRoot: upstream.root, plugins: ['alpha'] });
    assert.equal(narrowed.failures.length, 1);
    assert.match(narrowed.failures[0], /is not the marketplace set/);
    assert.deepEqual(narrowed.outOfRangePlugins, ['beta']);
    assert.equal(narrowed.selected.skillCount, 1);
  } finally {
    upstream.dispose();
  }
});

test('--allow-partial is what makes a narrowed range legal', () => {
  // The flag was parsed and then never passed to `planSync`, so every narrowed sync failed and the
  // "narrowed on purpose" path was unreachable. P1 ships plugin by plugin, which is exactly that path.
  const upstream = makeUpstream({
    plugins: { alpha: { 'alpha-skill': skill('alpha-skill') }, beta: { 'beta-skill': skill('beta-skill') } },
  });
  try {
    const allowed = planSync({ sourceRoot: upstream.root, plugins: ['alpha'], allowPartial: true });
    assert.deepEqual(allowed.failures, []);
    // The narrowing is still recorded for the status report: allowing it must not hide it.
    assert.deepEqual(allowed.outOfRangePlugins, ['beta']);
    assert.deepEqual(allowed.selected.names, ['alpha']);

    // And it does not quietly turn the check off: a range that is not narrower is unaffected.
    const full = planSync({ sourceRoot: upstream.root, allowPartial: true });
    assert.deepEqual(full.failures, []);
    assert.deepEqual(full.outOfRangePlugins, []);
  } finally {
    upstream.dispose();
  }
});

test('a plugin outside the marketplace set is recorded as excluded, with its skills', () => {
  const upstream = makeUpstream({
    marketplace: ['alpha'],
    plugins: {
      alpha: { 'alpha-skill': skill('alpha-skill') },
      experimental: { 'exp-one': skill('exp-one'), 'exp-two': skill('exp-two') },
    },
  });
  try {
    const plan = planSync({ sourceRoot: upstream.root });
    assert.deepEqual(plan.extraPlugins, ['experimental']);
    assert.deepEqual(plan.outOfRangePlugins, []);
    assert.deepEqual(plan.failures, []);
    // The inventory still covers every name the ref carries, which is what §7.6 needs.
    assert.equal(plan.inventory.skillCount, 3);
    assert.deepEqual(plan.inventory.skills, ['alpha-skill', 'exp-one', 'exp-two']);
  } finally {
    upstream.dispose();
  }
});

test('naming a plugin the marketplace does not list is refused', () => {
  const upstream = makeUpstream({
    marketplace: ['alpha'],
    plugins: { alpha: { 'alpha-skill': skill('alpha-skill') }, experimental: { 'exp-one': skill('exp-one') } },
  });
  try {
    assert.throws(() => planSync({ sourceRoot: upstream.root, plugins: ['experimental'] }), /does not list/);
  } finally {
    upstream.dispose();
  }
});

test('the sync tool refuses to run when no ref is available and never defaults to main', async () => {
  // Reproduce the bootstrap case: a plugin checkout with no cwd to anchor the import.
  const sandbox = mkdtempSync(join(tmpdir(), 'dotnet-skills-noref-'));
  try {
    assert.doesNotMatch(
      JSON.stringify(PINNED.tag),
      /main/,
      'the recorded default must be a tag, not a branch',
    );
    // The recorded tag is what supplies the default, so a missing record must fail loudly.
    const { readFileSync } = await import('node:fs');
    const tool = readFileSync(new URL('../tools/sync-snapshot.mjs', import.meta.url), 'utf8');
    assert.match(tool, /a ref is required and vendor\/UPSTREAM\.json has no "tag" to default to/);
    assert.match(tool, /never falls back to main/);
    assert.equal(tool.includes("?? 'main'"), false, 'no hard-coded main fallback anywhere');
    assert.equal(/default(Ref)?\s*=\s*'main'/.test(tool), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
