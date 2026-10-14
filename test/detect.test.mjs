/**
 * Project detection suite — doc/dev-plan.md W11.
 *
 * Two kinds of assertion matter here and they fail in different ways. The signal table is checked
 * row by row with one fixture per row, so a row that stops matching is a red test rather than a
 * quietly smaller catalog. The four contract properties — bounded, pure, memoized, grow-only — are
 * checked against the module's own outputs, because each of them is a property a caller can observe
 * and therefore something the model can observe too.
 *
 * Expectations are derived from `vendor/UPSTREAM.json` wherever they are about the shipped range, so
 * growing the range cannot silently invalidate this file. Where a fact *is* the contract (which
 * plugin a §9.2 row enables) it is written down once, in `ROWS`.
 */

import assert from 'node:assert/strict';
import { readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ALWAYS_ON_PLUGIN, createProjectDetector, SIGNAL_TABLE } from '../lib/detect.js';
import { createSelectionService } from '../lib/selection.js';
import { readUpstreamManifest } from '../lib/snapshot.js';
import { makeTempSnapshot } from './helpers.mjs';

const manifest = readUpstreamManifest().manifest;

/**
 * A fixed timestamp for every fixture.
 *
 * The memo key is an mtime bucket, so a fixture whose mtimes are "now" would be inside no bucket and
 * inside every bucket depending on when the test ran. Pinning the tree to a constant makes both the
 * memoization cases and the re-scan cases deterministic.
 */
const EPOCH = 1_700_000_000_000;

function stampTree(root, ms) {
  const seconds = ms / 1000;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        utimesSync(full, seconds, seconds);
        walk(full);
      } else if (entry.isFile()) {
        utimesSync(full, seconds, seconds);
      }
    }
  };
  utimesSync(root, seconds, seconds);
  walk(root);
}

/** A workspace fixture with pinned mtimes. */
function makeProject(files) {
  const made = makeTempSnapshot(files);
  stampTree(made.root, EPOCH);
  return made;
}

/** A detector over a user-written configuration, defaulting to detection enabled. */
function detector(config = {}, options = {}) {
  return createProjectDetector({ config: { probe: { enabled: true }, ...config }, ...options });
}

/** A selection service with detection wired, for the fold-level cases. */
function service({ detect, config = {} } = {}) {
  return createSelectionService({
    config: {
      probe: { enabled: true },
      disabledSelectors: [],
      enabledPlugins: [],
      enabledSkills: [],
      disabledSkills: [],
      ...config,
    },
    manifest,
    detect,
  });
}

/** The core set, read from the manifest rather than hard-coded (§8.4). */
const coreSkills = (manifest.includedPlugins ?? []).find((plugin) => plugin.name === ALWAYS_ON_PLUGIN)?.skills ?? [];

/** Skills of one plugin, read from the manifest: which names exist is upstream's business, not this file's. */
const skillsOf = (plugin) => (manifest.includedPlugins ?? []).find((entry) => entry.name === plugin)?.skills ?? [];

/** The part of a result that must not depend on where the fixture happens to live. */
const portable = (result) => ({ plugins: result.plugins, evidence: result.evidence, retained: result.retained, scanned: { ...result.scanned, cwd: null } });

/**
 * §9.2, one fixture per row.
 *
 * Each row is a whole workspace, not a fragment, so `deepEqual(plugins, [plugin])` also proves the
 * row does *not* fire the neighbouring ones — which is how a signal table rots.
 */
const ROWS = [
  {
    id: 'dotnet-repo',
    plugin: null,
    files: {
      'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'app.sln': '',
      'Directory.Build.props': '<Project />',
      'Directory.Packages.props': '<Project />',
      'global.json': '{}',
      'NuGet.config': '<configuration />',
    },
  },
  {
    id: 'msbuild',
    plugin: 'dotnet-msbuild',
    files: { 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />', 'msbuild.binlog': '' },
  },
  {
    id: 'msbuild',
    plugin: 'dotnet-msbuild',
    label: 'through Directory.Build.targets',
    files: { 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />', 'Directory.Build.targets': '<Project />' },
  },
  {
    id: 'msbuild',
    plugin: 'dotnet-msbuild',
    label: 'through a deep *.props hierarchy',
    files: { 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />', 'src/generator/native/build.props': '<Project />' },
  },
  {
    id: 'test-sdk',
    plugin: 'dotnet-test',
    files: {
      'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'tests/Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup></Project>',
    },
  },
  {
    id: 'test-sdk',
    plugin: 'dotnet-test',
    label: 'through a framework name',
    files: {
      'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'tests/Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" /></ItemGroup></Project>',
    },
  },
  {
    id: 'mtp-migration',
    plugin: 'dotnet-test',
    files: {
      'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'test.runsettings': '',
      'Directory.Build.props':
        '<Project><PropertyGroup><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup></Project>',
    },
  },
  {
    id: 'maui',
    plugin: 'dotnet-maui',
    files: { 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><UseMaui>true</UseMaui></PropertyGroup></Project>' },
  },
  {
    id: 'maui',
    plugin: 'dotnet-maui',
    label: 'through MauiProgram.cs',
    files: { 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />', 'MauiProgram.cs': 'public static class MauiProgram {}' },
  },
  {
    id: 'aspnet',
    plugin: 'dotnet-aspnet',
    files: { 'web.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />' },
  },
  {
    id: 'aspnet',
    plugin: 'dotnet-aspnet',
    label: 'through a top-level app.MapGet',
    files: { 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />', 'Program.cs': 'var app = builder.Build();\napp.MapGet("/", () => "ok");\n' },
  },
  {
    id: 'ef-core',
    plugin: 'dotnet-data',
    files: {
      'data.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" /></ItemGroup></Project>',
    },
  },
  {
    id: 'upgrade',
    plugin: 'dotnet-upgrade',
    files: { 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net8.0;net10.0</TargetFrameworks></PropertyGroup></Project>' },
  },
  {
    id: 'ai',
    plugin: 'dotnet-ai',
    files: {
      'ai.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.SemanticKernel" /></ItemGroup></Project>',
    },
  },
  {
    id: 'ai',
    plugin: 'dotnet-ai',
    label: 'through an MCP server project',
    files: { 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />', '.mcp.json': '{}' },
  },
  {
    id: 'template',
    plugin: 'dotnet-template-engine',
    files: { 'templates/web/.template.config/template.json': '{"identity":"web"}' },
  },
  {
    id: 'diag',
    plugin: 'dotnet-diag',
    files: { 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />', 'crash.dmp': '' },
  },
  {
    id: 'diag',
    plugin: 'dotnet-diag',
    label: 'through a symbolicated stack',
    files: {
      'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'crash.log': 'Unhandled exception. System.NullReferenceException\n   at Sample.Program.Main(String[] args) in C:\\app\\Program.cs:line 12\n',
    },
  },
];

test('the table covers every row it claims to implement', () => {
  const covered = new Set(ROWS.map((row) => row.id));
  const missing = SIGNAL_TABLE.map((row) => row.id).filter((id) => !covered.has(id));
  assert.deepEqual(missing, [], 'a §9.2 row without a fixture is a row nobody would notice breaking');

  // A row with no plugin has to be deliberate, and exactly one is: the .NET-repo row (§9.3 rule one).
  assert.deepEqual(
    SIGNAL_TABLE.filter((row) => row.plugin === null).map((row) => row.id),
    ['dotnet-repo'],
  );
  assert.equal(new Set(SIGNAL_TABLE.map((row) => row.id)).size, SIGNAL_TABLE.length, 'row ids are unique');
});

test('every §9.2 row enables its plugin, and only that plugin', () => {
  for (const row of ROWS) {
    const workspace = makeProject(row.files);
    try {
      const result = detector()({ cwd: workspace.root });
      const label = row.label === undefined ? row.id : `${row.id} (${row.label})`;
      // Row one's whole point is that it enables nothing: `.csproj` proves .NET, and .NET is already in.
      assert.deepEqual(result.plugins, row.plugin === null ? [] : [row.plugin], `${label} must enable ${row.plugin ?? 'nothing'}`);
      assert.ok(result.evidence[row.id] !== undefined, `${label} must report evidence under its own row id`);
      assert.deepEqual(result.evidence[row.id].paths.length > 0, true, `${label} must name the file it matched`);
    } finally {
      workspace.dispose();
    }
  }
});

test('the shipped range is reachable by signals, with the two documented exceptions', () => {
  const shipped = (manifest.includedPlugins ?? []).map((plugin) => plugin.name);
  const shippedSkills = new Set((manifest.includedPlugins ?? []).flatMap((plugin) => plugin.skills ?? []));
  const reachable = new Set(SIGNAL_TABLE.map((row) => row.plugin).filter((plugin) => plugin !== null));

  // A signal that names a plugin this release does not ship would enable nothing.
  for (const plugin of reachable) assert.ok(shipped.includes(plugin), `${plugin} is not in the shipped range`);

  // `dotnet` is always in (rule one) and `dotnet-nuget` has no signal on purpose: its only skill
  // converts a project *to* central package management, and `Directory.Packages.props` is evidence
  // against that change rather than for it. If the range grows, this assertion is the alarm.
  assert.deepEqual(
    shipped.filter((plugin) => plugin !== ALWAYS_ON_PLUGIN && !reachable.has(plugin)),
    ['dotnet-nuget'],
  );
  assert.equal(shippedSkills.size > 0, true, 'the manifest must still declare skills');
});

test('a repository that is merely .NET enables nothing, and detection never claims dotnet', () => {
  const workspace = makeProject({
    'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    'app.sln': '',
    'Directory.Packages.props': '<Project />',
    'global.json': '{}',
    'NuGet.config': '<configuration />',
  });
  try {
    const detect = detector();
    const result = detect({ cwd: workspace.root });
    assert.deepEqual(result.plugins, [], 'row one is evidence for .NET, which is already always selected');
    assert.ok(result.evidence['dotnet-repo'] !== undefined, 'the evidence is still recorded');

    // ...and the fold still lists the core set: `dotnet` comes from `core-set`, not from detection.
    const folded = service({ detect }).fold({ cwd: workspace.root });
    for (const skill of coreSkills) assert.ok(folded.names.includes(skill), `${skill} comes from the core set`);
  } finally {
    workspace.dispose();
  }
});

test('signals with no plugin behind them add nothing', () => {
  const workspace = makeProject({
    'winforms.csproj':
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><UseWindowsForms>true</UseWindowsForms><TargetFramework>net11.0</TargetFramework><System.Windows.Forms /></PropertyGroup></Project>',
    'Components/Counter.razor': '@code { }',
    'scripts/legacy.fsx': 'printfn "hello"',
    'fsharp/Thing.fsproj': '<Project Sdk="Microsoft.NET.Sdk" />',
  });
  try {
    const result = detector()({ cwd: workspace.root });
    assert.deepEqual(result.plugins, [], 'rule two: no plugin means no signal, not a nearby plugin');
  } finally {
    workspace.dispose();
  }
});

test('detection is bounded by probe.maxFiles and probe.maxDepth', () => {
  const capped = makeProject({
    'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    'msbuild.binlog': '',
    'a.txt': '',
    'b.txt': '',
    'c.txt': '',
  });
  try {
    const detect = detector({ probe: { enabled: true, maxFiles: 3, maxDepth: 8 } });
    const result = detect({ cwd: capped.root });
    assert.equal(result.scanned.truncated, 'entries');
    assert.ok(result.scanned.files + result.scanned.dirs <= 3, 'the cap is a cap');
  } finally {
    capped.dispose();
  }

  const deep = makeProject({ 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />', 'src/gen/native/msbuild.binlog': '' });
  try {
    assert.deepEqual(detector({ probe: { enabled: true, maxDepth: 2 } })({ cwd: deep.root }).plugins, []);
    assert.deepEqual(detector({ probe: { enabled: true, maxDepth: 6 } })({ cwd: deep.root }).plugins, ['dotnet-msbuild']);
  } finally {
    deep.dispose();
  }
});

test('a scan inside one mtime bucket is memoized, and a new bucket rescans', () => {
  const workspace = makeProject({ 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />' });
  try {
    const detect = detector();
    const first = detect({ cwd: workspace.root });
    assert.deepEqual(first.plugins, []);

    // A new file whose mtime is pinned back into the same bucket cannot move the memo key, so the
    // answer is the memoized one rather than a rescan — this is what "no rescan per catalog read" means.
    writeFileSync(join(workspace.root, 'msbuild.binlog'), '');
    stampTree(workspace.root, EPOCH);
    assert.equal(detect({ cwd: workspace.root }), first, 'the same bucket returns the same result object');

    // Moving the tree into a later bucket is the only thing that forces a re-read.
    stampTree(workspace.root, EPOCH + 4000);
    assert.deepEqual(detect({ cwd: workspace.root }).plugins, ['dotnet-msbuild']);

    // `bucketMs: 0` is the debugging switch: every call rescans.
    const fresh = detector({}, { bucketMs: 0 });
    assert.notEqual(fresh({ cwd: workspace.root }), fresh({ cwd: workspace.root }));
  } finally {
    workspace.dispose();
  }
});

test('a workspace never loses a plugin it once matched', () => {
  const workspace = makeProject({ 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />', 'msbuild.binlog': '' });
  try {
    const detect = detector();
    const folded = service({ detect });
    const before = folded.fold({ cwd: workspace.root });
    assert.ok(
      skillsOf('dotnet-msbuild').some((skill) => before.names.includes(skill)),
      'the msbuild plugin is selected on the first read',
    );

    rmSync(join(workspace.root, 'msbuild.binlog'));
    stampTree(workspace.root, EPOCH + 4000);

    const second = detect({ cwd: workspace.root });
    assert.deepEqual(second.plugins, ['dotnet-msbuild'], 'grow-only: the plugin survives the binlog being deleted');
    assert.deepEqual(second.retained, ['dotnet-msbuild'], '...and it says that it is being retained');

    const after = folded.fold({ cwd: workspace.root });
    for (const name of before.names) assert.ok(after.names.includes(name), `${name} must not disappear`);
  } finally {
    workspace.dispose();
  }
});

test('the same workspace answers the same way twice', () => {
  const files = {
    'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    'tests/Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PackageReference Include="NUnit" /></Project>',
    'msbuild.binlog': '',
  };
  const first = makeProject(files);
  const second = makeProject(files);
  try {
    // Two independent detectors, so nothing but the filesystem can explain an agreement.
    assert.deepEqual(portable(detector()({ cwd: first.root })), portable(detector()({ cwd: second.root })));
    const detect = detector();
    assert.deepEqual(detect({ cwd: first.root }), detect({ cwd: first.root }));
  } finally {
    first.dispose();
    second.dispose();
  }
});

test('probe.enabled: false scans nothing and leaves the core set alone', () => {
  const workspace = makeProject({ 'tests/Tests.csproj': '<PackageReference Include="Microsoft.NET.Test.Sdk" />' });
  try {
    const detect = detector({ probe: { enabled: false } });
    const result = detect({ cwd: workspace.root });
    assert.deepEqual(result.plugins, []);
    assert.deepEqual(result.scanned.files, 0, 'disabled means no read, not a discarded read');
    assert.equal(result.scanned.reason, 'disabled');

    const folded = service({ detect, config: { probe: { enabled: false } } }).fold({ cwd: workspace.root });
    assert.deepEqual(folded.names, [...coreSkills].sort(), 'the core set is the whole selection');
  } finally {
    workspace.dispose();
  }
});

test('a missing or unreadable workspace is "no signal", never an exception', () => {
  const detect = detector();
  assert.equal(detect({}).scanned.reason, 'no-cwd');
  assert.equal(detect({ cwd: '' }).scanned.reason, 'no-cwd');
  const missing = detect({ cwd: join(tmpdir(), 'dotnet-skills-no-such-workspace') });
  assert.deepEqual(missing.plugins, []);
  assert.equal(missing.scanned.reason, 'unreadable');
});

test('a detector that throws is the same as no signal', () => {
  const lines = [];
  const service_ = createSelectionService({
    config: { probe: { enabled: true }, disabledSelectors: [], enabledPlugins: [], enabledSkills: [], disabledSkills: [] },
    manifest,
    detect: () => {
      throw new Error('boom');
    },
    log: (line) => lines.push(line),
  });
  const folded = service_.fold({ cwd: 'anywhere' });
  assert.deepEqual(folded.names, [...coreSkills].sort());
  assert.equal(lines.filter((line) => line.includes('boom')).length, 1, 'the failure is logged, not swallowed');
});

test('generated output is not read: a project file under obj/ cannot enable a plugin', () => {
  const workspace = makeProject({
    'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    // The realistic shape of the mistake this guards: a generated project or asset file listing every
    // transitive package would otherwise enable half the range for any repository with a test project.
    'obj/Debug/net10.0/Generated.csproj':
      '<Project Sdk="Microsoft.NET.Sdk"><PackageReference Include="Microsoft.EntityFrameworkCore" /><PackageReference Include="Microsoft.NET.Test.Sdk" /></Project>',
    'obj/project.assets.json': '{"Microsoft.EntityFrameworkCore": "1.0.0"}',
    'bin/Debug/net10.0/app.deps.json': '{"Microsoft.SemanticKernel": "1.0.0"}',
  });
  try {
    assert.deepEqual(detector()({ cwd: workspace.root }).plugins, []);
  } finally {
    workspace.dispose();
  }
});

test('a nested repository is another project, and its build files are not evidence', () => {
  // The measured shape of this mistake: a workspace that pins a .NET repository as a submodule —
  // vendored source, its test fixtures, its sample crash logs — is still not a .NET project.
  const workspace = makeProject({
    'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    'tests/Tests.csproj': '<PackageReference Include="xunit" />',
    'vendor/upstream/.git': 'gitdir: ../../.git/modules/upstream\n',
    'vendor/upstream/eng/Tool/Tool.csproj': '<PackageReference Include="Microsoft.NET.Test.Sdk" />',
    'vendor/upstream/eng/Directory.Build.props': '<Project />',
    'vendor/upstream/tests/diag/tombstone_coreclr.txt': 'backtrace:\n   at Sample.Program.Main(String[] args)\n',
  });
  try {
    const result = detector()({ cwd: workspace.root });
    assert.deepEqual(result.plugins, ['dotnet-test'], 'only the workspace\u2019s own test project counts');
    for (const row of Object.values(result.evidence)) {
      for (const path of row.paths) {
        assert.equal(path.startsWith('vendor/upstream/'), false, `${path} belongs to another repository`);
      }
    }
  } finally {
    workspace.dispose();
  }
});

test('a workspace that is itself a repository is scanned, git directory and all', () => {
  // The exemption matters as much as the rule: every ordinary session is opened in a repository.
  const workspace = makeProject({ '.git/HEAD': 'ref: refs/heads/main\n', 'msbuild.binlog': '' });
  try {
    assert.deepEqual(detector()({ cwd: workspace.root }).plugins, ['dotnet-msbuild']);
  } finally {
    workspace.dispose();
  }
});
