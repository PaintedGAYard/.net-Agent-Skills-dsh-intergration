/**
 * The skill selection middleware (doc/spec.md §8).
 *
 * Selection is a chain of independent selectors, each returning a patch or abstaining. The
 * fold has to be deterministic and independent of registration order, because two runs of
 * the same session must produce the same catalog — and a catalog that changes for no reason
 * costs a KV-cache invalidation (§6.2, hard rule two).
 *
 * The service is exposed on `ctx.provide('dotnetSkills', …)` so a third-party bundle can
 * register its own policy through `ctx.inject(['dotnetSkills'], …)` without touching this
 * plugin (§8.2). Its `version` is a contract number for such bundles to branch on.
 */

import { readUpstreamManifest } from './snapshot.js';

/** Contract version for third-party selectors. Bump only on an incompatible change. */
export const SELECTION_CONTRACT_VERSION = 1;

/** Selectors that ship with the plugin and can be switched on or off by name. */
export const BUILT_IN_SELECTORS = ['config-baseline', 'core-set', 'project-detection', 'budget'];

/**
 * Fold a set of patches into the final skill selection (§8.1).
 *
 * `include` is unioned, `exclude` is subtracted afterwards, and `priority` decides only who
 * owns the `reason` and which conflict gets logged — never what the set contains. Ties are
 * broken by selector name in code-point order so that the result cannot depend on the order
 * selectors happened to register in.
 *
 * @param {Array<{ name: string, priority: number, patch: { include?: string[], exclude?: string[], reason?: string } }>} patches
 * @returns {{
 *   names: string[],
 *   reasons: Map<string, string>,
 *   excluded: string[],
 *   conflicts: Array<{ name: string, includedBy: string[], excludedBy: string[] }>,
 * }}
 */
export function foldPatches(patches) {
  /** @type {Map<string, Array<{ name: string, priority: number, reason: string }>>} */
  const includes = new Map();
  /** @type {Map<string, string[]>} */
  const excludes = new Map();

  const ordered = [...patches].sort((left, right) => compareNames(left.name, right.name));
  for (const { name, priority, patch } of ordered) {
    for (const skill of patch.include ?? []) {
      if (typeof skill !== 'string' || skill === '') continue;
      if (!includes.has(skill)) includes.set(skill, []);
      includes.get(skill).push({ name, priority, reason: patch.reason ?? name });
    }
    for (const skill of patch.exclude ?? []) {
      if (typeof skill !== 'string' || skill === '') continue;
      if (!excludes.has(skill)) excludes.set(skill, []);
      excludes.get(skill).push(name);
    }
  }

  /** @type {Map<string, string>} */
  const reasons = new Map();
  /** @type {string[]} */
  const names = [];
  /** @type {string[]} */
  const excluded = [];
  /** @type {Array<{ name: string, includedBy: string[], excludedBy: string[] }>} */
  const conflicts = [];

  for (const [skill, claimants] of includes) {
    if (excludes.has(skill)) {
      conflicts.push({ name: skill, includedBy: claimants.map((claimant) => claimant.name), excludedBy: excludes.get(skill) });
      excluded.push(skill);
      continue;
    }
    // Highest priority owns the reason; equal priority falls to the code-point-smallest name.
    const owner = [...claimants].sort(
      (left, right) => right.priority - left.priority || compareNames(left.name, right.name),
    )[0];
    reasons.set(skill, owner.reason);
    names.push(skill);
  }

  names.sort(compareNames);
  excluded.sort(compareNames);
  return { names, reasons, excluded, conflicts };
}

/**
 * Build the `dotnetSkills` service and its registry (§8.2).
 *
 * @param {object} input
 * @param {object} input.config - resolved plugin config
 * @param {object | undefined} input.manifest - parsed `vendor/UPSTREAM.json`
 * @param {Map<string, string[]>} [input.pluginSkills] - plugin → skills of the shipped range
 * @param {(context: object) => object} [input.detect] - project signals provider (P1)
 * @param {(line: string) => void} [input.log]
 * @returns {object} the service value handed to `ctx.provide('dotnetSkills', …)`
 */
export function createSelectionService({ config, manifest, pluginSkills, detect, log }) {
  /** @type {Map<string, { name: string, selector: Function, order: number, priority: number, enabled: boolean }>} */
  const selectors = new Map();
  let order = 0;

  /**
   * Which plugin owns each skill name.
   *
   * Built from the authoritative `UPSTREAM.json` plugin→skill lists rather than from the
   * files on disk, so `enabledPlugins: ['dotnet-test']` still means something during P0 —
   * when the snapshot range is one plugin but the configuration is written for the baseline.
   * The provider decides what actually exists; selection only decides what is wanted.
   */
  const catalogue = new Map();
  const ownerOf = new Map();
  for (const plugin of manifest?.includedPlugins ?? []) {
    catalogue.set(plugin.name, [...(plugin.skills ?? [])]);
    for (const skill of plugin.skills ?? []) ownerOf.set(skill, plugin.name);
  }
  for (const plugin of manifest?.outOfRangePlugins ?? []) {
    if (!catalogue.has(plugin.name)) catalogue.set(plugin.name, []);
    for (const skill of plugin.skills ?? []) {
      if (!ownerOf.has(skill)) ownerOf.set(skill, plugin.name);
      catalogue.get(plugin.name).push(skill);
    }
  }
  for (const [plugin, skills] of pluginSkills ?? []) {
    if (!catalogue.has(plugin)) catalogue.set(plugin, [...skills]);
  }

  const register = (name, selector, options = {}) => {
    if (typeof name !== 'string' || name === '') throw new Error('a selector needs a non-empty name');
    if (typeof selector !== 'function') throw new Error(`selector "${name}" must be a function`);
    selectors.set(name, {
      name,
      selector,
      order: (order += 1),
      priority: typeof options.priority === 'number' ? options.priority : 0,
      enabled: options.enabled ?? true,
    });
    return () => {
      if (selectors.get(name)?.selector === selector) selectors.delete(name);
    };
  };

  const enabledPredicate = (name) => {
    const disabled = new Set(config.disabledSelectors ?? []);
    if (disabled.has(name)) return false;
    if (name === 'project-detection') return config.probe?.enabled !== false;
    // The budget selector is off by default because its trigger, `catalogTokenBudget`, defaults
    // to 0. Setting a ceiling is what turns it on; `selectors.budget` can veto it explicitly.
    if (name === 'budget') {
      if (config.selectors?.budget === false) return false;
      return Number.isFinite(config.catalogTokenBudget) && (config.catalogTokenBudget ?? 0) > 0;
    }
    return true;
  };

  const skillsOfPlugins = (plugins) => {
    /** @type {string[]} */
    const names = [];
    for (const plugin of plugins) names.push(...(catalogue.get(plugin) ?? []));
    return [...new Set(names)];
  };

  /** The default core set: the `dotnet` plugin's skills, read from data rather than hard-coded (§8.4). */
  const coreSet = () => {
    const skills = catalogue.get('dotnet') ?? [];
    return skills.length === 0 ? undefined : { include: skills, reason: 'core-set', priority: 10 };
  };

  const configBaseline = () => {
    const include = [...skillsOfPlugins(config.enabledPlugins ?? []), ...(config.enabledSkills ?? [])];
    const exclude = config.disabledSkills ?? [];
    if (include.length === 0 && exclude.length === 0) return undefined;
    return { include, exclude, reason: 'config-baseline', priority: 20 };
  };

  const projectDetection = (context) => {
    if (detect === undefined || config.probe?.enabled === false) return undefined;
    const signals = detect(context) ?? {};
    const plugins = signals.plugins ?? [];
    const include = skillsOfPlugins(plugins);
    if (include.length === 0) return undefined;
    return { include, reason: `project-detection:${plugins.join('+')}`, priority: 5 };
  };

  const budgetSelector = (context) => {
    const limit = config.catalogTokenBudget ?? 0;
    if (!Number.isFinite(limit) || limit <= 0) return undefined;
    const pinned = new Set(config.pinnedSkills ?? []);
    const current = context.current ?? [];
    if (estimateTokens(current) <= limit) return undefined;

    // Drop the least relevant first, and within one relevance tier the most expensive — the
    // point is to reach the ceiling while removing as few skills as possible. Costs are
    // recomputed after every drop rather than decremented, so the result cannot drift from
    // what `estimateTokens` says about the surviving set.
    const priorityOrder = new Map((config.priorityPlugins ?? []).map((plugin, index) => [plugin, index]));
    const droppable = current
      .filter((name) => !pinned.has(name))
      .sort(
        (left, right) =>
          rankOf(left, priorityOrder) - rankOf(right, priorityOrder) ||
          estimateTokens([right]) - estimateTokens([left]) ||
          compareNames(left, right),
      );

    const exclude = [];
    let remaining = [...current];
    for (const name of droppable) {
      if (estimateTokens(remaining) <= limit) break;
      exclude.push(name);
      remaining = remaining.filter((kept) => kept !== name);
    }
    if (exclude.length === 0) return undefined;
    return { exclude, reason: 'budget', priority: 30 };
  };

  const rankOf = (name, priorityOrder) => {
    const index = priorityOrder.get(ownerOf.get(name));
    return index === undefined ? Number.MAX_SAFE_INTEGER : index;
  };

  const fold = (context = {}) => {
    /** @type {Array<{ name: string, priority: number, patch: object }>} */
    const patches = [];
    const resolvedContext = {
      cwd: context.cwd,
      signals: context.signals,
      config,
      plugins: manifest?.includedPlugins ?? [],
      current: context.current ?? [],
    };
    for (const entry of [...selectors.values()].sort((left, right) => left.order - right.order)) {
      if (!entry.enabled || !enabledPredicate(entry.name)) continue;
      let patch;
      try {
        patch = entry.selector(resolvedContext);
      } catch (error) {
        // Selectors can be third-party code. One broken policy must not take the catalog down.
        log?.(`selector "${entry.name}" threw: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (patch === undefined || patch === null) continue;
      patches.push({ name: entry.name, priority: entry.priority, patch });
    }

    // Monotonicity is deliberately NOT applied here. The advertised set may only grow within
    // one workspace (§6.2 hard rule two), but that guard belongs to the provider, which is the
    // only component that knows what this workspace has already been shown. Keeping `fold`
    // a pure function of its patches is what makes the fold rule testable and the selector
    // contracts honest — in particular, the budget selector could never drop anything if the
    // fold itself remembered every name it had ever returned.
    return foldPatches(patches);
  };

  register('core-set', () => coreSet());
  register('config-baseline', () => configBaseline());
  register('project-detection', (context) => projectDetection(context));
  register('budget', (context) => budgetSelector(context));

  return {
    version: SELECTION_CONTRACT_VERSION,
    selectors: { register, list: () => [...selectors.keys()], unregister: (name) => selectors.delete(name) },
    fold,
    /** Which plugin a shipped skill belongs to, for the status tool and diagnostics. */
    ownerOf,
    /**
     * Whether a project-signal provider is wired at all.
     *
     * The distinction the status tool needs is "detection is off" versus "detection is not built yet":
     * both leave the core set as the whole selection, but only the second one means a `probe.*` setting
     * in the configuration is doing nothing (§9; additive to the §8.2 service contract).
     */
    hasDetect: () => detect !== undefined,
  };
}

/** Rough token estimate for budget decisions: four characters per token, plus the catalog shell. */
export function estimateTokens(names) {
  let characters = 0;
  for (const name of names) characters += name.length + 4;
  return Math.ceil(characters / 4);
}

function compareNames(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The name → plugin map the status tool and the budget selector both need.
 *
 * @param {object | undefined} manifest
 * @returns {Map<string, string[]>} plugin → skill names, for the shipped range
 */
export function shippedSkillsByPlugin(manifest = readUpstreamManifest().manifest) {
  const map = new Map();
  for (const plugin of manifest?.includedPlugins ?? []) map.set(plugin.name, plugin.skills ?? []);
  return map;
}
