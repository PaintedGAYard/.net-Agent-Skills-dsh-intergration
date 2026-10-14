/**
 * Skill-pointer conservation (doc/spec.md §7.6).
 *
 * Upstream descriptions route to each other by *name*, and the authored description of a
 * covered skill must not drop a pointer to a skill we actually ship. Finding those
 * pointers is deliberately two steps, because one step cannot be both safe and precise:
 *
 *   1. Extract every plausible kebab-case token from a pointer position. Extraction is
 *      intentionally loose — its only job is to not miss a real pointer.
 *   2. Classify each token against the universe of real skill names. Precision comes from
 *      that lookup, never from the regex.
 *
 * This is what lets `(use Grid or StackLayout)` and
 * `(use Python with PyTorch/TensorFlow, then export to ONNX for .NET inference)` fall out
 * as English prose without any natural-language processing: neither token is a skill name.
 *
 * `prepare` and `verify` both call {@link extractPointers}, so the "must keep" list shown
 * to a human and the list checked mechanically can never drift apart.
 */

import { normalizeText } from './frontmatter.js';

/** Words that describe *how* to use a pointer rather than naming another skill. */
const POINTER_QUALIFIERS = new Set([
  'all',
  'also',
  'and',
  'after',
  'as',
  'at',
  'baselining',
  'before',
  'both',
  'first',
  'for',
  'from',
  'if',
  'in',
  'instead',
  'it',
  'its',
  'multiple',
  'needed',
  'of',
  'only',
  'or',
  'skill',
  'skills',
  'that',
  'the',
  'then',
  'these',
  'this',
  'those',
  'them',
  'to',
  'together',
  'when',
  'with',
]);

/**
 * Kebab-case token shape, anchored so a match cannot begin inside a longer word.
 *
 * The anchor is not cosmetic. Descriptions contain `PyTorch/TensorFlow`,
 * `Microsoft.Maui.Controls.Maps` and `Grid or StackLayout`; without a leading boundary the
 * scan happily reports `ython`, `ens or`, `rid` and `aps` as candidate skill names. Those
 * fragments are not in the name universe, so they would be harmless — but a fragment that
 * happened to collide with a real skill name would invent a pointer obligation out of an
 * English sentence. Classification should never be handed noise it must filter.
 */
const TOKEN = /(?<![A-Za-z0-9-])[a-z0-9]+(?:-[a-z0-9]+)*/g;

/**
 * The `… instead` form, which may close a clause (`(use X instead)`) or end a sentence
 * (`use X instead.`). The trailing lookahead is what keeps the adverb itself from being
 * read as a name.
 */
const INSTEAD = /(?<![a-z0-9.])([a-z0-9]+(?:-[a-z0-9]+)*) instead(?![a-z0-9-])/g;

/**
 * Every pointer-ish token in one description, in first-appearance order.
 *
 * Applies to the whole description: pointers inside a `DO NOT USE FOR:` clause are
 * redirects and count exactly as much as pointers in the positive clause (§2.8).
 *
 * @param {string} description - normalised upstream description
 * @returns {string[]} unique candidate tokens, most plausible first
 */
export function extractPointerTokens(description) {
  const text = normalizeText(description);
  /** @type {string[]} */
  const tokens = [];
  const seen = new Set();
  const push = (token) => {
    if (token === '' || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };

  // `(use X and Y first)` — the whole parenthesised clause, so no trailing word can hide
  // a second name.
  for (const match of text.matchAll(/\(use ([^)]*)\)/g)) {
    const clause = match[1];
    TOKEN.lastIndex = 0;
    let found;
    while ((found = TOKEN.exec(clause)) !== null) {
      const token = found[0];
      if (POINTER_QUALIFIERS.has(token)) continue;
      push(token);
    }
  }

  // `use X instead` / `— use X instead`
  for (const match of text.matchAll(INSTEAD)) {
    if (POINTER_QUALIFIERS.has(match[1])) continue;
    push(match[1]);
  }

  return tokens;
}

/**
 * Name universe for pointer classification (spec §3.1).
 *
 * `U` is every skill name of the pinned upstream ref, and `V` is the subset this release
 * actually ships. Both come from `vendor/UPSTREAM.json`, so even a narrowed snapshot
 * range can tell a pointer to a real-but-excluded skill apart from English prose.
 *
 * `V` is taken from `upstreamInventory.skills` minus the excluded plugins, not from
 * `includedPlugins` alone, because during P0 the snapshot range is a single plugin while
 * the baseline's full name set still has to be known — that is the whole reason §3.1
 * mandates a complete `upstreamInventory`.
 *
 * @param {object} manifest - parsed `vendor/UPSTREAM.json`
 * @returns {{ universe: Set<string>, included: Set<string> }}
 */
export function nameUniverse(manifest) {
  const universe = new Set();
  const included = new Set();
  const excluded = new Set();
  for (const plugin of manifest.excludedPlugins ?? []) {
    for (const skill of plugin.skills ?? []) excluded.add(skill);
  }
  for (const plugin of manifest.includedPlugins ?? []) {
    for (const skill of plugin.skills ?? []) included.add(skill);
  }
  for (const skill of manifest.upstreamInventory?.skills ?? []) {
    universe.add(skill);
    if (!excluded.has(skill)) included.add(skill);
  }
  for (const plugin of manifest.excludedPlugins ?? []) {
    for (const skill of plugin.skills ?? []) universe.add(skill);
  }
  return { universe, included };
}

/**
 * Classify one description's pointers.
 *
 * @param {string} description
 * @param {{ universe: Set<string>, included: Set<string> }} names
 * @returns {{
 *   required: string[],   // point at a skill this release ships: the authored text must keep them
 *   dangling: string[],   // point at a real upstream skill outside this range: droppable, never silent
 *   prose: string[],      // not skill names at all: English, no obligation
 * }}
 */
export function classifyPointers(description, names) {
  const required = [];
  const dangling = [];
  const prose = [];
  for (const token of extractPointerTokens(description)) {
    if (names.included.has(token)) required.push(token);
    else if (names.universe.has(token)) dangling.push(token);
    else prose.push(token);
  }
  return { required, dangling, prose };
}

/**
 * Whole-set pointer census, grouped by target (spec §2.8).
 *
 * @param {Array<{ key: string, description: string }>} skills
 * @param {{ universe: Set<string>, included: Set<string> }} names
 * @returns {{
 *   byTarget: Map<string, string[]>,
 *   required: Map<string, string[]>,
 *   dangling: Map<string, string[]>,
 *   prose: Set<string>,
 * }}
 */
export function censusPointers(skills, names) {
  const byTarget = new Map();
  const required = new Map();
  const dangling = new Map();
  const prose = new Set();
  for (const skill of skills) {
    const classified = classifyPointers(skill.description, names);
    for (const token of classified.required) {
      if (!byTarget.has(token)) byTarget.set(token, []);
      byTarget.get(token).push(skill.key);
      if (!required.has(token)) required.set(token, []);
      required.get(token).push(skill.key);
    }
    for (const token of classified.dangling) {
      if (!dangling.has(token)) dangling.set(token, []);
      dangling.get(token).push(skill.key);
    }
    for (const token of classified.prose) prose.add(token);
  }
  return { byTarget, required, dangling, prose };
}
