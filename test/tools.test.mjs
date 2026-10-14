/**
 * Status and tool suite — doc/dev-plan.md W6.
 *
 * The status tool is the only window onto why the catalog looks the way it does, so the assertion
 * that matters is completeness: every one of §11.4's ten items must be present in the report, or
 * an operator cannot tell "nothing to report" from "we never looked".
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { loadDescriptions } from '../lib/descriptions.js';
import { createJournal, createProvider } from '../lib/provider.js';
import { createSelectionService } from '../lib/selection.js';
import { createSnapshotSource } from '../lib/source-snapshot.js';
import { descriptionsPath, readUpstreamManifest } from '../lib/snapshot.js';
import { buildStatusReport, DIAGNOSTIC_KEYS, renderStatusReport } from '../lib/status.js';
import {
  createRefreshTool,
  createStatusTool,
  missingDiagnosticKeys,
  REFRESH_TOOL_NAME,
  STATUS_TOOL_NAME,
  undiscoverableTools,
} from '../lib/tools.js';

/** `@deepseek-ai/dsh-tools` from the dsh installation, for its own schema validator. */
const hostTools = await (async () => {
  /** @type {string[]} */
  const anchors = [];
  if (typeof process.env.DSH_INSTALL_ROOT === 'string' && process.env.DSH_INSTALL_ROOT !== '') {
    const root = process.env.DSH_INSTALL_ROOT.replace(/[\\/]+$/, '');
    anchors.push(`${root}/dsh-tools/lib/index.js`, `${root}/dsh-tools/package.json`, root);
  }
  anchors.push(
    'C:/Users/david/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  );
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor);
      return await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
    } catch {
      // try the next anchor
    }
  }
  return undefined;
})();

const manifest = readUpstreamManifest().manifest;

/** A live-ish composition: real snapshot, real selection, real provider, no host. */
function composition(config = {}) {
  const resolved = {
    rank: 700,
    descriptionMode: 'authored',
    catalogSummaryBudget: 320,
    catalogDescriptionMaxLength: 500,
    catalogTokenBudget: 0,
    enabledPlugins: [],
    enabledSkills: [],
    disabledSkills: [],
    pinnedSkills: [],
    ...config,
  };
  const source = createSnapshotSource({ plugins: (manifest.includedPlugins ?? []).map((plugin) => plugin.name) });
  const selection = createSelectionService({ config: resolved, manifest, pluginSkills: source.pluginSkills() });
  const descriptions = loadDescriptions({ path: descriptionsPath, manifest, budget: resolved.catalogSummaryBudget });
  const journal = createJournal();
  const provider = createProvider({ source, selection, descriptions, config: resolved, journal });
  return { config: resolved, source, selection, descriptions, journal, provider };
}

function report(config = {}, overrides = {}) {
  const parts = composition(config);
  return buildStatusReport({
    manifest,
    config: parts.config,
    source: parts.source,
    provider: parts.provider,
    journal: parts.journal,
    descriptions: parts.descriptions,
    selection: parts.selection,
    otherProviders: ['file system skill provider (rank 300)'],
    now: Date.parse(manifest.fetchedAt),
    pwshVersion: 'PowerShell 7.6.6',
    ...overrides,
  });
}

test('the report carries all ten diagnostic items of §11.4', async () => {
  const structured = await report();
  assert.deepEqual(missingDiagnosticKeys(structured), []);
  assert.equal(DIAGNOSTIC_KEYS.length, 10);
});

test('item 1: selected skills and the reason each one was selected', async () => {
  const structured = await report();
  assert.deepEqual(structured.selection.plugins, ['dotnet']);
  assert.deepEqual(
    structured.selection.skills.map((skill) => skill.name),
    ['csharp-scripts', 'dotnet-pinvoke', 'nuget-trusted-publishing'],
  );
  for (const skill of structured.selection.skills) assert.equal(skill.reason, 'core-set');
  assert.deepEqual(structured.selection.selectors, ['core-set', 'config-baseline', 'project-detection', 'budget']);
});

test('item 2: catalog characters and estimated tokens', async () => {
  const structured = await report();
  assert.equal(structured.catalog.entries, 3);
  assert.equal(structured.catalog.complete, true);
  // The exact length of the catalog the host publishes: 865 characters of *served* description
  // (two authored texts plus the pass-through one) and the `- \`name\`: ` shell of each entry.
  // Reading served text rather than upstream text is the difference between 902 and 1,237.
  assert.equal(structured.catalog.chars, 902);
  assert.equal(structured.catalog.estTokens, 16);
});

test('item 3: snapshot provenance, including age and integrity', async () => {
  const structured = await report();
  assert.equal(structured.provenance.tag, 'v1.0.0');
  assert.equal(structured.provenance.commit, 'cb7c10bd32b250459632df9e6fa1350cdaf00b18');
  assert.equal(structured.provenance.ageDays, 0, 'the injected clock is the fetch time');
  assert.equal(structured.provenance.integrity, 'ok');
  assert.equal(structured.provenance.lineEndings, 'lf');
  assert.equal(structured.provenance.declaredSkillCount, manifest.skillCount);
  // The range note exists exactly when something is outside the range: a full-range sync reports none,
  // and a narrowed one names every plugin it left out rather than leaving the reader to guess.
  const outOfRange = manifest.outOfRangePlugins ?? [];
  assert.equal(structured.provenance.rangeNotes.length, outOfRange.length === 0 ? 0 : 1);
  if (outOfRange.length > 0) {
    assert.match(structured.provenance.rangeNotes[0], new RegExp(String(outOfRange.length)));
  }
});

test('item 4: the effective downstream limit and how many entries it truncated', async () => {
  const structured = await report();
  assert.equal(structured.limits.catalogDescriptionMaxLength, 500);
  assert.equal(structured.limits.catalogSummaryBudget, 320);
  assert.equal(structured.limits.cappedEntries, 0);

  // A 60-character ceiling truncates all three: the two authored entries are ~300 characters and
  // the pass-through one is 214.
  const squeezed = await report({ catalogDescriptionMaxLength: 60 });
  assert.equal(squeezed.limits.cappedEntries, 3);
});

test('item 5: shadowing states the rank ordering it can actually know', async () => {
  const structured = await report();
  // What this provider ships is the manifest's range, whatever it currently is (P1 grows it).
  const shipped = (manifest.includedPlugins ?? []).flatMap((plugin) => plugin.skills ?? []);
  assert.equal(structured.shadowing.shipped, shipped.length);
  // The host cannot list shadowed definitions, so the report must say so *and* still give the reader
  // the one fact that is knowable: which ranks win.
  assert.match(structured.shadowing.note, /no API for listing shadowed definitions/);
  assert.match(structured.shadowing.note, /registered at rank 700/);
  // §14's collision-prone names are generic enough to exist in other skill collections. Which of them
  // ship depends on the range, so the expectation is "exactly the shipped ones", not a count.
  const generic = ['run-tests', 'filter-syntax', 'platform-detection', 'coverage-analysis', 'crap-score'];
  const shippedNames = new Set(shipped);
  assert.deepEqual(
    structured.shadowing.collisionProne.map((entry) => entry.name).sort(),
    generic.filter((name) => shippedNames.has(name)).sort(),
  );

  const ranks = structured.providerRanks.map((entry) => entry.rank);
  assert.deepEqual(ranks, [100, 200, 300, 400, 500, 600, 700]);
  assert.match(
    structured.providerRanks.at(-1).provider,
    /this provider/,
    'our own row is identifiable so the ordering can be read against it',
  );

  const custom = await report({ rank: 250 });
  assert.equal(custom.providerRanks.at(-1).rank, 250, 'a configured rank is reported as configured');
  assert.match(custom.shadowing.note, /registered at rank 250/);
});

test('item 4 states where the description limit comes from', async () => {
  const structured = await report();
  assert.match(
    structured.limits.catalogDescriptionMaxLengthSource,
    /host skill tool/,
    'the number mirrors another plugin\u2019s setting and must not look authoritative',
  );
});

test('item 6: deployment mode and degradation reason', async () => {
  const structured = await report();
  assert.equal(structured.deployment.mode, 'none', 'P0 does not deploy; the provider reads the snapshot directly');
  assert.equal(structured.deployment.root, null);
  assert.equal(structured.deployment.degradedReason, null);
});

test('item 6: a real deployment is reported, including what dangles', async () => {
  const deployed = {
    mode: 'copy',
    root: 'C:/Users/example/.dsh/skills',
    entries: 3,
    dangling: ['run-tests'],
    complete: false,
    degradedReason: 'EPERM - Windows refused the link',
  };
  const structured = await report({}, { deployment: deployed });
  assert.equal(structured.deployment.entries, 3);
  assert.deepEqual(structured.deployment.dangling, ['run-tests']);
  assert.equal(structured.deployment.complete, false);

  const lines = renderStatusReport(structured);
  assert.match(lines, /Mode: copy/);
  assert.match(lines, /Root: C:\/Users\/example\/\.dsh\/skills/);
  assert.match(lines, /Skills deployed: 3 \(incomplete\)/);
  assert.match(lines, /Dangling: run-tests/);
  assert.match(lines, /Degraded because: EPERM/);
  // The two entry points compete by rank, and a user who deployed into the host's own user skill root
  // has replaced these authored descriptions with the filesystem provider's verbatim ones. That is a
  // consequence of a choice, so it is stated where the choice is visible.
  assert.match(lines, /rank 400/);

  const empty = await report(
    {},
    {
      deployment: {
        mode: 'none',
        root: 'C:/Users/example/.dsh/skills',
        entries: 0,
        dangling: [],
        complete: true,
        reason: 'nothing is deployed at C:/Users/example/.dsh/skills',
      },
    },
  );
  const emptyLines = renderStatusReport(empty);
  assert.match(emptyLines, /Mode: none/);
  assert.match(emptyLines, /nothing is deployed/);
  assert.equal(emptyLines.includes('rank 400'), false, 'nothing to warn about when nothing is deployed');
});

test('item 7: pointers, including the ones authoring may drop', async () => {
  const structured = await report();
  // The census covers the *selected* skills only, and the default core set is the dotnet plugin's
  // three, none of which points anywhere.
  assert.equal(structured.pointers.inRangeTargets, 0);
  assert.deepEqual(structured.pointers.dangling, []);
  // Dropped pointers are reported rather than merely gone. Authoring may only drop a pointer to a name
  // that cannot be loaded at all — a scope-excluded plugin or one outside the shipped range.
  const unloadable = new Set([
    ...(manifest.excludedPlugins ?? []).flatMap((plugin) => plugin.skills ?? []),
    ...(manifest.outOfRangePlugins ?? []).flatMap((plugin) => plugin.skills ?? []),
  ]);
  for (const dropped of structured.pointers.droppedByAuthoring) {
    // The report names the drop as `source → target`, so the target is what has to be unloadable.
    const target = dropped.includes('→') ? dropped.split('→').pop().trim() : dropped;
    assert.ok(unloadable.has(target), `${target} is loadable, so authoring had no right to drop it`);
  }
});

test('item 8: PowerShell dependency is reported, not assumed', async () => {
  const structured = await report();
  assert.equal(structured.powerShell.available, true);
  assert.equal(structured.powerShell.version, 'PowerShell 7.6.6');
  assert.deepEqual(structured.powerShell.dependentSkills, [], 'no selected skill ships scripts/');

  const unknown = await report({}, { pwshVersion: undefined });
  assert.equal(unknown.powerShell.available, false);
  assert.equal(unknown.powerShell.version, null);
});

test('item 9: skipped skills are listed from the provider journal', async () => {
  const parts = composition();
  await parts.provider.list({ cwd: '/w' });
  const structured = await report({}, { provider: parts.provider, journal: parts.journal });
  assert.deepEqual(structured.skippedSkills, []);

  parts.journal.notes.push('dotnet/broken: literal block scalars are not supported; skipped');
  const withSkip = await report({}, { provider: parts.provider, journal: parts.journal });
  assert.equal(withSkip.skippedSkills.length, 1);
  assert.match(withSkip.skippedSkills[0], /broken/);
});

test('item 10: authoring coverage and diagnostics', async () => {
  const structured = await report();
  // Read the authored data directly: the report must count the entries that exist, and a range change
  // (or a new batch of authored text) must not require editing this number.
  const authored = Object.keys(JSON.parse(readFileSync(descriptionsPath, 'utf8')).entries).length;
  assert.equal(structured.authoring.entries, authored);
  assert.ok(authored > 0, 'the shipped range is authored, not merely declared');
  assert.deepEqual(structured.authoring.diagnostics, []);
  assert.deepEqual(structured.authoring.upstream, { tag: manifest.tag, commit: manifest.commit });
  assert.deepEqual(structured.authoring.gaps, []);
});

test('the markdown rendering names every section', async () => {
  const markdown = renderStatusReport(await report());
  for (const heading of [
    '## 1. Selected skills',
    '## 2. Catalog cost',
    '## 3. Snapshot provenance',
    '## 4. Effective limits',
    '## 5. Shadowing',
    '## 6. Deployment',
    '## 7. Pointers',
    '## 8. PowerShell dependency',
    '## 9. Skipped skills',
    '## 10. Authoring coverage',
  ]) {
    assert.ok(markdown.includes(heading), `missing ${heading}`);
  }
  assert.match(markdown, /\| `csharp-scripts` \| dotnet \| core-set \|/);
});

test('the status tool renders markdown by default and JSON on request', async () => {
  const tool = createStatusTool({ report });
  assert.equal(tool.name, STATUS_TOOL_NAME);
  assert.equal(tool.deferLoading, true);
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(typeof tool.execute, 'function');

  const markdown = await tool.execute({}, {});
  assert.equal(markdown.format, 'markdown');
  assert.match(markdown.markdown, /# .NET Agent Skills status/);
  assert.deepEqual(missingDiagnosticKeys(markdown.report), []);

  const json = await tool.execute({ format: 'json' }, {});
  assert.equal(json.format, 'json');
  assert.equal(json.report.catalog.entries, 3);

  const blocks = tool.output.render({}, markdown);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /# .NET Agent Skills status/);
});

test('the refresh tool reports whether anything was invalidated', async () => {
  let calls = 0;
  const tool = createRefreshTool({
    invalidate: () => {
      calls += 1;
      return true;
    },
  });
  assert.equal(tool.name, REFRESH_TOOL_NAME);
  assert.deepEqual(tool.parameters, { type: 'object', additionalProperties: false, properties: {} });

  const first = await tool.execute({}, {});
  assert.equal(first.invalidated, true);
  assert.equal(calls, 1);
  assert.match(tool.output.render({}, first)[0].text, /invalidated/i);

  const detached = createRefreshTool({ invalidate: () => false });
  const second = await detached.execute({}, {});
  assert.equal(second.invalidated, false);
  assert.match(second.note, /nothing to invalidate/);
});

test('the deferred status tool is discoverable from a declared tool description', () => {
  // §13 mandates `deferLoading: true` on the status tool, and the field test measured what that
  // costs in a real host: the tool is absent from the model's declaration set and a baseline
  // deferred tool is never announced, so the name has to appear in text the model does read.
  // Keeping the flag is the design; keeping it *without* a pointer to the name is the defect.
  const definitions = [createStatusTool({ report }), createRefreshTool({ invalidate: () => true })];
  assert.equal(definitions[0].deferLoading, true, 'spec §13 asks for the deferred schema');
  assert.equal(definitions[1].deferLoading, undefined, 'the discoverable tool is the one that is declared');
  assert.deepEqual(undiscoverableTools(definitions), [], 'a deferred tool nothing names is unreachable');

  // The pointer is built from the constant, so a rename cannot leave the text pointing at a ghost.
  assert.ok(definitions[1].description.includes(STATUS_TOOL_NAME));
  assert.equal(STATUS_TOOL_NAME, 'dotnet_skills_status', 'the published name is the registered name');
  // ...and naming the status tool must not swallow the refresh tool's own job.
  assert.match(definitions[1].description, /Invalidate the skill catalog/);
});

test('undiscoverableTools catches a deferred tool nothing points at', () => {
  const discoverable = [
    { name: 'a_status', description: 'report things', deferLoading: true },
    { name: 'b_refresh', description: 'invalidate; see a_status for the report' },
  ];
  assert.deepEqual(undiscoverableTools(discoverable), []);

  const orphan = [
    { name: 'a_status', description: 'report things', deferLoading: true },
    { name: 'b_refresh', description: 'invalidate the catalog' },
  ];
  assert.deepEqual(undiscoverableTools(orphan), ['a_status']);

  // A declaration-less tool cannot point at anything either, so it is reported rather than ignored.
  assert.deepEqual(undiscoverableTools([{ name: 'a_status', deferLoading: true }]), ['a_status']);
  // Nothing deferred means nothing to report — this is not a rule about how tools are declared.
  assert.deepEqual(undiscoverableTools([{ name: 'plain', description: 'x' }]), []);
});

test('item 1 says whether project detection is wired', async () => {
  // §9's detection is not built yet, and this provider is constructed without a `detect` callback.
  const unwired = await report();
  assert.deepEqual(unwired.selection.projectDetection, { wired: false, enabled: true });
  assert.match(
    renderStatusReport(unwired),
    /Project detection: not implemented in this version - probe\.\* has no effect yet/,
  );

  // A wired provider is described by its own state, and the "not implemented" text must be gone:
  // reporting a gap that no longer exists is the same class of lie as hiding one that does.
  const parts = composition();
  const wired = createSelectionService({
    config: parts.config,
    manifest,
    pluginSkills: parts.source.pluginSkills(),
    detect: () => ({ plugins: [] }),
  });

  const enabled = await report({}, { selection: wired });
  assert.deepEqual(enabled.selection.projectDetection, { wired: true, enabled: true });
  assert.match(renderStatusReport(enabled), /Project detection: enabled\./);
  assert.equal(renderStatusReport(enabled).includes('not implemented'), false);

  const off = await report({ probe: { enabled: false } }, { selection: wired });
  assert.deepEqual(off.selection.projectDetection, { wired: true, enabled: false });
  assert.match(renderStatusReport(off), /Project detection: disabled by probe\.enabled\./);
});

test('item 1 reports the last detection, with the numbers that separate the look-alike states', async () => {
  // Each of these ends with the same core set in the catalog, so the report is the only place the
  // difference between them can live: nothing named, nothing readable, scanned-and-not-matching.
  const detection = {
    cwd: 'C:/src/sample',
    plugins: ['dotnet-msbuild', 'dotnet-test'],
    evidence: { 'dotnet-repo': { plugin: null, paths: ['app.csproj'] }, 'test-sdk': { plugin: 'dotnet-test', paths: ['tests/Tests.csproj'] } },
    scanned: { cwd: 'C:/src/sample', files: 412, dirs: 63, bytes: 4096, depth: 4, truncated: false },
    retained: [],
  };
  const withDetection = (overrides = {}) => ({ ...createJournal(), detection: { ...detection, ...overrides } });

  // `wired` is the state of the shipped plugin: only a selection with a `detect` callback can be
  // described by the last-detection line at all, which is the branch ordering this test pins down.
  const wired = (config = {}) => {
    const parts = composition(config);
    return createSelectionService({
      config: parts.config,
      manifest,
      pluginSkills: parts.source.pluginSkills(),
      detect: () => ({ plugins: [] }),
    });
  };

  const scanned = await report({}, { selection: wired(), journal: withDetection() });
  assert.deepEqual(scanned.selection.projectDetection.last, detection);
  const line = renderStatusReport(scanned);
  assert.match(line, /Last detection \(C:\/src\/sample\): dotnet-msbuild\+dotnet-test/);
  assert.match(line, /scanned 412 files \/ 63 dirs/);
  assert.match(line, /\[signals: dotnet-repo, test-sdk\]/);

  const clipped = await report(
    {},
    {
      selection: wired(),
      journal: withDetection({ retained: ['dotnet-maui'], scanned: { ...detection.scanned, truncated: 'entries' } }),
    },
  );
  assert.match(renderStatusReport(clipped), /truncated at probe\.maxFiles/);
  assert.match(renderStatusReport(clipped), /retained from an earlier read: dotnet-maui/);

  const nowhere = await report(
    {},
    { selection: wired(), journal: { ...createJournal(), detection: { ...detection, plugins: [], evidence: {} } } },
  );
  assert.match(renderStatusReport(nowhere), /no signal matched/);

  // A disabled switch hides the record: reporting a scan the configuration refuses to run would be
  // the same class of lie as hiding one that did run.
  const disabled = await report(
    { probe: { enabled: false } },
    { selection: wired({ probe: { enabled: false } }), journal: withDetection() },
  );
  assert.deepEqual(disabled.selection.projectDetection, { wired: true, enabled: false });
  assert.equal(renderStatusReport(disabled).includes('Last detection'), false);
});

test('the status tool reports the workspace it was asked about', async () => {
  /** @type {Array<string | undefined>} */
  const asked = [];
  const tool = createStatusTool({
    report: async (cwd) => {
      asked.push(cwd);
      return report({}, { cwd });
    },
  });

  await tool.execute({}, {});
  assert.equal(asked[0], undefined, 'no argument and no session workspace means no workspace');

  await tool.execute({}, { agent: { session: { header: { cwd: 'C:/src/session' } } } });
  assert.equal(asked[1], 'C:/src/session', 'the calling session workspace is the default');

  await tool.execute({ cwd: 'C:/src/explicit' }, { agent: { session: { header: { cwd: 'C:/src/session' } } } });
  assert.equal(asked[2], 'C:/src/explicit', 'an explicit workspace wins over the session one');

  // An empty string is "not given", not a workspace called "": the detector would otherwise have to
  // guess, and `describeProjectDetection` would report a scan of nowhere.
  await tool.execute({ cwd: '' }, {});
  assert.equal(asked[3], undefined);

  assert.deepEqual(tool.parameters.properties.cwd.type, 'string');
});

test('both tool schemas are inside the JSON Schema subset the host supports', () => {
  for (const tool of [createStatusTool({ report }), createRefreshTool({ invalidate: () => true })]) {
    const schema = tool.output.schema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.ok(Array.isArray(schema.required));
    for (const property of Object.values(schema.properties)) {
      assert.ok(['string', 'boolean', 'object'].includes(property.type), String(property.type));
      // The host supports `required` only as an array on an object node. A per-property
      // `required: true` is refused at registration, and that aborts the whole plugin's
      // activation — this assertion is the regression guard for exactly that failure.
      assert.equal(Object.hasOwn(property, 'required'), false, 'use the object-level required array');
    }
    assert.equal(tool.name === 'run_code', false, 'run_code is reserved for PTC mode');
  }
});

test(
  'the host itself accepts both tool schemas',
  { skip: hostTools === undefined ? 'the dsh installation is not resolvable from here' : false },
  () => {
    for (const tool of [createStatusTool({ report }), createRefreshTool({ invalidate: () => true })]) {
      // The real validator from `@deepseek-ai/dsh-tools`, not a paraphrase of its rules.
      hostTools.assertSupportedJsonSchema(tool.output.schema);
      assert.equal(typeof tool.output.render, 'function');
      // `parameters` is not validated at registration, but it still has to be a usable schema.
      hostTools.assertSupportedJsonSchema(tool.parameters);
    }
  },
);
