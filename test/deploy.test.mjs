/**
 * Deployment suite — doc/dev-plan.md W12.
 *
 * The nine cases of the plan are here, in order, plus the states the plan implies: an unreadable
 * manifest, an unknown platform, and the adapter conventions the tool and the status report both
 * depend on.
 *
 * Two cases need a real symlink, which this machine may refuse (Windows without Developer Mode
 * returns `EPERM`, and so does a filesystem that cannot carry links). They are skipped rather than
 * faked when the probe says so, and the skip reason is the measured code: the production code takes
 * exactly the same path, which is the copy fallback those cases' siblings assert.
 */

import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { resolveConfig } from '../lib/config.js';
import { deploy, inspectDeployment, probeSymlink, readManifest } from '../lib/deploy/index.js';
import { KNOWN_PLATFORMS, selectAdapter } from '../lib/platform/index.js';
import { createSelectionService } from '../lib/selection.js';
import { readUpstreamManifest } from '../lib/snapshot.js';
import { createSnapshotSource } from '../lib/source-snapshot.js';
import { collectEntries, parseArgv, resolveRoot } from '../tools/deploy.mjs';

/** The repository root, so case 8 does not depend on where the runner was started. */
const REPO = fileURLToPath(new URL('..', import.meta.url));

const adapter = selectAdapter('win32');

/** A scratch directory that is removed even when an assertion fails. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'dotnet-skills-deploy-'));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** Two fake skills, each with a body and a nested reference, as the snapshot has. */
function sources(root) {
  const entries = [];
  for (const [skill, plugin, body] of [
    ['alpha-skill', 'dotnet-msbuild', 'alpha body'],
    ['beta-skill', 'dotnet-test', 'beta body'],
    ['gamma-skill', 'dotnet-data', 'gamma body'],
  ]) {
    const source = join(root, 'upstream', plugin, skill);
    mkdirSync(join(source, 'references'), { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), body, 'utf8');
    writeFileSync(join(source, 'references', 'notes.md'), `${skill} notes`, 'utf8');
    entries.push({ skill, plugin, source });
  }
  return entries;
}

/** Whether this machine, right now, will create a symlink in this directory. */
function canLink(root) {
  return probeSymlink(root, { adapter });
}

test('case 8: no platform branch outside lib/platform/', () => {
  const offenders = [];
  const scan = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (full.replace(/\\/g, '/').endsWith('lib/platform')) continue;
        scan(full);
        continue;
      }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      const text = readFileSync(full, 'utf8');
      if (text.includes('process.platform')) offenders.push(`${full}: process.platform`);
      if (/===\s*['"](win32|darwin|linux)['"]/.test(text)) offenders.push(`${full}: a platform literal comparison`);
    }
  };
  for (const relative of ['lib', 'tools']) scan(join(REPO, relative));
  // The shipped entry point is the file a platform branch would most plausibly be added to, so it is
  // scanned as well even though the plan's wording stops at `lib/**` and `tools/**`.
  if (readFileSync(join(REPO, 'index.js'), 'utf8').includes('process.platform')) offenders.push('index.js: process.platform');
  assert.deepEqual(offenders, [], 'a platform decision outside lib/platform/ is one nobody will find for macOS');
  assert.deepEqual(KNOWN_PLATFORMS, ['win32', 'linux', 'darwin']);
});

test('case 9: the macOS adapter refuses instead of guessing', () => {
  const macos = selectAdapter('darwin');
  assert.throws(() => macos.defaultDeployRoot({ home: '/Users/example' }), /macOS adapter not implemented/);
  assert.throws(() => macos.symlinkHint('EPERM'), /macOS adapter not implemented/);
  // An unknown platform is refused too: falling back to Linux would guess at path conventions.
  assert.throws(() => selectAdapter('freebsd'), /no deployment adapter for platform "freebsd"/);
});

test('the deploy root convention is the one the host already scans', () => {
  for (const name of ['win32', 'linux']) {
    const platform = selectAdapter(name);
    assert.equal(platform.defaultDeployRoot({ home: join('home', 'user'), env: {} }), join('home', 'user', '.dsh', 'skills'));
    assert.equal(
      platform.defaultDeployRoot({ home: join('home', 'user'), env: { DSH_HOME: join('opt', 'dsh') } }),
      join('opt', 'dsh', 'skills'),
      'a relocated Harness is where the host scans, so it is where a deployment belongs',
    );
  }
  assert.equal(selectAdapter('win32').foldPath('C:/Users/A/B'), 'c:/users/a/b');
  assert.equal(selectAdapter('linux').foldPath('C:/Users/A/B'), 'C:/Users/A/B');
});

test('case 1: a target that supports symlinks is deployed as links', { skip: skipUnlessLinkCapable() }, () => {
  const workspace = scratch();
  const upstream = scratch();
  try {
    const entries = sources(upstream.root).slice(0, 2);
    const result = deploy({ entries, root: workspace.root, adapter, snapshot: { tag: 'v1.0.0', commit: 'abc' } });

    assert.equal(result.mode, 'symlink');
    assert.deepEqual(result.written.length, 2);
    for (const entry of entries) {
      const deployed = join(workspace.root, entry.skill);
      assert.equal(lstatSync(deployed).isSymbolicLink(), true, `${entry.skill} is a link`);
      assert.equal(readFileSync(join(deployed, 'SKILL.md'), 'utf8'), `${entry.skill.split('-')[0]} body`);
    }

    const manifest = readManifest(workspace.root).manifest;
    assert.equal(manifest.mode, 'symlink');
    assert.deepEqual(
      manifest.entries.map((entry) => [entry.skill, entry.plugin, entry.deployed]),
      [
        ['alpha-skill', 'dotnet-msbuild', join(workspace.root, 'alpha-skill')],
        ['beta-skill', 'dotnet-test', join(workspace.root, 'beta-skill')],
      ],
    );
    assert.equal(manifest.snapshot.tag, 'v1.0.0');
    assert.equal(manifest.entries[0].files, undefined, 'a link covers whatever the snapshot holds, so there is no file list');
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('case 2: EPERM degrades the whole batch to copies, and says so twice', () => {
  const workspace = scratch();
  const upstream = scratch();
  const lines = [];
  try {
    const entries = sources(upstream.root).slice(0, 2);
    const result = deploy({
      entries,
      root: workspace.root,
      adapter,
      probe: () => ({ ok: false, code: 'EPERM', message: 'EPERM: operation not permitted, symlink' }),
      log: (line) => lines.push(line),
    });

    assert.equal(result.mode, 'copy');
    assert.equal(result.probe.fallback, true);
    assert.equal(lines.filter((line) => line.includes('EPERM')).length, 1, 'the degradation is logged once');
    assert.match(lines[0], /Developer Mode|SeCreateSymbolicLinkPrivilege/, 'and it names the likely causes');
    assert.match(lines[0], /sandbox/, 'without asserting one of them as the diagnosis');

    // The two visible channels §10.3 requires: the log above, and the state the status tool reads.
    const inspection = inspectDeployment({ root: workspace.root, adapter });
    assert.equal(inspection.mode, 'copy');
    assert.match(inspection.degradedReason, /EPERM/);
    assert.deepEqual(inspection.dangling, []);
    assert.equal(inspection.complete, true);

    for (const entry of entries) {
      const deployed = join(workspace.root, entry.skill);
      assert.equal(lstatSync(deployed).isSymbolicLink(), false);
      assert.equal(readFileSync(join(deployed, 'references', 'notes.md'), 'utf8'), `${entry.skill} notes`);
    }
    assert.equal(readManifest(workspace.root).manifest.entries[0].files.length, 2, 'a copy records what it wrote');
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('case 3: ENOSYS degrades too', () => {
  const workspace = scratch();
  const upstream = scratch();
  try {
    const result = deploy({
      entries: sources(upstream.root).slice(0, 1),
      root: workspace.root,
      adapter,
      probe: () => ({ ok: false, code: 'ENOSYS', message: 'ENOSYS: function not implemented' }),
    });
    assert.equal(result.mode, 'copy');
    assert.equal(readManifest(workspace.root).manifest.mode, 'copy');
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('case 4: any other error is reported, never silently degraded', () => {
  const workspace = scratch();
  const upstream = scratch();
  try {
    assert.throws(
      () =>
        deploy({
          entries: sources(upstream.root).slice(0, 1),
          root: workspace.root,
          adapter,
          probe: () => ({ ok: false, code: 'EIO', message: 'EIO: i/o error, symlink' }),
        }),
      /EIO.*reported rather than degraded/s,
    );
    assert.equal(readManifest(workspace.root).present, false, 'a refused deployment writes no manifest');
    assert.deepEqual(readdirSync(workspace.root), [], 'and leaves nothing behind');
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('case 5: a copy-mode re-deployment reclaims precisely and spares user files', () => {
  const workspace = scratch();
  const upstream = scratch();
  try {
    const [alpha, beta, gamma] = sources(upstream.root);
    deploy({ entries: [alpha, beta], root: workspace.root, adapter, probe: () => ({ ok: false, code: 'EPERM' }) });

    // What a user does to a directory this plugin happens to write into.
    writeFileSync(join(workspace.root, 'my-notes.md'), 'mine', 'utf8');
    writeFileSync(join(workspace.root, 'alpha-skill', 'my-edit.md'), 'mine', 'utf8');
    writeFileSync(join(workspace.root, 'alpha-skill', 'references', 'extra.md'), 'mine', 'utf8');

    // beta leaves the selection entirely, and alpha's content changes upstream.
    writeFileSync(join(alpha.source, 'SKILL.md'), 'alpha body v2', 'utf8');
    const second = deploy({ entries: [alpha, gamma], root: workspace.root, adapter, probe: () => ({ ok: false, code: 'EPERM' }) });

    assert.equal(existsSync(join(workspace.root, 'beta-skill')), false, 'the departed skill directory is gone');
    assert.ok(second.removed.some((path) => path.includes('beta-skill')));

    assert.equal(readFileSync(join(workspace.root, 'my-notes.md'), 'utf8'), 'mine', 'a file in the root survives');
    assert.equal(readFileSync(join(workspace.root, 'alpha-skill', 'my-edit.md'), 'utf8'), 'mine', 'a file inside a skill survives');
    assert.equal(
      readFileSync(join(workspace.root, 'alpha-skill', 'references', 'extra.md'), 'utf8'),
      'mine',
      'a file in a nested directory survives, and so does the directory',
    );
    assert.equal(readFileSync(join(workspace.root, 'alpha-skill', 'SKILL.md'), 'utf8'), 'alpha body v2', 'refreshed content');
    assert.ok(second.kept.some((line) => line.includes('alpha-skill')), 'and the report says why the directory stayed');

    const manifest = readManifest(workspace.root).manifest;
    assert.deepEqual(manifest.entries.map((entry) => entry.skill), ['alpha-skill', 'gamma-skill']);
    assert.equal(manifest.entries[0].files.includes('my-edit.md'), false, 'a user file is never recorded as ours');
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('case 6: a symlinked deployment sees snapshot updates without re-deploying', { skip: skipUnlessLinkCapable() }, () => {
  const workspace = scratch();
  const upstream = scratch();
  try {
    const [alpha] = sources(upstream.root);
    deploy({ entries: [alpha], root: workspace.root, adapter });
    writeFileSync(join(alpha.source, 'SKILL.md'), 'edited after deployment', 'utf8');
    assert.equal(readFileSync(join(workspace.root, 'alpha-skill', 'SKILL.md'), 'utf8'), 'edited after deployment');
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('case 7: a vanished target is reported as dangling, not counted as deployed', { skip: skipUnlessLinkCapable() }, () => {
  const workspace = scratch();
  const upstream = scratch();
  try {
    const [alpha, beta] = sources(upstream.root);
    deploy({ entries: [alpha, beta], root: workspace.root, adapter });
    assert.equal(inspectDeployment({ root: workspace.root, adapter }).complete, true);

    rmSync(alpha.source, { recursive: true, force: true });
    const broken = inspectDeployment({ root: workspace.root, adapter });
    assert.deepEqual(broken.dangling, ['alpha-skill']);
    assert.equal(broken.complete, false);
    assert.equal(broken.entries, 2, 'the entry is still deployed; it just cannot be read');
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('case 7b: a missing copied file dangles as well, on any machine', () => {
  const workspace = scratch();
  const upstream = scratch();
  try {
    const [alpha, beta] = sources(upstream.root);
    deploy({ entries: [alpha, beta], root: workspace.root, adapter, probe: () => ({ ok: false, code: 'EPERM' }) });
    rmSync(join(workspace.root, 'beta-skill', 'references', 'notes.md'));

    const inspection = inspectDeployment({ root: workspace.root, adapter });
    assert.deepEqual(inspection.dangling, ['beta-skill']);
    assert.equal(inspection.complete, false);
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('a manifest this plugin cannot read stops the deployment instead of eating the root', () => {
  const workspace = scratch();
  const upstream = scratch();
  try {
    writeFileSync(join(workspace.root, '.dsh-dotnet-skills-manifest.json'), '{ not json', 'utf8');
    writeFileSync(join(workspace.root, 'user-file.md'), 'mine', 'utf8');

    assert.throws(
      () => deploy({ entries: sources(upstream.root).slice(0, 1), root: workspace.root, adapter }),
      /manifest .*unreadable.*refusing to deploy/s,
    );
    assert.equal(readFileSync(join(workspace.root, 'user-file.md'), 'utf8'), 'mine');

    const inspection = inspectDeployment({ root: workspace.root, adapter });
    assert.equal(inspection.mode, 'unknown');
    assert.equal(inspection.complete, false);
    assert.match(inspection.reason, /unreadable/);
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('an empty root inspects as "nothing deployed" rather than as a failure', () => {
  const workspace = scratch();
  try {
    const inspection = inspectDeployment({ root: workspace.root, adapter });
    assert.equal(inspection.mode, 'none');
    assert.equal(inspection.complete, true);
    assert.equal(inspection.entries, 0);
    assert.match(inspection.reason, /nothing is deployed/);
  } finally {
    workspace.dispose();
  }
});

test('case 5b: a colliding path this plugin did not write is never deleted for it', () => {
  const workspace = scratch();
  const upstream = scratch();
  const lines = [];
  try {
    const [alpha] = sources(upstream.root);
    mkdirSync(join(workspace.root, 'alpha-skill'), { recursive: true });
    writeFileSync(join(workspace.root, 'alpha-skill', 'someone-elses.md'), 'theirs', 'utf8');

    const result = deploy({
      entries: [alpha],
      root: workspace.root,
      adapter,
      probe: () => ({ ok: false, code: 'EPERM' }),
      log: (line) => lines.push(line),
    });

    assert.deepEqual(result.collisions, [join(workspace.root, 'alpha-skill')]);
    assert.deepEqual(result.skipped, [], 'a copy can merge, so nothing has to be skipped');
    assert.match(lines.join('\n'), /did not write it/);
    assert.equal(existsSync(join(workspace.root, 'alpha-skill', 'someone-elses.md')), true, 'a copy merges rather than deleting');
    assert.equal(readFileSync(join(workspace.root, 'alpha-skill', 'SKILL.md'), 'utf8'), 'alpha body');
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('case 5c: a link cannot merge, so a collision is skipped instead of deleted', { skip: skipUnlessLinkCapable() }, () => {
  const workspace = scratch();
  const upstream = scratch();
  const lines = [];
  try {
    const [alpha, beta] = sources(upstream.root);
    mkdirSync(join(workspace.root, 'alpha-skill'), { recursive: true });
    writeFileSync(join(workspace.root, 'alpha-skill', 'someone-elses.md'), 'theirs', 'utf8');

    const result = deploy({ entries: [alpha, beta], root: workspace.root, adapter, log: (line) => lines.push(line) });

    assert.deepEqual(result.skipped, ['alpha-skill']);
    assert.equal(lstatSync(join(workspace.root, 'alpha-skill')).isSymbolicLink(), false, 'the user directory is untouched');
    assert.equal(readFileSync(join(workspace.root, 'alpha-skill', 'someone-elses.md'), 'utf8'), 'theirs');
    assert.equal(lstatSync(join(workspace.root, 'beta-skill')).isSymbolicLink(), true, 'the rest still deploys');
    assert.match(lines.join('\n'), /skipping alpha-skill/);
    assert.deepEqual(
      readManifest(workspace.root).manifest.entries.map((entry) => entry.skill),
      ['beta-skill'],
      'the manifest records what was deployed, not what was wanted',
    );
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('a re-deployment in symlink mode reclaims nothing, because there is nothing to refresh', { skip: skipUnlessLinkCapable() }, () => {
  const workspace = scratch();
  const upstream = scratch();
  try {
    const entries = sources(upstream.root);
    const first = deploy({ entries, root: workspace.root, adapter });
    const second = deploy({ entries, root: workspace.root, adapter });

    assert.equal(second.mode, 'symlink');
    assert.deepEqual(second.removed, [], 'the links already point at the right place');
    assert.deepEqual(second.kept, []);
    assert.deepEqual(second.written, first.written);
    assert.deepEqual(readManifest(workspace.root).manifest.entries, first.manifest.entries);
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('a re-deployment in copy mode refreshes the copies it owns, and only those', () => {
  const workspace = scratch();
  const upstream = scratch();
  try {
    const entries = sources(upstream.root);
    const injected = () => ({ ok: false, code: 'EPERM' });
    const first = deploy({ entries, root: workspace.root, adapter, probe: injected });
    const second = deploy({ entries, root: workspace.root, adapter, probe: injected });

    assert.equal(second.mode, 'copy');
    assert.deepEqual(second.written, first.written);
    assert.deepEqual(
      readManifest(workspace.root).manifest.entries,
      first.manifest.entries,
      'the same files are recorded, so the manifest is stable across a refresh',
    );
    // Refreshing means removing this plugin's own files and writing them again; it never means
    // removing the directories, which is what protects anything a user put inside them.
    assert.ok(second.removed.every((path) => first.manifest.entries.some((entry) => path.startsWith(entry.deployed))));
    for (const entry of entries) assert.equal(existsSync(join(workspace.root, entry.skill)), true);
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

test('removing a deployment never follows a link into the snapshot', { skip: skipUnlessLinkCapable() }, () => {
  const workspace = scratch();
  const upstream = scratch();
  try {
    const [alpha] = sources(upstream.root);
    deploy({ entries: [alpha], root: workspace.root, adapter });
    // An empty selection is a real operation — a re-deployment after the workspace stopped matching —
    // and it is the path where a link must be unlinked rather than recursed into. Getting this wrong
    // deletes the snapshot.
    const second = deploy({ entries: [], root: workspace.root, adapter });

    assert.equal(existsSync(join(workspace.root, 'alpha-skill')), false, 'the link is gone');
    assert.equal(existsSync(join(alpha.source, 'SKILL.md')), true, 'and its target is untouched');
    assert.equal(second.removed.some((path) => path.includes('alpha-skill')), true);
    assert.deepEqual(inspectDeployment({ root: workspace.root, adapter }).dangling, []);
  } finally {
    workspace.dispose();
    upstream.dispose();
  }
});

/** `node:test` skip argument for the two cases that need a real link from the OS. */
function skipUnlessLinkCapable() {
  const workspace = scratch();
  try {
    const result = canLink(workspace.root);
    return result.ok ? false : `symlinks are refused here (${result.code}); the copy path is asserted by the sibling cases`;
  } finally {
    workspace.dispose();
  }
}

test('the deploy tool parses its own arguments and refuses nonsense', () => {
  assert.deepEqual(parseArgv(['--all', '--dry-run']), {
    root: undefined,
    cwd: undefined,
    plugins: [],
    skills: [],
    all: true,
    status: false,
    dryRun: true,
    json: false,
  });
  assert.deepEqual(parseArgv(['--plugins', 'dotnet-test, dotnet-data', '--skills', 'run-tests']).plugins, ['dotnet-test', 'dotnet-data']);
  assert.deepEqual(parseArgv(['--skills', 'run-tests']).skills, ['run-tests']);
  assert.equal(parseArgv(['--root']), '--root needs a value');
  assert.match(parseArgv(['--nope']), /unrecognised argument "--nope"/);
});

test('the deploy tool takes the platform convention unless a root is named', () => {
  const platform = selectAdapter('win32');
  assert.equal(resolveRoot(undefined, platform), platform.defaultDeployRoot({ home: homedir() }));
  assert.equal(resolveRoot('D:/browse', platform), 'D:/browse');
});

test('the entries a deployment would write all exist in the snapshot', () => {
  const manifest = readUpstreamManifest().manifest;
  const source = createSnapshotSource({ plugins: (manifest.includedPlugins ?? []).map((plugin) => plugin.name) });
  const config = resolveConfig({});
  const selection = createSelectionService({
    config,
    manifest,
    pluginSkills: source.pluginSkills(),
    detect: () => ({ plugins: [] }),
  });

  const { entries, missing } = collectEntries({ source, selection, cwd: undefined });
  assert.deepEqual(missing, [], 'the default configuration names only shipped skills');
  assert.deepEqual(
    entries.map((entry) => entry.plugin),
    ['dotnet', 'dotnet', 'dotnet'],
    'the default selection is the core set',
  );
  for (const entry of entries) {
    assert.equal(existsSync(join(entry.source, 'SKILL.md')), true, `${entry.skill} has a body to deploy`);
  }
});
