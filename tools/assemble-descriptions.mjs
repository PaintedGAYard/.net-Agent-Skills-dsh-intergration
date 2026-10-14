#!/usr/bin/env node
/**
 * Assemble authored catalog descriptions from clause specs.
 *
 *   node tools/descriptions.mjs prepare                 # writes .authoring/descriptions-input.json
 *   node tools/assemble-descriptions.mjs <specs.json>   # writes data/descriptions.json
 *   node tools/descriptions.mjs verify                  # the gate that judges the result
 *
 * P1 authored 53 entries this way, and the reason to keep the mechanism is the maintenance cost §7.7
 * predicts: an upstream tag that moves rewrites part of the authored surface, every time.
 *
 * `specs.json` is hand-written and says *what* to say — a prefix sentence, a clause list for each
 * label, and which clauses upstream obliges the text to keep as pointers. This module only decides
 * *how much of it fits*: clauses are added in the author's priority order and the droppable ones are
 * dropped, cheapest first, until the text is inside the budget. Nothing is ever dropped silently:
 * mandatory clauses that do not fit make the entry a rejection, and the run refuses to write at all.
 *
 * Entry format (see `.authoring/*-specs.json` for real examples):
 *
 *   {
 *     "kind": "labels" | "prose",
 *     "prefix": "one sentence naming what the skill is for",
 *     "use":  ["clause", …],           // labels shape: the USE FOR list
 *     "pointers": ["x (use other-skill)", …],   // mandatory, appear in DO NOT USE FOR
 *     "extras": ["clause", …],         // droppable negatives
 *     "body": ["clause", …],           // prose shape instead of `use`
 *     "negatives": ["clause", …],      // prose shape; any clause containing "(use " is mandatory
 *     "bodyLead": "Use when:",          // optional; default "Catches"
 *     "negativeLead": "Do not use for:" // optional; default "Not for …"
 *   }
 *
 * The `kind` matters more than it looks. Invariant ④ is *bidirectional*: a skill whose upstream text
 * has no `USE FOR:` label must not gain one, so the prose shape exists for exactly those entries.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The authoring budget of §7.3, in characters. */
export const BUDGET = 320;

/** The form upstream writes a pointer to another skill in, and therefore what is mandatory. */
const POINTER_FORM = '(use ';

/** `prefix USE FOR: a, b. DO NOT USE FOR: c, d.` */
export function renderWithLabels(spec, use, negatives) {
  const head = `${spec.prefix} USE FOR: ${use.join(', ')}.`;
  return negatives.length === 0 ? head : `${head} DO NOT USE FOR: ${negatives.join(', ')}.`;
}

/** `prefix Catches a, b. Not for c or d.` — the shape upstream uses when it has no labels. */
export function renderAsProse(spec, body, negatives) {
  const bodyLead = spec.bodyLead ?? 'Catches';
  const head = body.length === 0 ? spec.prefix : `${spec.prefix} ${bodyLead} ${body.join(', ')}.`;
  if (negatives.length === 0) return head;
  if (spec.negativeLead !== undefined) return `${head} ${spec.negativeLead} ${negatives.join(', ')}.`;
  const tail = negatives.length === 1 ? negatives[0] : `${negatives.slice(0, -1).join(', ')} or ${negatives.at(-1)}`;
  return `${head} Not for ${tail}.`;
}

/**
 * The ordered clause list of one entry, each marked mandatory or droppable.
 *
 * Pointer clauses are mandatory in **both** shapes. That is the rule this module exists to protect, and
 * the prose shape has no separate `pointers` field, so the marker is derived from the `(use …)` form.
 * Dropping one silently was a real bug: a prose entry lost its one required pointer and the run still
 * passed every check but the pointer gate.
 *
 * The first clause of each list is mandatory too: `USE FOR:` followed by nothing would satisfy the
 * letter of invariant ④ while telling a reader nothing.
 */
export function clauses(spec) {
  const items = [];
  const bodySource = spec.kind === 'prose' ? (spec.body ?? []) : (spec.use ?? []);
  bodySource.forEach((text, index) => items.push({ text, group: 'body', mandatory: index === 0 }));

  const negatives = spec.kind === 'prose' ? (spec.negatives ?? []) : [...(spec.pointers ?? []), ...(spec.extras ?? [])];
  const pointerCount = (spec.pointers ?? []).length;
  negatives.forEach((text, index) => {
    const isPointer = spec.kind === 'prose' ? text.includes(POINTER_FORM) : index < pointerCount;
    items.push({ text, group: 'negative', mandatory: isPointer });
  });
  // A negative list keeps at least one entry. The prose shape has no pointer field to guarantee that,
  // so the first non-pointer negative becomes mandatory when nothing else is.
  if (!items.some((item) => item.group === 'negative' && item.mandatory)) {
    const first = items.find((item) => item.group === 'negative');
    if (first !== undefined) first.mandatory = true;
  }
  return items;
}

/** Render one entry from its surviving clauses. */
export function renderEntry(spec, items) {
  const body = items.filter((item) => item.group === 'body').map((item) => item.text);
  const negatives = items.filter((item) => item.group === 'negative').map((item) => item.text);
  return spec.kind === 'prose' ? renderAsProse(spec, body, negatives) : renderWithLabels(spec, body, negatives);
}

/** Fit one entry into the budget, dropping droppable clauses until it fits. */
export function fitEntry(spec, budget = BUDGET) {
  const items = clauses(spec);
  let text = renderEntry(spec, items);
  // Body clauses go first (they are examples), then negatives that carry no pointer. Mandatory clauses
  // survive, so a mandatory set that cannot fit becomes a rejection rather than a quiet truncation.
  while (text.length > budget) {
    const droppable = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.mandatory);
    if (droppable.length === 0) break;
    const bodyFirst = droppable.filter(({ item }) => item.group === 'body');
    const victim = bodyFirst.length > 0 ? bodyFirst.at(-1) : droppable.at(-1);
    items.splice(victim.index, 1);
    text = renderEntry(spec, items);
  }
  return text;
}

/**
 * Judge one fitted text against the pack entry it is written for.
 *
 * These are the mechanical parts of §7.5 that a fitted string could still get wrong: the budget, the
 * characters the catalog cannot carry, the `INVOKES:` section, the two label presences in **both**
 * directions, and every pointer the pack says must survive.
 *
 * @returns {string[]} violations, empty when the text is publishable
 */
export function validateDraft(text, entry, budget = BUDGET) {
  if (entry === undefined) return ['no entry in the authoring pack'];
  const problems = [];
  if (text.length > budget) problems.push(`over budget (${text.length} > ${budget})`);
  if (/[<>\n\t]/.test(text)) problems.push('contains a character the catalog cannot carry');
  if (text.includes('INVOKES:')) problems.push('still contains an INVOKES: section');
  if (entry.requiresUseFor !== text.includes('USE FOR:')) problems.push('USE FOR: presence does not match upstream');
  if (entry.requiresDoNotUseFor !== text.includes('DO NOT USE FOR:')) {
    problems.push('DO NOT USE FOR: presence does not match upstream');
  }
  for (const pointer of entry.pointersToKeep ?? []) {
    if (!text.includes(pointer)) problems.push(`lost the pointer to ${pointer}`);
  }
  return problems;
}

/**
 * Assemble every spec, and validate each one against its pack entry.
 *
 * @returns {{ drafts: Record<string, string>, rejected: Array<{ key: string, problems: string[] }> }}
 */
export function assembleDrafts(specs, pack, budget = BUDGET) {
  const byKey = new Map((pack.entries ?? []).map((entry) => [entry.key, entry]));
  const drafts = {};
  const rejected = [];
  for (const [key, spec] of Object.entries(specs)) {
    const text = fitEntry(spec, budget);
    const problems = validateDraft(text, byKey.get(key), budget);
    if (problems.length > 0) rejected.push({ key, problems });
    else drafts[key] = text;
  }
  return { drafts, rejected };
}

/**
 * Merge accepted drafts into the authored data, as `data/descriptions.json` holds them.
 *
 * The `sourceChars` / `sourceSha256` come from the pack, never from the spec: they are the fingerprint
 * of the upstream text the entry was written against, and §7.7's drift check is only as good as they are.
 */
export function mergeEntries(data, drafts, pack) {
  const byKey = new Map((pack.entries ?? []).map((entry) => [entry.key, entry]));
  const entries = { ...data.entries };
  for (const [key, text] of Object.entries(drafts)) {
    const entry = byKey.get(key);
    entries[key] = { text, sourceChars: entry.chars, sourceSha256: entry.sourceSha256, authoredRevision: 1 };
  }
  return {
    ...data,
    entries: Object.fromEntries(Object.entries(entries).sort(([left], [right]) => (left < right ? -1 : 1))),
  };
}

/** Parse argv into `{ specs, input, data, dryRun }`; returns an error string instead of throwing. */
export function parseArgv(argv) {
  const options = { specs: undefined, input: '.authoring/descriptions-input.json', data: 'data/descriptions.json', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--input' || argument === '--data') {
      const value = argv[index + 1];
      if (value === undefined) return `--${argument.slice(2)} needs a value`;
      index += 1;
      if (argument === '--input') options.input = value;
      else options.data = value;
    } else if (argument.startsWith('-')) return `unrecognised argument ${JSON.stringify(argument)}`;
    else if (options.specs === undefined) options.specs = argument;
    else return `unexpected extra argument ${JSON.stringify(argument)}`;
  }
  if (options.specs === undefined) return '<specs.json> is required';
  return options;
}

function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (typeof parsed === 'string') {
    process.stderr.write(`assemble-descriptions: ${parsed}\n`);
    process.stderr.write(
      'usage: node tools/assemble-descriptions.mjs <specs.json> [--input <pack.json>] [--data <descriptions.json>] [--dry-run]\n',
    );
    process.exitCode = 2;
    return;
  }
  let specs;
  let pack;
  let data;
  try {
    specs = JSON.parse(readFileSync(parsed.specs, 'utf8'));
    pack = JSON.parse(readFileSync(parsed.input, 'utf8'));
    data = JSON.parse(readFileSync(parsed.data, 'utf8'));
  } catch (error) {
    process.stderr.write(`assemble-descriptions: cannot read its input: ${error.message}\n`);
    process.stderr.write(`hint: run 'node tools/descriptions.mjs prepare' first to write ${parsed.input}\n`);
    process.exitCode = 2;
    return;
  }

  const { drafts, rejected } = assembleDrafts(specs, pack);
  for (const { key, problems } of rejected) process.stdout.write(`REJECT ${key}: ${problems.join('; ')}\n`);
  if (rejected.length > 0) {
    process.stdout.write(`refusing to write: ${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'} failed validation\n`);
    process.exitCode = 1;
    return;
  }

  for (const [key, text] of Object.entries(drafts)) {
    process.stdout.write(`${String(text.length).padStart(4)}  ${key}\n      ${text}\n\n`);
  }
  if (parsed.dryRun) {
    process.stdout.write(`--dry-run: nothing written (${Object.keys(drafts).length} entries would be merged)\n`);
    return;
  }
  const merged = mergeEntries(data, drafts, pack);
  writeFileSync(parsed.data, `${JSON.stringify(merged, null, 2)}\n`);
  process.stdout.write(`wrote ${parsed.data}: ${Object.keys(merged.entries).length} authored entries\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
