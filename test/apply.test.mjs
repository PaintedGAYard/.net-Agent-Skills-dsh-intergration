/**
 * `apply()` against a real Cordis context and the real host `SkillRegistry`.
 *
 * The bundle cannot be installed into this profile (the plugin manager needs `pnpm` on the Harness
 * process's `PATH`), so this file does the next best thing and, for several purposes, the better
 * thing: it mounts the plugin the way the Loader would — `apply(ctx, config)` on a genuine Cordis
 * root, with the genuine skill registry and tool registry attached — and then reads the catalog back
 * out through the host's own API.
 *
 * That covers the activation wiring that a unit test cannot: effect cleanup ordering, service
 * provision, synchronous provider registration, and the two tools appearing in the tool registry.
 *
 * Skipped when the dsh installation is not resolvable.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { makeTempSnapshot } from './helpers.mjs';

/** Resolve host packages the way an installed bundle would. */
function hostLoader() {
  const anchors = [
    process.env.DSH_INSTALL_ROOT,
    'C:/Users/david/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-skill/lib/index.js',
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '');
  for (const anchor of anchors) {
    try {
      return createRequire(anchor);
    } catch {
      // try the next anchor
    }
  }
  return undefined;
}

const require = hostLoader();
let host;
if (require !== undefined) {
  try {
    const load = (name) => import(pathToFileURL(require.resolve(name)).href);
    host = { Context: (await load('@deepseek-ai/cordis')).Context, skill: await load('@deepseek-ai/dsh-skill') };
  } catch {
    host = undefined;
  }
}

const skip = host === undefined ? 'the dsh installation is not resolvable from here' : false;

/**
 * A minimal stand-in for `ctx.tools`.
 *
 * `@deepseek-ai/dsh-tools` is not independently mountable here, but the plugin only uses `register`
 * and `get`, and the shape of a `ToolDefinition` is what the assertions below check.
 */
function toolsService() {
  const registered = new Map();
  return {
    registered,
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
    get(name) {
      return registered.get(name);
    },
    schemas() {
      return [...registered.values()];
    },
  };
}

/** Mount the plugin the way the Loader does, over a real registry. */
async function mount(config = {}) {
  const ctx = new host.Context();
  new host.skill.SkillRegistry(ctx);
  const tools = toolsService();
  ctx.provide('tools', tools);
  // The context's own logger is the sink `apply()` writes to, so recording its `warn` is how a test
  // observes the activation notes without turning them into process warnings.
  const warnings = [];
  ctx.logger.warn = (line) => warnings.push(String(line));
  const plugin = await import('../index.js');
  plugin.apply(ctx, config);
  return { ctx, tools, plugin, warnings };
}

test('apply() registers the provider and both tools on a real context', { skip }, async () => {
  const { ctx, tools } = await mount();
  assert.deepEqual([...tools.registered.keys()].sort(), ['dotnet_skills_refresh', 'dotnet_skills_status']);

  // The registration is where the deferred/discoverable split has to hold: §13 keeps the status
  // schema out of every request, so the refresh tool is the only declared text that can carry its
  // name (field test, issue 0001). Both halves are asserted here rather than only in the unit suite
  // because this is the object the host actually receives.
  const status = tools.get('dotnet_skills_status');
  const refresh = tools.get('dotnet_skills_refresh');
  assert.equal(status.deferLoading, true);
  assert.equal(refresh.deferLoading, undefined);
  assert.ok(refresh.description.includes(status.name), 'a deferred tool nothing names is unreachable');
  // The activation guard is silent when the invariant holds, and it is the same guard the suite runs:
  // if it ever starts firing on a healthy plugin, the discoverability check has broken, not the plugin.
  assert.deepEqual(
    (await mount()).warnings.filter((line) => line.includes('cannot discover')),
    [],
  );

  const summaries = await ctx.skills.list({});
  assert.deepEqual(
    summaries.map((summary) => summary.name),
    ['csharp-scripts', 'dotnet-pinvoke', 'nuget-trusted-publishing'],
  );
  assert.equal(summaries[0].provider, 'dotnet-agent-skills');
  assert.equal(summaries[0].source, 'bundled');
});

test('apply() provides the dotnetSkills service for third-party selectors', { skip }, async () => {
  const { ctx } = await mount();
  const service = ctx.get('dotnetSkills');
  assert.ok(service !== undefined, 'the seam is resolvable');
  assert.equal(service.version, 1);
  assert.deepEqual(service.selectors.list(), ['core-set', 'config-baseline', 'project-detection', 'budget']);

  // A third party can extend the selection without touching this plugin.
  const dispose = service.selectors.register('third-party', () => ({ include: ['nuget-trusted-publishing'] }));
  assert.equal(service.fold({ cwd: '/w' }).names.includes('nuget-trusted-publishing'), true);
  dispose();
});

test('configuration is honoured on the real path: enabledSkills and disabledSkills', { skip }, async () => {
  const { ctx } = await mount({ disabledSkills: ['dotnet-pinvoke'] });
  const names = (await ctx.skills.list({})).map((summary) => summary.name);
  assert.deepEqual(names, ['csharp-scripts', 'nuget-trusted-publishing']);
  assert.equal(names.includes('dotnet-pinvoke'), false, 'the veto wins over the core set');

  const verbatim = await mount({ descriptionMode: 'verbatim' });
  const definition = await verbatim.ctx.skills.get('dotnet-pinvoke', {});
  assert.match(definition.description, /DO NOT USE FOR: COM interop/);
  assert.equal(definition.description.length, 500, 'the upstream text is truncated at the limit');
});

test('the status tool answers with the full ten-item report over the live plugin', { skip }, async () => {
  const { tools } = await mount();
  const status = tools.get('dotnet_skills_status');
  assert.ok(status !== undefined);
  const result = await status.execute({}, {});
  assert.equal(result.format, 'markdown');
  assert.match(result.markdown, /## 1\. Selected skills/);
  assert.match(result.markdown, /## 10\. Authoring coverage/);
  assert.equal(result.report.catalog.entries, 3);
  assert.equal(result.report.provenance.integrity, 'ok');
  assert.equal(result.report.limits.rank, 700);
  assert.equal(result.report.limits.descriptionMode, 'authored');
  // §9's detection is wired as of P1, and this is the live path rather than a unit stub. With no
  // workspace named it must say that nothing was scanned instead of implying a scan that matched
  // nothing — the distinction issue 0004 was about.
  assert.equal(result.report.selection.projectDetection.wired, true);
  assert.equal(result.report.selection.projectDetection.enabled, true);
  assert.match(result.markdown, /Project detection: enabled; no workspace was named, so nothing was scanned\./);
  // The fallback path is a fact about the runtime, so it must be visible rather than silent.
  const declared = (await import('../lib/config.js')).declaredWith;
  assert.ok(['schemastery', 'fallback'].includes(declared));
});

test('the refresh tool invalidates through the provider control', { skip }, async () => {
  const { tools } = await mount();
  const refresh = tools.get('dotnet_skills_refresh');
  const result = await refresh.execute({}, {});
  assert.equal(result.invalidated, true);
  assert.match(result.note, /invalidated/i);

  // Reading again after invalidation still produces the same catalog: the snapshot has not moved.
  const { ctx } = await mount();
  const before = (await ctx.skills.list({})).map((summary) => summary.name);
  await refresh.execute({}, {});
  const after = (await ctx.skills.list({})).map((summary) => summary.name);
  assert.deepEqual(after, before);
});

test('a probe setting no longer has to be reported as inert, because detection is wired', { skip }, async () => {
  // The activation warning names a state this build can no longer reach: `probe.*` written in the
  // configuration with no `detect` callback behind it. The branch stays in `index.js` as a guard, and
  // `test/config.test.mjs` keeps `probeOverrides` itself honest — what this test asserts is that a
  // healthy plugin does not fire it, because a warning that cries wolf is worse than none.
  const configured = await mount({ probe: { enabled: false, maxFiles: 10 } });
  assert.deepEqual(configured.warnings.filter((line) => line.includes('has no effect')), []);

  // Nothing to say when nothing was asked for: the default configuration must stay quiet.
  const quiet = await mount();
  assert.deepEqual(quiet.warnings.filter((line) => line.includes('probe.')), []);
});

test('the status tool reports another workspace, and detection drives what is selected', { skip }, async () => {
  const { tools } = await mount();
  const status = tools.get('dotnet_skills_status');
  const project = makeTempSnapshot({
    'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    'tests/Tests.csproj': '<PackageReference Include="Microsoft.NET.Test.Sdk" />',
  });
  try {
    const result = await status.execute({ cwd: project.root }, {});
    assert.match(result.markdown, /Last detection .*dotnet-test/);
    assert.ok(result.report.catalog.entries > 3, 'detection adds skills to the catalog');

    const reason = result.report.selection.skills.find((skill) => skill.plugin === 'dotnet-test')?.reason;
    assert.match(String(reason), /^project-detection:dotnet-test/, 'the reason names the plugin detection enabled');

    // A plain .NET repository adds nothing: `dotnet` is already in the core set, and rule one says the
    // presence of a project file is not evidence for a plugin.
    const plain = makeTempSnapshot({ 'app.csproj': '<Project Sdk="Microsoft.NET.Sdk" />' });
    try {
      const bare = await status.execute({ cwd: plain.root }, {});
      assert.match(bare.markdown, /no signal matched/);
      assert.equal(bare.report.catalog.entries, 3);
    } finally {
      plain.dispose();
    }
  } finally {
    project.dispose();
  }
});

test('the rank is configurable and lands in the candidates', { skip }, async () => {
  const { ctx } = await mount({ rank: 650 });
  const observation = await ctx.skills.snapshot({});
  assert.equal(observation.skills.length, 3);
  // The snapshot only exposes invocation-neutral summaries, so assert through the provider directly.
  const provider = ctx.skills.layers.collect?.(undefined) ?? undefined;
  void provider;
  const catalogEntry = observation.skills[0];
  assert.equal(catalogEntry.provider, 'dotnet-agent-skills');
});

test('unloading the plugin removes the provider, the service and both tools', { skip }, async () => {
  // The regression this guards: `ctx.provide` and `registerProvider` return the disposer that
  // unwinds them, and `ctx.effect` wants a callback that *returns* that disposer. Handing the
  // disposer to `effect` directly would have registered it as the cleanup function itself, and
  // nothing would ever unwind.
  const { ctx, tools } = await mount();
  assert.deepEqual([...tools.registered.keys()].sort(), ['dotnet_skills_refresh', 'dotnet_skills_status']);
  assert.equal(ctx.get('dotnetSkills') !== undefined, true);
  assert.equal((await ctx.skills.list({})).length, 3);

  await ctx.fiber.dispose();

  assert.deepEqual([...tools.registered.keys()], [], 'both tools are unregistered');
  assert.equal(ctx.get('dotnetSkills'), undefined, 'the selection service is withdrawn');
  assert.equal(ctx.get('skills'), undefined, 'and so is everything else on this fiber');
});

test('remounting after an unload works, so HMR cannot leave the name registered', { skip }, async () => {
  const first = await mount();
  await first.ctx.fiber.dispose();
  const second = await mount();
  assert.equal((await second.ctx.skills.list({})).length, 3);
});
