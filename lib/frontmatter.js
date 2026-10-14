/**
 * Restricted frontmatter parser for the upstream `.NET Agent Skills` snapshot.
 *
 * Scope is deliberately narrow: it supports exactly the shapes the pinned upstream
 * baseline actually uses (see doc/spec.md §5), and it throws on anything else.
 * A permissive YAML dependency would silently accept shapes whose folding rules we
 * have never validated, and the `sourceSha256` contract in §7.3 depends on this
 * parse being exactly reproducible.
 *
 * Supported, and each of these is load-bearing:
 *   key: value            bare plain scalar
 *   key: "value"          double-quoted scalar, outer quotes stripped
 *   key: 'value'          single-quoted scalar, outer quotes stripped
 *   key: >                folded block scalar, continuation lines indented
 *   key: >-               folded block scalar without the trailing newline
 *   key:                  JSON-ish flow collection (used only by plugin.json)
 *
 * Rejected on purpose: `|`, `|-`, nested mappings, sequences, anchors, aliases,
 * tags, multi-document streams, duplicate keys.
 *
 * Line endings: CRLF input parses, because a CRLF file must never make a skill
 * disappear. The parser never writes anything back — §5.3 forbids rewriting.
 */

/** Thrown for any input outside the supported subset. */
export class FrontmatterError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

/** Skill-name grammar, identical to the host's `SKILL_NAME` (spec §5.4). */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The single whitespace normalisation used by every consumer of upstream text.
 *
 * `sourceSha256` (§7.3), description authoring (§7.4) and the runtime all compare
 * text through this function, so that the newline differences folding can produce
 * are unobservable (§5.1).
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/** @param {string} value @returns {boolean} */
export function isSkillName(value) {
  return typeof value === 'string' && SKILL_NAME_PATTERN.test(value);
}

/**
 * Split a document into its frontmatter block and body.
 *
 * The block must open on the very first line: a leading BOM or blank line means
 * "no frontmatter", which is a distinguishable failure rather than a silent one.
 *
 * @param {string} text
 * @returns {{ block: string, body: string }}
 * @throws {FrontmatterError} when the document has no terminated frontmatter block
 */
export function splitFrontmatter(text) {
  if (typeof text !== 'string') throw new FrontmatterError('frontmatter input must be a string');
  const lf = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const normalized = lf.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new FrontmatterError('document does not start with a "---" frontmatter delimiter');
  }
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '---' || line.trim() === '...') {
      end = index;
      break;
    }
  }
  if (end < 0) throw new FrontmatterError('frontmatter block is not terminated by "---"');
  return {
    block: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
  };
}

/**
 * Parse one frontmatter block into raw string values.
 *
 * Keys are returned in document order. Unknown keys are kept verbatim: §5.2 requires
 * that upstream adding a key never loses information and never hides a skill.
 *
 * @param {string} block - block text without the `---` delimiters
 * @returns {Map<string, string>}
 * @throws {FrontmatterError} on any unsupported shape
 */
export function parseFrontmatterBlock(block) {
  const lines = block.replace(/\r\n/g, '\n').split('\n');
  /** @type {Map<string, string>} */
  const entries = new Map();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    if (line.trimStart() !== line) {
      throw new FrontmatterError(`unexpected indented line outside a block scalar: ${JSON.stringify(line)}`);
    }
    const colon = findKeyColon(line);
    if (colon < 0) {
      throw new FrontmatterError(`frontmatter line is not a "key: value" pair: ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, colon);
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
      throw new FrontmatterError(`unsupported frontmatter key ${JSON.stringify(key)}`);
    }
    if (entries.has(key)) throw new FrontmatterError(`duplicate frontmatter key ${JSON.stringify(key)}`);
    const rest = line.slice(colon + 1).replace(/^[ \t]+/, '');
    const inline = rest.trimEnd();

    if (inline === '>' || inline === '>-') {
      const { value, next } = readFoldedBlock(lines, index + 1, inline === '>-');
      entries.set(key, value);
      index = next;
      continue;
    }
    if (inline.startsWith('|')) {
      throw new FrontmatterError(`literal block scalars are not supported (key ${JSON.stringify(key)})`);
    }
    if (inline === '') {
      throw new FrontmatterError(`key ${JSON.stringify(key)} has an empty value`);
    }
    if (inline.startsWith('&') || inline.startsWith('*') || inline.startsWith('!')) {
      throw new FrontmatterError(`anchors, aliases and tags are not supported (key ${JSON.stringify(key)})`);
    }
    if (inline.startsWith('- ') || inline === '-') {
      throw new FrontmatterError(`sequence values are not supported (key ${JSON.stringify(key)})`);
    }
    if (inline.startsWith('{') || inline.startsWith('[')) {
      entries.set(key, normalizeJsonish(inline, key));
      index += 1;
      continue;
    }
    entries.set(key, stripQuotes(inline, key));
    index += 1;
  }

  return entries;
}

/**
 * Parse a complete `SKILL.md` document.
 *
 * @param {string} text - full file text
 * @returns {{ frontmatter: Map<string, string>, body: string }}
 * @throws {FrontmatterError}
 */
export function parseDocument(text) {
  const { block, body } = splitFrontmatter(text);
  return { frontmatter: parseFrontmatterBlock(block), body };
}

/**
 * Validate the two keys the provider requires, without throwing (§5.4).
 *
 * A skill that fails here is skipped and reported in diagnostics, so that
 * "the skill is gone" and "the skill is malformed" stay distinguishable.
 *
 * @param {Map<string, string>} frontmatter
 * @returns {{ ok: true, name: string, description: string, userInvocable: boolean }
 *          | { ok: false, reason: string }}
 */
export function readRequiredKeys(frontmatter) {
  const name = frontmatter.get('name');
  if (name === undefined) return { ok: false, reason: 'missing required frontmatter key "name"' };
  if (!isSkillName(name)) {
    return { ok: false, reason: `frontmatter name ${JSON.stringify(name)} does not match the skill-name grammar` };
  }
  const description = frontmatter.get('description');
  if (description === undefined) return { ok: false, reason: 'missing required frontmatter key "description"' };
  const normalized = normalizeText(description);
  if (normalized === '') return { ok: false, reason: 'frontmatter description is empty' };

  let userInvocable = true;
  const raw = frontmatter.get('user-invocable');
  if (raw !== undefined) {
    if (raw === 'false') userInvocable = false;
    else if (raw === 'true') userInvocable = true;
    else return { ok: false, reason: `frontmatter user-invocable must be true or false, got ${JSON.stringify(raw)}` };
  }

  return { ok: true, name, description: normalized, userInvocable };
}

/**
 * Unknown frontmatter keys, verbatim (§5.2).
 *
 * @param {Map<string, string>} frontmatter
 * @returns {Record<string, string>} empty object when every key is known
 */
export function unknownKeys(frontmatter) {
  /** @type {Record<string, string>} */
  const rest = {};
  for (const [key, value] of frontmatter) {
    if (key === 'name' || key === 'description' || key === 'user-invocable') continue;
    rest[key] = value;
  }
  return rest;
}

/**
 * Locate the `:` that separates key from value.
 *
 * The first colon followed by whitespace or end-of-line wins, so an unquoted value
 * may itself contain a colon (`description: Use https://example.com:8080`).
 *
 * @param {string} line
 * @returns {number} index of the colon, or -1
 */
function findKeyColon(line) {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== ':') continue;
    const next = line[index + 1];
    if (next === undefined || next === ' ' || next === '\t') return index;
  }
  return -1;
}

/**
 * Fold a block scalar: continuation lines trimmed and joined with one space,
 * an internal blank line yielding a single `\n` (§5.1).
 *
 * Included lines must be indented more than the key, or blank. A non-blank line at
 * the key's own indentation ends the block and is re-examined as a new key.
 *
 * @param {string[]} lines
 * @param {number} start
 * @param {boolean} stripTrailingNewline - `>-` versus `>`
 * @returns {{ value: string, next: number }}
 */
function readFoldedBlock(lines, start, stripTrailingNewline) {
  const collected = [];
  let index = start;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      collected.push('');
      continue;
    }
    if (line.trimStart() !== line) {
      collected.push(line.trim());
      continue;
    }
    break;
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();

  const parts = [];
  let pendingBreak = false;
  for (const line of collected) {
    if (line === '') {
      pendingBreak = true;
      continue;
    }
    if (parts.length > 0) parts.push(pendingBreak ? '\n' : ' ');
    parts.push(line);
    pendingBreak = false;
  }
  const joined = parts.join('');
  return { value: stripTrailingNewline ? joined : `${joined}\n`, next: index };
}

/**
 * Strip exactly one outer pair of quotes, and only when both ends carry it (§5.1).
 *
 * This is the step that makes the 21 double-quoted upstream descriptions measure two
 * characters shorter, which `sourceSha256` is computed over.
 *
 * @param {string} value
 * @param {string} key
 * @returns {string}
 */
function stripQuotes(value, key) {
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    if (value.length === 1) throw new FrontmatterError(`key ${JSON.stringify(key)} has an unbalanced quote`);
    return value.slice(1, -1);
  }
  if (first === '"' || first === "'") {
    throw new FrontmatterError(`key ${JSON.stringify(key)} has an unbalanced quote`);
  }
  return value;
}

/**
 * Parse an inline JSON object or array, preserving it as compact JSON text.
 *
 * Only `plugin.json` files use this (`"skills": ["./skills/"]`). It exists so that
 * manhandling arrays never turns into a silent no-op; it is not a YAML flow parser.
 *
 * @param {string} text
 * @param {string} key
 * @returns {string}
 */
function normalizeJsonish(text, key) {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch (error) {
    throw new FrontmatterError(
      `key ${JSON.stringify(key)} looks like a flow collection but is not valid JSON: ${error.message}`,
    );
  }
}
