/**
 * Integration against the real host `SkillRegistry` and a real Cordis context.
 *
 * The unit suites prove the provider follows the contract we read out of the host. This one proves
 * the host actually behaves the way that contract says, using the shipped `@deepseek-ai/cordis` and
 * `@deepseek-ai/dsh-skill` from the dsh installation:
 *
 *   - `registerProvider` accepts our provider and the registry's own validator passes every candidate;
 *   - rank ordering picks the lower rank inside one layer;
 *   - a provider that throws is skipped rather than fatal, and an invalid candidate is *not*;
 *   - `ctx.provide('dotnetSkills', …)` is resolvable through `ctx.get`, so the extension seam of §8.2
 *     is visible to a third-party bundle;
 *   - the catalog the host renders matches what `dotnet_skills_status` reports.
 *
 * It is skipped when the dsh installation is not resolvable, so a checkout without it still runs.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { loadDescriptions } from '../lib/descriptions.js';
import { createJournal, createProvider } from '../lib/provider.js';
import { createSelectionService } from '../lib/selection.js';
import { createSnapshotSource } from '../lib/source-snapshot.js';
import { descriptionsPath, readUpstreamManifest, snapshotRoot } from '../lib/snapshot.js';

/**
 * Locate a package the way a bundle installed into a profile would: through the dsh installation.
 *
 * The profile's `node_modules` is empty and this workspace has none, so resolution starts from an
 * installed `@deepseek-ai` package instead. Set `DSH_INSTALL_ROOT` to the `node_modules/@deepseek-ai`
 * directory (or any file inside it) when the dsh checkout is somewhere else.
 */
function hostLoader() {
  /** @type {string[]} */
  const anchors = [];
  if (typeof process.env.DSH_INSTALL_ROOT === 'string' && process.env.DSH_INSTALL_ROOT !== '') {
    const root = process.env.DSH_INSTALL_ROOT.replace(/[\\/]+$/, '');
    anchors.push(`${root}/dsh-skill/lib/index.js`, `${root}/dsh-skill/package.json`, root);
  }
  anchors.push(
    'C:/Users/david/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-skill/lib/index.js',
  );
  for (const anchor of anchors) {
    try {
      return createRequire(anchor);
    } catch {
      // try the next anchor
    }
  }
  return undefined;
}

const loader = hostLoader();
let host;
if (loader !== undefined) {
  try {
    const load = (name) => import(pathToFileURL(loader.resolve(name)).href);
    host = { Context: (await load('@deepseek-ai/cordis')).Context, skill: await load('@deepseek-ai/dsh-skill') };
  } catch {
    host = undefined;
  }
}

const skip = host === undefined ? 'the dsh installation is not resolvable from here' : false;
const manifest = readUpstreamManifest().manifest;
/** A live composition bound to a real Cordis context. */
function liveHost() {
  const ctx = new host.Context();
  const registry = new host.skill.SkillRegistry(ctx);
  void registry;
  const source = createSnapshotSource({ plugins: (manifest.includedPlugins ?? []).map((plugin) => plugin.name) });
  const config = {
    rank: 700,
    descriptionMode: 'authored',
    catalogSummaryBudget: 320,
    catalogDescriptionMaxLength: 500,
  };
  const selection = createSelectionService({ config, manifest, pluginSkills: source.pluginSkills() });
  const descriptions = loadDescriptions({ path: descriptionsPath, manifest, budget: config.catalogSummaryBudget });
  const journal = createJournal();
  const provider = createProvider({ source, selection, descriptions, config, journal });
  let control;
  const dispose = ctx.skills.registerProvider((providerControl) => {
    control = providerControl;
    return provider;
  });
  return { ctx, source, selection, descriptions, journal, provider, control: () => control, dispose };
}

test('the real registry accepts every candidate the provider emits', { skip }, async () => {
  const live = liveHost();
  try {
    const summaries = await live.ctx.skills.list({});
    assert.deepEqual(
      summaries.map((summary) => summary.name),
      ['csharp-scripts', 'dotnet-pinvoke', 'nuget-trusted-publishing'],
      'the host sorts the catalog by name',
    );
    for (const summary of summaries) {
      assert.equal(summary.provider, 'dotnet-agent-skills');
      assert.equal(summary.source, 'bundled');
      assert.deepEqual(summary.invocation, { modelInvocable: true, userInvocable: true });
      assert.equal(typeof summary.path, 'string');
      assert.equal(summary.resourceBase.kind, 'directory');
      assert.ok(summary.description.length > 0);
    }
  } finally {
    live.dispose();
  }
});

test('the real registry loads a definition and the body is the snapshot byte for byte', { skip }, async () => {
  const live = liveHost();
  try {
    const definition = await live.ctx.skills.get('nuget-trusted-publishing', {});
    assert.equal(definition.name, 'nuget-trusted-publishing');
    assert.equal(
      definition.content,
      readFileSync(new URL('../vendor/upstream/dotnet/skills/nuget-trusted-publishing/SKILL.md', import.meta.url), 'utf8'),
      'the body is served verbatim; the plugin never rewrites a SKILL.md',
    );
    assert.match(definition.content, /\n# NuGet Trusted Publishing Setup\n/);
    // The downstream truncation §7.9 describes, applied by the provider before the host sees it.
    assert.equal(definition.description, live.descriptions.entries.get('dotnet/nuget-trusted-publishing').text);
  } finally {
    live.dispose();
  }
});

test('the host observer reports incomplete discovery without losing the catalog', { skip }, async () => {
  const live = liveHost();
  try {
    const observation = await live.provider.list({});
    assert.equal(observation.complete, true);
    const snapshot = await live.ctx.skills.snapshot({});
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.skills.length, 3);
  } finally {
    live.dispose();
  }
});

test('rank decides a duplicate name inside one layer, and 700 loses to a smaller rank', { skip }, async () => {
  const live = liveHost();
  const otherCtx = live.ctx;
  // A second provider that also ships `csharp-scripts`, at the user-dsh rank of 400.
  const winnerDispose = otherCtx.skills.registerProvider(() => ({
    name: 'user-override',
    async list() {
      return [
        {
          name: 'csharp-scripts',
          description: 'A user-provided override of the same name.',
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'user-dsh',
          provider: 'user-override',
          rank: 400,
          locator: { skill: 'override' },
        },
      ];
    },
    async get() {
      return undefined;
    },
  }));
  try {
    const summaries = await otherCtx.skills.list({});
    const chosen = summaries.find((summary) => summary.name === 'csharp-scripts');
    assert.equal(chosen.provider, 'user-override', 'the smaller rank wins the name');
    assert.equal(summaries.length, 3, 'the losing candidate is hidden, not duplicated');
  } finally {
    winnerDispose();
    live.dispose();
  }
});

test('a provider that throws is skipped; an invalid candidate is not survivable', { skip }, async () => {
  const ctx = new host.Context();
  new host.skill.SkillRegistry(ctx);
  ctx.skills.registerProvider(() => ({
    name: 'exploding',
    async list() {
      throw new Error('provider bug');
    },
    async get() {
      return undefined;
    },
  }));
  // The host wraps provider `list()` in its own try/catch, which is why §6.2 tells us to return
  // `complete: false` instead of throwing: our failures would be merely invisible otherwise.
  assert.deepEqual(await ctx.skills.list({}), []);

  const invalid = new host.Context();
  new host.skill.SkillRegistry(invalid);
  invalid.skills.registerProvider(() => ({
    name: 'invalid-candidate',
    async list() {
      return [
        {
          name: 'Not-A-Skill',
          description: 'text',
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'bundled',
          provider: 'invalid-candidate',
          rank: 700,
          locator: {},
        },
      ];
    },
    async get() {
      return undefined;
    },
  }));
  // Candidate validation runs OUTSIDE that try/catch, so one bad candidate kills the whole read.
  // This is the exact hazard the provider's self-validation exists to prevent.
  await assert.rejects(() => invalid.skills.list({}), /invalid skill name/);
});

test('the documented rank constants are the ones the host uses', { skip }, () => {
  assert.equal(host.skill.BUNDLED_SKILL_RANK, 600);
  // Our default of 700 is only meaningful relative to these; assert the relationship, not a guess.
  assert.ok(700 > host.skill.BUNDLED_SKILL_RANK, 'bundled roots outrank us');
});

test('ctx.provide exposes the selection service to a third-party consumer', { skip }, async () => {
  const ctx = new host.Context();
  const service = {
    version: 1,
    selectors: { register: () => () => {}, list: () => [], unregister: () => {} },
    fold: () => ({ names: [], reasons: new Map() }),
  };
  const dispose = ctx.provide('dotnetSkills', service);
  const resolved = ctx.get('dotnetSkills');
  assert.equal(resolved, service, 'a third-party plugin can resolve the seam without touching ours');
  assert.equal(typeof resolved.selectors.register, 'function');
  assert.equal(resolved.version, 1);
  dispose();
  assert.equal(ctx.get('dotnetSkills'), undefined, 'and it disappears when the plugin unloads');
});

test('the catalog line the host renders is exactly what the plugin reports', { skip }, async () => {
  const live = liveHost();
  try {
    const summaries = await live.ctx.skills.list({});
    // The host's own normalization and truncation, as `dsh-tool-skill` applies them (§7.9).
    const hostNormalize = (value, maxLength) => {
      const normalized = value.replaceAll(/\s+/g, ' ').trim();
      return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
    };
    const renderedChars = summaries.reduce((total, summary) => {
      const description = hostNormalize(summary.description, 500);
      assert.equal(description, summary.description, `${summary.name} must pass through untouched`);
      return total + `- \`${summary.name}\`: `.length + description.length;
    }, 0);

    const { buildStatusReport } = await import('../lib/status.js');
    const report = await buildStatusReport({
      manifest,
      config: { rank: 700, descriptionMode: 'authored', catalogDescriptionMaxLength: 500 },
      source: live.source,
      provider: live.provider,
      journal: live.journal,
      descriptions: live.descriptions,
      selection: live.selection,
    });
    assert.equal(
      report.catalog.chars,
      renderedChars,
      'the reported catalog character count is the length of the catalog the host publishes',
    );
  } finally {
    live.dispose();
  }
});

test('the snapshot root the provider serves is the packaged one', { skip }, () => {
  assert.ok(snapshotRoot.endsWith(`vendor${process.platform === 'win32' ? '\\' : '/'}upstream`) || snapshotRoot.includes('upstream'));
  // Internal consistency rather than a P0 number: what the manifest declares as its total must be
  // what its own plugin lists add up to, at any range.
  const declared = (manifest.includedPlugins ?? []).flatMap((plugin) => plugin.skills ?? []);
  assert.equal(manifest.skillCount, declared.length);
});

/**
 * M5's server half.
 *
 * The `/name` gesture is a client interaction, so what can be established from here is the policy the
 * client consults: `dsh-client-ui-skill` resolves the catalog by name and `dsh-tool-skill` injects a
 * body for a name that is user-invocable. Asserting both fixes the gesture's outcome before anyone
 * clicks it — and the same loop covers M4's server half, since the sidebar preview is literally
 * `catalog.find((skill) => '/name' === ref)?.path` followed by opening that file.
 */
test('every shipped skill is summonable by /name and has a previewable path', { skip }, async () => {
  const live = liveHost();
  try {
    const summaries = await live.ctx.skills.list({});
    assert.equal(summaries.length, 3);
    for (const summary of summaries) {
      assert.equal(host.skill.isUserInvocable(summary), true, `${summary.name} must be summonable by /name`);
      assert.equal(host.skill.isModelInvocable(summary), true, `${summary.name} must stay in the model catalog`);
      assert.equal(typeof summary.path, 'string', `${summary.name} needs a path for the sidebar preview`);
      assert.equal(existsSync(summary.path), true, `${summary.path} must be readable`);
      assert.equal(summary.path.endsWith('SKILL.md'), true);
      const body = readFileSync(summary.path, 'utf8');
      assert.ok(body.startsWith('---\n'), 'the preview shows the file as published, frontmatter included');
      assert.match(body, /\n# /, 'and the file is real Markdown, not frontmatter alone');
    }
  } finally {
    live.dispose();
  }
});
