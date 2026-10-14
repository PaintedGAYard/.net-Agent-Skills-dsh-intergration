/**
 * The description authoring layer (doc/spec.md §7).
 *
 * Authored descriptions ship as data, not as a runtime transformation. That choice buys
 * the properties this file exists to protect: determinism by construction, every one of
 * the 53 texts reviewable in a pull-request diff, and a runtime that does one map lookup
 * instead of string surgery.
 *
 * The cost is that upstream drift must fail loudly. {@link loadDescriptions} therefore
 * re-checks the formal invariants at activation and *degrades* rather than throws — the
 * host must never lose the whole catalog because one authored string went stale. The
 * full drift check lives in `tools/descriptions.mjs verify`, which is a gate on the sync
 * pipeline and exits non-zero.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeText, parseDocument, readRequiredKeys, SKILL_NAME_PATTERN } from './frontmatter.js';
import { censusPointers, classifyPointers, nameUniverse } from './pointers.js';
import { auditLineEndings, checkoutFallback, snapshotRoot, verifySnapshotIntegrity } from './snapshot.js';

/** Default budget for authored text (§7.3). Must match `data/descriptions.json`'s `budget`. */
export const DEFAULT_CATALOG_SUMMARY_BUDGET = 320;

/**
 * Deterministic last-resort truncation (§7.8).
 *
 * Only reachable when the operator lowers a limit below the authored budget. It is written
 * to be total: for any `max` it returns a non-empty string, because an empty description
 * would make the host reject the candidate and take the whole catalog read down with it.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function cap(text, max) {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(max)) return text;
  if (max >= 3) return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
  return text.slice(0, 1);
}

/**
 * Formal invariants ①–⑥ checked on one authored entry (§7.5).
 *
 * Whether a label *should* be present is ④/⑤ and needs the upstream text; whether a
 * pointer is missing is ⑦ and needs the name universe. Both live in `verify`.
 *
 * @param {{ key: string, text: unknown, budget: number }} input
 * @returns {string[]} human-readable violations, empty when the entry is well formed
 */
export function checkEntryForm({ key, text, budget }) {
  /** @type {string[]} */
  const violations = [];
  if (typeof text !== 'string') {
    violations.push(`${key}: ① "text" must be a string`);
    return violations;
  }
  if (text === '') violations.push(`${key}: ① "text" is empty`);
  if (typeof budget === 'number' && text.length > budget) {
    violations.push(`${key}: ① length ${text.length} exceeds the budget ${budget}`);
  }
  if (/[\n\r\t]/.test(text)) violations.push(`${key}: ② contains a newline or tab`);
  if (text !== text.trim()) violations.push(`${key}: ② has leading or trailing whitespace`);
  if (text !== normalizeText(text)) violations.push(`${key}: ② is not whitespace-normalised`);
  if (text.includes('<') || text.includes('>')) {
    violations.push(`${key}: ③ contains an angle bracket, which would break the host envelope`);
  }
  if (text.includes('INVOKES:')) violations.push(`${key}: ⑥ still contains the INVOKES: section`);
  return violations;
}

/**
 * Invariants ④, ⑤ and ⑦ for one entry, which need the upstream text and the name universe.
 *
 * @param {{ key: string, text: string, upstream: string, names: { universe: Set<string>, included: Set<string> } }} input
 * @returns {{ violations: string[], droppedPointers: string[] }}
 */
export function checkEntryContent({ key, text, upstream, names }) {
  /** @type {string[]} */
  const violations = [];
  const upstreamUseFor = upstream.includes('USE FOR:');
  const upstreamDoNot = upstream.includes('DO NOT USE FOR:');
  if (text.includes('USE FOR:') !== upstreamUseFor) {
    violations.push(
      `${key}: ④ ${upstreamUseFor ? 'dropped the "USE FOR:" label the upstream text carries' : 'invented a "USE FOR:" label the upstream text does not carry'}`,
    );
  }
  if (text.includes('DO NOT USE FOR:') !== upstreamDoNot) {
    violations.push(
      `${key}: ⑤ ${upstreamDoNot ? 'dropped the "DO NOT USE FOR:" label the upstream text carries' : 'invented a "DO NOT USE FOR:" label the upstream text does not carry'}`,
    );
  }

  const source = classifyPointers(upstream, names);
  const authored = new Set(classifyPointers(text, names).required);
  const dropped = source.required.filter((target) => !authored.has(target));
  for (const target of dropped) violations.push(`${key}: ⑦ dropped the pointer to ${target}`);

  const sourceDangling = new Set(source.dangling);
  const authoredDangling = classifyPointers(text, names).dangling;
  return { violations, droppedPointers: authoredDangling.filter((target) => !sourceDangling.has(target)) };
}

/**
 * Load `data/descriptions.json` once, keep the entries that pass the formal invariants, and
 * record why any other entry was rejected.
 *
 * @param {object} input
 * @param {string} input.path - absolute path of the data file
 * @param {object | undefined} input.manifest - parsed `vendor/UPSTREAM.json`, when available
 * @param {number} [input.budget] - effective budget; defaults to the file's own `budget`
 * @returns {{
 *   entries: Map<string, { text: string, sourceChars: number, sourceSha256: string, authoredRevision: number }>,
 *   budget: number,
 *   diagnostics: string[],
 *   upstream: { tag?: string, commit?: string },
 *   license?: string,
 * }}
 */
export function loadDescriptions({ path, manifest, budget }) {
  /** @type {string[]} */
  const diagnostics = [];
  const entries = new Map();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      entries,
      budget: budget ?? DEFAULT_CATALOG_SUMMARY_BUDGET,
      diagnostics: [`cannot read ${path}: ${error.message}`],
      upstream: {},
    };
  }

  const fileBudget = typeof parsed.budget === 'number' ? parsed.budget : DEFAULT_CATALOG_SUMMARY_BUDGET;
  const effectiveBudget = typeof budget === 'number' ? budget : fileBudget;
  const upstream = parsed.upstream ?? {};
  const names = manifest === undefined ? undefined : nameUniverse(manifest);

  if (manifest !== undefined && (upstream.tag !== manifest.tag || upstream.commit !== manifest.commit)) {
    diagnostics.push(
      `descriptions were authored against ${String(upstream.tag)} (${String(upstream.commit).slice(0, 8)}) ` +
        `but the snapshot is ${String(manifest.tag)} (${String(manifest.commit).slice(0, 8)}); re-run the authoring pass`,
    );
  }
  if (effectiveBudget !== fileBudget) {
    diagnostics.push(
      `catalogSummaryBudget is ${effectiveBudget} but the authored data was written for ${fileBudget}; ` +
        'existing entries may now be truncated',
    );
  }

  const raw = parsed.entries ?? {};
  for (const [key, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry !== 'object') {
      diagnostics.push(`${key}: entry must be an object`);
      continue;
    }
    const violations = checkEntryForm({ key, text: entry.text, budget: effectiveBudget });
    if (violations.length > 0) {
      diagnostics.push(...violations, `${key}: falling back to the upstream description`);
      continue;
    }
    entries.set(key, {
      text: entry.text,
      sourceChars: typeof entry.sourceChars === 'number' ? entry.sourceChars : entry.text.length,
      sourceSha256: typeof entry.sourceSha256 === 'string' ? entry.sourceSha256 : '',
      authoredRevision: typeof entry.authoredRevision === 'number' ? entry.authoredRevision : 0,
    });
  }

  return { entries, budget: effectiveBudget, diagnostics, upstream, license: parsed.license, names };
}

/**
 * Decide the catalog description for one skill (§7.8).
 *
 * `authored` uses the reviewed text for covered skills and the upstream text for everything
 * else; `verbatim` is the safety valve that turns authoring off entirely. The return value
 * always records which of the three origins produced the string, so the status tool can
 * report how much of the catalog is actually reviewable.
 *
 * @param {object} input
 * @param {string} input.key - `<plugin>/<skill>`
 * @param {string} input.upstreamDescription
 * @param {{ entries: Map<string, { text: string }> }} input.descriptions
 * @param {'authored' | 'verbatim'} input.mode
 * @param {number} input.maxLength - effective downstream limit, after `cap()`
 * @returns {{ text: string, source: 'authored' | 'verbatim' | 'capped' }}
 */
export function resolveDescription({ key, upstreamDescription, descriptions, mode, maxLength }) {
  const entry = mode === 'authored' ? descriptions.entries.get(key) : undefined;
  if (entry === undefined) {
    return { text: cap(upstreamDescription, maxLength), source: 'verbatim' };
  }
  const text = cap(entry.text, maxLength);
  return { text, source: text === entry.text ? 'authored' : 'capped' };
}

/**
 * Coverage judgement of §7.2: too long for the downstream default, or carrying `INVOKES:`.
 *
 * @param {string} description
 * @returns {boolean}
 */
export function needsAuthoring(description) {
  return description.length > 500 || description.includes('INVOKES:');
}

/**
 * Read every skill of a source tree.
 *
 * @param {string} root - a snapshot root, an upstream checkout root, or a `plugins` directory
 * @returns {Array<{ key: string, plugin: string, name: string, description: string, userInvocable: boolean }>}
 */
export function readSkills(root) {
  const nested = join(root, 'plugins');
  const pluginsRoot = existsSync(nested) ? nested : root;
  /** @type {object[]} */
  const skills = [];
  for (const plugin of readdirSync(pluginsRoot, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!plugin.isDirectory()) continue;
    const skillsDir = join(pluginsRoot, plugin.name, 'skills');
    if (!existsSync(skillsDir)) continue;
    for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory() || !SKILL_NAME_PATTERN.test(entry.name)) continue;
      const required = readRequiredKeys(parseDocument(readFileSync(join(skillsDir, entry.name, 'SKILL.md'), 'utf8')).frontmatter);
      if (!required.ok) continue;
      skills.push({
        key: `${plugin.name}/${entry.name}`,
        plugin: plugin.name,
        name: entry.name,
        description: required.description,
        userInvocable: required.userInvocable,
      });
    }
  }
  return skills;
}

/**
 * The population every description gate works over: the development checkout when present,
 * otherwise the shipped snapshot.
 *
 * The checkout is preferred so a narrowed release range still validates its authored text
 * against the complete pinned ref — during P0 the snapshot holds three skills while the
 * baseline's 76 names must still be known.
 *
 * @returns {{ skills: object[], source: string }}
 */
export function readPopulation() {
  const checkout = checkoutFallback();
  if (existsSync(join(checkout, 'plugins'))) return { skills: readSkills(checkout), source: checkout };
  return { skills: readSkills(snapshotRoot), source: snapshotRoot };
}

/**
 * The authoring input pack `prepare` emits (§7.2, §7.6).
 *
 * @param {object} input
 * @param {object} input.manifest - parsed `vendor/UPSTREAM.json`
 * @param {object} input.data - parsed `data/descriptions.json`
 * @param {object[]} input.skills - population
 * @param {string} input.source - where the population came from
 * @returns {object} JSON-serialisable pack
 */
export function buildAuthoringPack({ manifest, data, skills, source }) {
  const names = nameUniverse(manifest);
  const includedNames = new Set();
  for (const plugin of manifest.includedPlugins ?? []) for (const skill of plugin.skills ?? []) includedNames.add(skill);
  const outOfRange = new Set();
  for (const plugin of manifest.outOfRangePlugins ?? []) for (const skill of plugin.skills ?? []) outOfRange.add(skill);

  const covered = skills.filter((skill) => needsAuthoring(skill.description));
  const entries = covered
    .filter((skill) => includedNames.has(skill.name))
    .map((skill) => {
      const classified = classifyPointers(skill.description, names);
      const existing = data.entries?.[skill.key];
      const lead = skill.description.split(/(?<=\.)\s/)[0] ?? skill.description;
      return {
        key: skill.key,
        chars: skill.description.length,
        sourceSha256: createHash('sha256').update(skill.description).digest('hex'),
        upstreamDescription: skill.description,
        requiresUseFor: skill.description.includes('USE FOR:'),
        requiresDoNotUseFor: skill.description.includes('DO NOT USE FOR:'),
        upstreamInvokes: extractInvokes(skill.description),
        pointersToKeep: classified.required,
        pointersDroppable: classified.dangling,
        leadSentence: lead.length > 200 ? `${lead.slice(0, 197)}...` : lead,
        currentText: typeof existing?.text === 'string' ? existing.text : null,
        authoredRevision: typeof existing?.authoredRevision === 'number' ? existing.authoredRevision : null,
      };
    });

  return {
    upstream: { tag: manifest.tag, commit: manifest.commit },
    budget: data.budget ?? DEFAULT_CATALOG_SUMMARY_BUDGET,
    downstreamDefaultMax: 500,
    rules: [
      'English, single line, no < or >, no INVOKES:, no newlines or tabs.',
      'Keep the exact "USE FOR:" / "DO NOT USE FOR:" labels when the upstream text has them; never add one it lacks.',
      'Keep every name in pointersToKeep. Names in pointersDroppable may be dropped but are reported.',
      'Never add a pointer to a name that is not in nameUniverse, and never add one the upstream text did not carry.',
      'Do not add or remove capability claims; reorganise, merge and delete filler only.',
      'When there is no label, keep the prose shape and preserve the routing signal inside it.',
    ],
    counts: {
      population: skills.length,
      authoringCovered: entries.length,
      authoringPending: entries.filter((entry) => entry.currentText === null).length,
      passThrough: skills.filter((skill) => includedNames.has(skill.name) && !needsAuthoring(skill.description)).length,
      outOfRange: covered.filter((skill) => outOfRange.has(skill.name)).length,
    },
    populationSource: source,
    nameUniverse: [...names.universe].sort(),
    includedNames: [...names.included].sort(),
    passThroughEntries: skills
      .filter((skill) => includedNames.has(skill.name) && !needsAuthoring(skill.description))
      .map((skill) => ({ key: skill.key, chars: skill.description.length })),
    entries,
  };
}

/** The `INVOKES:` line, preserved for `metadata.upstreamInvokes` after the catalog text drops it. */
export function extractInvokes(description) {
  const match = /INVOKES:([\s\S]*)$/.exec(description);
  return match === null ? null : `INVOKES:${match[1]}`.trim();
}

/**
 * The ten invariants of §7.5 and the five drift conditions of §7.7, as data.
 *
 * Returns violations rather than throwing so that a caller — the gate, or the activation
 * path — decides what a violation means. The gate exits non-zero; activation degrades the
 * single offending entry to upstream text.
 *
 * @param {object} input
 * @param {object} input.manifest - parsed `vendor/UPSTREAM.json`
 * @param {object} input.data - parsed `data/descriptions.json`
 * @param {object[]} [input.skills] - population; defaults to {@link readPopulation}
 * @param {string} [input.source] - label for the population source, for reporting
 * @param {boolean} [input.allowGaps] - report coverage gaps as warnings (narrowed P0 range)
 * @param {boolean} [input.checkSnapshot] - also verify the snapshot digest and line endings
 * @returns {{ problems: string[], warnings: string[], census: object, budget: number,
 *             population: { skills: object[], source: string }, counts: object }}
 */
export function verifyDescriptions({ manifest, data, skills, source, allowGaps = false, checkSnapshot = true }) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  const budget = typeof data.budget === 'number' ? data.budget : DEFAULT_CATALOG_SUMMARY_BUDGET;
  const names = nameUniverse(manifest);
  const population = skills === undefined ? readPopulation() : { skills, source: source ?? '(injected)' };

  // ⑩ provenance, and the snapshot all of it rests on.
  if (data.upstream?.tag !== manifest.tag || data.upstream?.commit !== manifest.commit) {
    problems.push(
      `⑩ upstream mismatch: authored data says ${String(data.upstream?.tag)}/${String(data.upstream?.commit).slice(0, 8)}, ` +
        `snapshot says ${manifest.tag}/${manifest.commit.slice(0, 8)}`,
    );
  }
  if (checkSnapshot) {
    const integrity = verifySnapshotIntegrity(manifest);
    if (!integrity.ok) {
      problems.push(
        integrity.error ?? `snapshot digest mismatch: recorded ${integrity.recorded}, actual ${integrity.actual}`,
      );
    }
    const endings = auditLineEndings();
    if (!endings.ok) problems.push(`snapshot has CRLF line endings: ${endings.offenders.join(', ')}`);
  }

  const includedNames = new Set();
  for (const plugin of manifest.includedPlugins ?? []) for (const skill of plugin.skills ?? []) includedNames.add(skill);
  const byKey = new Map(population.skills.map((skill) => [skill.key, skill]));
  const byName = new Map(population.skills.map((skill) => [skill.name, skill]));
  const entries = data.entries ?? {};

  // ⑧ coverage completeness, scoped to what the snapshot actually ships.
  const missing = [];
  for (const skill of population.skills) {
    if (!includedNames.has(skill.name)) continue;
    if (!needsAuthoring(skill.description)) continue;
    if (entries[skill.key] === undefined) missing.push(`${skill.key} (${skill.description.length} chars)`);
  }
  if (missing.length > 0) {
    const message = `⑧ ${missing.length} in-range skills fall under the coverage rule but have no entry`;
    if (allowGaps) warnings.push(`${message}:\n    ${missing.join('\n    ')}`);
    else problems.push(`${message}:\n    ${missing.join('\n    ')}`);
  }

  // ⑨ no orphans.
  for (const key of Object.keys(entries)) {
    const [plugin, name] = key.split('/');
    const candidate = byKey.get(key) ?? byName.get(name);
    if (candidate === undefined || (plugin !== undefined && candidate.plugin !== plugin)) {
      problems.push(`⑨ orphan entry ${key}: no such skill in the population`);
      continue;
    }
    if (!needsAuthoring(candidate.description)) {
      problems.push(`⑨ orphan entry ${key}: the skill is not in the coverage set`);
    }
  }

  /** @type {string[]} */
  const introducedPointers = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (entry === null || typeof entry !== 'object') {
      problems.push(`${key}: entry must be an object`);
      continue;
    }
    const skill = byKey.get(key) ?? byName.get(key.split('/')[1]);
    if (skill === undefined) continue;

    problems.push(...checkEntryForm({ key, text: entry.text, budget }));

    if (typeof entry.sourceChars === 'number' && entry.sourceChars !== skill.description.length) {
      problems.push(
        `${key}: drift — sourceChars is ${entry.sourceChars}, upstream is now ${skill.description.length}`,
      );
    }
    const digest = createHash('sha256').update(skill.description).digest('hex');
    if (typeof entry.sourceSha256 === 'string' && entry.sourceSha256 !== digest) {
      problems.push(
        `${key}: drift — sourceSha256 ${entry.sourceSha256.slice(0, 12)}… no longer matches ${digest.slice(0, 12)}…; rewrite this entry`,
      );
    }
    if (typeof entry.text !== 'string') continue;

    const content = checkEntryContent({ key, text: entry.text, upstream: skill.description, names });
    problems.push(...content.violations);
    for (const target of content.droppedPointers) introducedPointers.push(`${key} → ${target}`);
  }
  if (introducedPointers.length > 0) {
    problems.push(
      `⑦ authored text introduced pointers the upstream text did not carry (or that are not names):\n    ${introducedPointers.join('\n    ')}`,
    );
  }

  const census = censusPointers(
    population.skills
      .filter((skill) => includedNames.has(skill.name))
      .map((skill) => ({ key: skill.key, description: skill.description })),
    names,
  );

  return {
    problems,
    warnings,
    census,
    budget,
    population,
    counts: {
      population: population.skills.length,
      entries: Object.keys(entries).length,
      gaps: missing.length,
    },
  };
}
