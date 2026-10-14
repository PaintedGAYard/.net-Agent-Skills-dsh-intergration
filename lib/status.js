/**
 * The diagnostic report behind `dotnet_skills_status` (doc/spec.md §11.4).
 *
 * All ten diagnostic items live here, in one place, because a status tool that reports nine of
 * them is worse than one that reports none: the operator cannot tell "nothing to report" from
 * "we forgot to look". The report is plain data plus a markdown rendering, so the same
 * structure answers the tool, the tests and `tools/report.mjs` later on.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { cap } from './descriptions.js';
import { censusPointers, classifyPointers, nameUniverse } from './pointers.js';
import { estimateTokens } from './selection.js';
import { auditLineEndings, computeSnapshotSha256, snapshotAgeDays, verifySnapshotIntegrity } from './snapshot.js';

/** Structured diagnostic report. Every field below is one of §11.4's ten items. */
export const DIAGNOSTIC_KEYS = [
  'selection', // 1
  'catalog', // 2
  'provenance', // 3
  'limits', // 4
  'shadowing', // 5
  'deployment', // 6
  'pointers', // 7
  'powerShell', // 8
  'skippedSkills', // 9
  'authoring', // 10
];

/**
 * Collect the whole report.
 *
 * The catalog items are read from the provider's own `list()` output rather than recomputed:
 * "what the catalog costs" has to mean the exact strings the host will render, and a second
 * implementation of the description decision would eventually disagree with the first.
 *
 * @param {object} input
 * @param {object | undefined} input.manifest - parsed `vendor/UPSTREAM.json`
 * @param {object} input.config - resolved plugin config
 * @param {object} input.source - snapshot content source
 * @param {object} input.provider - the live provider, for its candidates and its journal
 * @param {object} input.journal - provider diagnostics record
 * @param {object} input.descriptions - loaded authored data
 * @param {object} input.selection - the `dotnetSkills` service, when one is live
 * @param {string[]} [input.otherProviders] - names of other registered skill providers
 * @param {number} [input.now] - injectable clock, so the report is reproducible in tests
 * @param {string} [input.pwshVersion] - detected PowerShell, when one is available
 * @param {string} [input.cwd] - workspace the provider should select for
 * @param {object} [input.deployment] - the result of inspecting the deploy root (`lib/deploy`)
 * @returns {Promise<object>}
 */
export async function buildStatusReport({
  manifest,
  config,
  source,
  provider,
  journal,
  descriptions,
  selection,
  otherProviders = [],
  now = Date.now(),
  pwshVersion,
  cwd,
  deployment: deploymentInput,
}) {
  const plugins = manifest?.includedPlugins ?? [];
  const folded = selection === undefined ? { names: [], reasons: new Map() } : selection.fold({ cwd });
  const reasons = folded.reasons ?? new Map();

  const observation = await provider.list({ cwd });
  const candidates = observation.candidates ?? [];
  const listed = candidates.map((candidate) => ({
    name: candidate.name,
    plugin: candidate.metadata?.plugin ?? 'unknown',
    reason: candidate.metadata?.selectionReason ?? reasons.get(candidate.name) ?? 'unknown',
    description: candidate.description,
    descriptionChars: candidate.description.length,
    descriptionSource: candidate.metadata?.descriptionSource ?? 'verbatim',
    capped: candidate.metadata?.descriptionSource === 'capped' || candidate.description.endsWith('...'),
  }));

  const selected = candidates.map((candidate) => candidate.name);
  const shippedNames = new Set(plugins.flatMap((plugin) => plugin.skills ?? []));
  const selectedButMissing = (folded.names ?? []).filter((name) => !selected.includes(name) && !shippedNames.has(name));

  let catalogChars = 0;
  for (const entry of listed) catalogChars += `- \`${entry.name}\`: `.length + entry.descriptionChars;
  const integrity = manifest === undefined ? { ok: false, error: 'no snapshot provenance' } : verifySnapshotIntegrity(manifest);
  const endings = auditLineEndings();
  const counts = countSnapshot();
  const names = manifest === undefined ? { universe: new Set(), included: new Set() } : nameUniverse(manifest);

  /** @type {Array<{ plugin: string, skill: string }>} */
  const withScripts = [];
  for (const skill of listed) {
    const resolved = source.resolve(skill.plugin);
    const record = (resolved?.skills ?? []).find((candidate) => candidate.name === skill.name);
    if ((record?.resources?.scripts ?? 0) > 0) withScripts.push({ plugin: skill.plugin, skill: skill.name });
  }

  const pointerCensus = censusPointers(
    listedSkillsWithDescriptions(source, plugins, selected),
    names,
  );

  // §9's detection is wired as of P1. What the report has to distinguish is no longer "wired or not"
  // but "ran and matched nothing" versus "never ran" versus "had nothing to scan", because all three
  // leave the same catalog behind. The record is written by the fold above (`selection.fold({ cwd })`),
  // so it describes exactly the workspace this report is about.
  const detection = journal?.detection;

  return {
    selection: {
      plugins: [...new Set(listed.map((entry) => entry.plugin))].sort(),
      skills: listed.map((entry) => ({ name: entry.name, plugin: entry.plugin, reason: entry.reason })),
      selectors: selection === undefined ? [] : selection.selectors.list(),
      projectDetection: {
        wired: typeof selection?.hasDetect === 'function' ? selection.hasDetect() : false,
        enabled: config.probe?.enabled !== false,
        // Absent until detection has actually run, so the shape stays exactly `{ wired, enabled }` for
        // a provider with no `detect` callback. Also absent while `probe.enabled` is false: a record
        // left over from an earlier run would describe a scan this configuration refuses to do.
        ...(detection === undefined || config.probe?.enabled === false ? {} : { last: detection }),
      },
      selectedButMissing,
      otherProviders,
    },
    catalog: {
      entries: listed.length,
      chars: catalogChars,
      estTokens: estimateTokens(listed.map((entry) => entry.name)),
      complete: observation.complete,
    },
    provenance: {
      tag: manifest?.tag ?? null,
      commit: manifest?.commit ?? null,
      fetchedAt: manifest?.fetchedAt ?? null,
      ageDays: manifest === undefined ? undefined : snapshotAgeDays(manifest, now),
      snapshotSha256: manifest?.snapshotSha256 ?? null,
      integrity: integrity.ok ? 'ok' : (integrity.error ?? `mismatch: recorded ${integrity.recorded}, actual ${integrity.actual}`),
      files: counts.files,
      bytes: counts.bytes,
      lineEndings: endings.ok ? 'lf' : `crlf in ${endings.offenders.length} file(s)`,
      declaredSkillCount: manifest?.skillCount ?? null,
      rangeNotes:
        (manifest?.outOfRangePlugins ?? []).length === 0
          ? []
          : [
              `${(manifest?.outOfRangePlugins ?? []).length} marketplace plugins are outside this snapshot range ` +
                `(${(manifest?.outOfRangePlugins ?? []).map((plugin) => plugin.name).join(', ')})`,
            ],
    },
    limits: {
      catalogSummaryBudget: descriptions.budget,
      catalogDescriptionMaxLength: config.catalogDescriptionMaxLength ?? 500,
      catalogTokenBudget: config.catalogTokenBudget ?? 0,
      descriptionMode: config.descriptionMode ?? 'authored',
      rank: config.rank ?? 700,
      cappedEntries: listed.filter((entry) => entry.capped).length,
      // The host tool's `catalogDescriptionMaxLength` is checked first, but the honest observation is
      // that it is the *host tool's* setting: our copy mirrors it by configuration and the operator has
      // to keep the two in step. Reporting the source keeps the number from looking authoritative.
      catalogDescriptionMaxLengthSource: 'configured to match the host skill tool (default 500)',
    },
    providerRanks: [
      { rank: 100, provider: 'project-dsh' },
      { rank: 200, provider: 'project-agents' },
      { rank: 300, provider: 'custom' },
      { rank: 400, provider: 'user-dsh' },
      { rank: 500, provider: 'user-agents' },
      { rank: 600, provider: 'bundled roots' },
      { rank: config.rank ?? 700, provider: 'this provider (dotnet-agent-skills)' },
    ],
    shadowing: shadowCandidates(source, plugins, config.rank ?? 700),
    // §11.4 item 6: what is actually on disk. The inspected record wins when one is supplied, because
    // the manifest is the only thing that knows what was materialized; `config.deployment` remains as
    // the fallback a caller with no deploy root (or no platform adapter) can still fill in.
    deployment: {
      mode: deploymentInput?.mode ?? config.deployment?.mode ?? 'none',
      root: deploymentInput?.root ?? config.deployment?.root ?? null,
      degradedReason: deploymentInput?.degradedReason ?? config.deployment?.degradedReason ?? null,
      entries: deploymentInput?.entries ?? config.deployment?.entries ?? 0,
      dangling: deploymentInput?.dangling ?? config.deployment?.dangling ?? [],
      complete: deploymentInput?.complete ?? config.deployment?.complete ?? true,
      ...(deploymentInput?.reason === undefined ? {} : { reason: deploymentInput.reason }),
    },
    pointers: {
      inRangeTargets: pointerCensus.required.size,
      dangling: [...pointerCensus.dangling.entries()].map(([target, sources]) => ({ target, sources })),
      droppedByAuthoring: droppedPointers(source, plugins, descriptions, names),
    },
    powerShell: {
      ...describePowerShell(pwshVersion),
      dependentSkills: withScripts.map((entry) => `${entry.plugin}/${entry.skill}`),
    },
    skippedSkills: journal.notes.filter((note) => /skipped|cannot read|failed|no longer|absent/.test(note)),
    authoring: {
      entries: descriptions.entries.size,
      diagnostics: descriptions.diagnostics,
      upstream: descriptions.upstream,
      gaps: authoringGaps(source, plugins, config, descriptions),
    },
  };
}

/**
 * Whether the catalog text for one skill had to be truncated for the effective limit.
 *
 * Kept as a fallback for callers that only have upstream text; the live report reads the
 * provider's own `descriptionSource` instead of recomputing the decision.
 */
export function isCapped(descriptions, key, upstreamDescription, config) {
  const max = config.catalogDescriptionMaxLength ?? 500;
  const entry = (config.descriptionMode ?? 'authored') === 'authored' ? descriptions.entries.get(key) : undefined;
  const text = entry === undefined ? upstreamDescription : entry.text;
  return text.length > max;
}

function listedSkillsWithDescriptions(source, plugins, selected) {
  /** @type {Array<{ key: string, description: string }>} */
  const skills = [];
  for (const plugin of plugins) {
    const resolved = source.resolve(plugin.name);
    for (const skill of resolved?.skills ?? []) {
      if (!selected.includes(skill.name)) continue;
      skills.push({ key: `${plugin.name}/${skill.name}`, description: skill.description });
    }
  }
  return skills;
}

/**
 * Names this provider ships that another provider with a smaller rank would win.
 *
 * The host has no API to list shadowed definitions at all, so this can only be an approximation:
 * it reports our own rank relative to the documented built-in ranks and leaves the verdict to
 * the reader rather than claiming knowledge it cannot have.
 */
function shadowCandidates(source, plugins, rank) {
  /** @type {Array<{ name: string, plugin: string }>} */
  const names = [];
  for (const plugin of plugins) {
    for (const skill of source.resolve(plugin.name)?.skills ?? []) {
      names.push({ name: skill.name, plugin: plugin.name });
    }
  }
  // The generic names are the ones §14 flags as collision-prone.
  const generic = new Set(['run-tests', 'filter-syntax', 'platform-detection', 'coverage-analysis', 'crap-score']);
  return {
    shipped: names.length,
    collisionProne: names.filter((entry) => generic.has(entry.name)),
    note:
      `the host exposes no API for listing shadowed definitions, so this cannot be observed directly. ` +
      `What can be stated: this provider is registered at rank ${String(rank)}, and a smaller rank wins a ` +
      `duplicate name inside one layer — so project (100/200), custom (300), user (400/500) and bundled ` +
      `(600) skills all take precedence over ours. If a skill looks missing, a co-named skill from another ` +
      `provider is the first thing to check.`,
  };
}

/**
 * In-range skills that fall under the authoring coverage rule but have no authored entry.
 *
 * The rule is "upstream description longer than the downstream default, or carries `INVOKES:`"
 * (§7.2) — not "longer than the effective limit", which changes with configuration. This is a
 * coverage gap, which the sync gate also treats as a hard failure; the status tool reports it so
 * an operator can see it without running the gate.
 */
function authoringGaps(source, plugins, config, descriptions) {
  /** @type {string[]} */
  const gaps = [];
  if ((config.descriptionMode ?? 'authored') !== 'authored') return gaps;
  for (const plugin of plugins) {
    for (const skill of source.resolve(plugin.name)?.skills ?? []) {
      const needs = skill.description.length > 500 || skill.description.includes('INVOKES:');
      if (!needs) continue;
      if (descriptions.entries.has(`${plugin.name}/${skill.name}`)) continue;
      gaps.push(`${plugin.name}/${skill.name}`);
    }
  }
  return gaps;
}

/**
 * Pointers the authored text drops, for the record.
 *
 * A dropped pointer to a shipped skill is already a hard gate failure, so anything listed here
 * is a pointer to a skill outside the shipped set — allowed, but it must be visible rather than
 * silent (§7.6).
 */
function droppedPointers(source, plugins, descriptions, names) {
  /** @type {string[]} */
  const dropped = [];
  for (const plugin of plugins) {
    for (const skill of source.resolve(plugin.name)?.skills ?? []) {
      const key = `${plugin.name}/${skill.name}`;
      const entry = descriptions.entries.get(key);
      if (entry === undefined || typeof entry.text !== 'string') continue;
      const authored = new Set(classifyPointers(entry.text, names).dangling);
      for (const target of classifyPointers(skill.description, names).dangling) {
        if (!authored.has(target)) dropped.push(`${key} → ${target}`);
      }
    }
  }
  return dropped;
}

function countSnapshot() {
  return computeSnapshotSha256();
}

/**
 * Probe for a PowerShell interpreter without branching on the platform.
 *
 * `scripts/*.ps1` needs `pwsh`; the honest report is "we could not confirm one" rather than a
 * guess. Deployment and installation paths — the only places a platform branch is legitimate —
 * live in `lib/platform/`, which P0 does not ship (spec §10.4).
 *
 * @param {string | undefined} reported - a version string the caller already knows
 * @returns {{ available: boolean, version: string | null }}
 */
export function describePowerShell(reported) {
  const version = typeof reported === 'string' && reported.trim() !== '' ? reported.trim() : null;
  return { available: version !== null, version };
}

/** Files under a directory, for the resource inventory. */
export function countFiles(directory) {
  if (!existsSync(directory)) return 0;
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(join(directory, entry.name)) : 1;
  }
  return total;
}

/**
 * Render the report as markdown for the tool result.
 *
 * Ordered exactly like §11.4, so a reader can check the list off item by item.
 *
 * @param {object} report
 * @returns {string}
 */
export function renderStatusReport(report) {
  const lines = [];
  const {
    selection,
    catalog,
    provenance,
    limits,
    providerRanks,
    shadowing,
    deployment,
    pointers,
    powerShell,
    skippedSkills,
    authoring,
  } = report;

  lines.push('# .NET Agent Skills status');
  lines.push('');
  lines.push('## 1. Selected skills');
  lines.push('');
  lines.push(`Plugins: ${selection.plugins.length === 0 ? '(none)' : selection.plugins.join(', ')}`);
  lines.push(`Selectors registered: ${selection.selectors.join(', ')}`);
  lines.push(describeProjectDetection(selection.projectDetection));
  if (selection.skills.length === 0) {
    lines.push('No skills are currently selected.');
  } else {
    lines.push('');
    lines.push('| skill | plugin | selection reason |');
    lines.push('|---|---|---|');
    for (const skill of selection.skills) {
      lines.push(`| \`${skill.name}\` | ${skill.plugin} | ${skill.reason} |`);
    }
  }
  if (selection.selectedButMissing.length > 0) {
    lines.push('');
    lines.push(`Selected but absent from the snapshot: ${selection.selectedButMissing.join(', ')}`);
  }
  if (selection.otherProviders.length > 0) {
    lines.push('');
    lines.push(`Other skill providers registered: ${selection.otherProviders.join(', ')}`);
  }

  lines.push('');
  lines.push('## 2. Catalog cost');
  lines.push('');
  lines.push(`Entries: ${catalog.entries}${catalog.complete === false ? ' (discovery incomplete)' : ''}`);
  lines.push(`Catalog characters: ${catalog.chars} (estimated ${catalog.estTokens} tokens)`);

  lines.push('');
  lines.push('## 3. Snapshot provenance');
  lines.push('');
  lines.push(`Upstream: ${provenance.tag} (${String(provenance.commit).slice(0, 12)})`);
  lines.push(`Fetched: ${provenance.fetchedAt}${provenance.ageDays === undefined ? '' : ` (${provenance.ageDays} days old)`}`);
  lines.push(`Snapshot digest: ${provenance.integrity}`);
  lines.push(`Snapshot files: ${provenance.files} (${provenance.bytes} bytes), line endings: ${provenance.lineEndings}`);
  lines.push(`Declared skills: ${provenance.declaredSkillCount}`);
  for (const note of provenance.rangeNotes) lines.push(`Range: ${note}`);

  lines.push('');
  lines.push('## 4. Effective limits');
  lines.push('');
  lines.push(`catalogDescriptionMaxLength: ${limits.catalogDescriptionMaxLength}`);
  lines.push(`  (${limits.catalogDescriptionMaxLengthSource})`);
  lines.push(`catalogSummaryBudget: ${limits.catalogSummaryBudget}`);
  lines.push(`catalogTokenBudget: ${limits.catalogTokenBudget === 0 ? 'unlimited' : limits.catalogTokenBudget}`);
  lines.push(`descriptionMode: ${limits.descriptionMode}`);
  lines.push(`rank: ${limits.rank}`);
  lines.push(`Descriptions truncated by cap(): ${limits.cappedEntries}`);

  lines.push('');
  lines.push('## 5. Shadowing');
  lines.push('');
  lines.push(`Skills shipped by this provider: ${shadowing.shipped}`);
  lines.push('Provider ranks, smallest wins a duplicate name:');
  for (const entry of providerRanks ?? []) {
    lines.push(`  ${String(entry.rank).padStart(3)}  ${entry.provider}`);
  }
  lines.push(shadowing.note);
  if (shadowing.collisionProne.length > 0) {
    lines.push('');
    lines.push(
      `Collision-prone names: ${shadowing.collisionProne.map((entry) => `\`${entry.name}\``).join(', ')}`,
    );
  }

  lines.push('');
  lines.push('## 6. Deployment');
  lines.push('');
  lines.push(`Mode: ${deployment.mode}`);
  if (deployment.root !== null) lines.push(`Root: ${deployment.root}`);
  if (deployment.entries > 0) lines.push(`Skills deployed: ${deployment.entries}${deployment.complete ? '' : ' (incomplete)'}`);
  if (deployment.dangling.length > 0) {
    lines.push(
      `Dangling: ${deployment.dangling.join(', ')} - deployed but unreadable, so the host's filesystem ` +
        'provider cannot load them; re-run the deployment',
    );
  }
  if (deployment.degradedReason !== null) lines.push(`Degraded because: ${deployment.degradedReason}`);
  if (deployment.reason !== undefined) lines.push(deployment.reason);
  if (deployment.mode !== 'none' && deployment.mode !== 'unknown') {
    // The two entry points are alternatives (§10.1), and the rank ordering makes them compete: a
    // deployment in the host's own user skill root is discovered at rank 400 and wins a duplicate name
    // over this provider at rank 700, which means the filesystem provider's verbatim text would replace
    // the authored description. Saying so here is cheaper than being asked why the catalog changed.
    lines.push(
      'Note: a deployment in the host\'s user skill root is discovered by the host\'s own filesystem ' +
        `provider (rank 400), which wins a duplicate name over this provider (rank ${String(limits.rank)}); ` +
        'deploy when you want that provider, not when you want these descriptions.',
    );
  }

  lines.push('');
  lines.push('## 7. Pointers');
  lines.push('');
  lines.push(`Distinct in-range pointer targets: ${pointers.inRangeTargets}`);
  if (pointers.dangling.length === 0) {
    lines.push('No pointers leave the shipped set.');
  } else {
    for (const entry of pointers.dangling) {
      lines.push(`Dangling: \`${entry.target}\` ← ${entry.sources.join(', ')}`);
    }
  }
  if (pointers.droppedByAuthoring.length > 0) {
    lines.push(`Dropped by authoring: ${pointers.droppedByAuthoring.join(', ')}`);
  }

  lines.push('');
  lines.push('## 8. PowerShell dependency');
  lines.push('');
  lines.push(`pwsh: ${powerShell.available ? powerShell.version : 'not found on PATH'}`);
  if (powerShell.dependentSkills.length === 0) {
    lines.push('No selected skill ships a PowerShell script.');
  } else {
    lines.push(`Selected skills with scripts/: ${powerShell.dependentSkills.join(', ')}`);
  }

  lines.push('');
  lines.push('## 9. Skipped skills');
  lines.push('');
  if (skippedSkills.length === 0) {
    lines.push('None.');
  } else {
    for (const note of skippedSkills) lines.push(`- ${note}`);
  }

  lines.push('');
  lines.push('## 10. Authoring coverage');
  lines.push('');
  lines.push(`Authored entries loaded: ${authoring.entries}`);
  lines.push(`Authored against: ${authoring.upstream.tag} (${String(authoring.upstream.commit).slice(0, 12)})`);
  if (authoring.diagnostics.length === 0) {
    lines.push('No authoring diagnostics.');
  } else {
    for (const note of authoring.diagnostics) lines.push(`- ${note}`);
  }
  if (authoring.gaps.length > 0) {
    lines.push(`In-range skills whose upstream description exceeds the downstream limit: ${authoring.gaps.length}`);
  }

  return lines.join('\n');
}

/**
 * One line of §1 saying what project detection is actually doing.
 *
 * The states that matter are the ones that look alike from the outside. With `probe.*` in the
 * configuration and nothing wired behind it, "no signal matched" and "nothing was ever scanned"
 * produce the same catalog. Once detection is wired, "no workspace was named", "the workspace could not
 * be read" and "it was scanned and matched nothing" still do — so the last detection is printed with
 * the numbers that tell them apart (§11.4 item 1).
 *
 * @param {{ wired?: boolean, enabled?: boolean, last?: object } | undefined} state
 * @returns {string}
 */
function describeProjectDetection(state) {
  if (state?.wired !== true) {
    return (
      'Project detection: not implemented in this version - probe.* has no effect yet; ' +
      'the core set is the whole selection (spec §9 lands with P1).'
    );
  }
  if (state.enabled === false) return 'Project detection: disabled by probe.enabled.';

  const last = state.last;
  if (last === undefined) return 'Project detection: enabled.';
  if (last.scanned?.reason === 'no-cwd') {
    return 'Project detection: enabled; no workspace was named, so nothing was scanned.';
  }
  if (last.scanned?.reason === 'unreadable') {
    return `Project detection: enabled; ${last.scanned.cwd} could not be read, so nothing was scanned.`;
  }

  const matched = last.plugins.length === 0 ? 'no signal matched' : last.plugins.join('+');
  const signals = Object.keys(last.evidence ?? {});
  const truncated =
    last.scanned?.truncated === false || last.scanned?.truncated === undefined
      ? ''
      : `, truncated at ${last.scanned.truncated === 'entries' ? 'probe.maxFiles' : 'the content budget'}`;
  const retained = last.retained.length === 0 ? '' : `; retained from an earlier read: ${last.retained.join('+')}`;
  return (
    `Project detection: enabled. Last detection (${String(last.scanned?.cwd)}): ${matched} - ` +
    `scanned ${String(last.scanned?.files)} files / ${String(last.scanned?.dirs)} dirs${truncated}` +
    `${signals.length === 0 ? '' : ` [signals: ${signals.join(', ')}]`}${retained}`
  );
}
