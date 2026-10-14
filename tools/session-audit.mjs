#!/usr/bin/env node
/**
 * Audit a session log for the two things a plugin's own tests cannot see.
 *
 * The field test (2026-10-14, `drafting/issues/`) established that a model's report of "which tools
 * do I have, and which paths did I touch" is not usable as evidence: it omitted a tool it had used
 * nine times, and it concluded that no diagnostic tool exists while holding one that the host resolves
 * by name. The session log does not have that problem — it is the host's own record of the request
 * headers and the calls — so this is where those two questions are answered instead.
 *
 *   node tools/session-audit.mjs --session <session.v4.jsonl.zstd> [--root <dir>] [--allow <prefix>] [--json]
 *
 * It answers:
 *   1. Which tools were declared to the model, and which of them were deferred (`deferLoading`)?
 *   2. Was any deferred tool actually called, and was any call made to a name that was never declared?
 *   3. Was any tool-change block (`tool-addition` / `tool-removal`) ever announced?
 *   4. Did the session touch any path outside the root — including `..`-relative ones?
 *
 * Exit code 0 means no path escaped the root; 1 means one did (and `--allow` did not cover it); 2 means
 * the invocation or the log was unusable. Nothing here modifies anything, in the log or elsewhere.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as zlib from 'node:zlib';

import { selectAdapter } from '../lib/platform/index.js';

/**
 * Argument keys whose values the host actually uses to touch the file system.
 *
 * The verdict rides on these and only these. A first version scanned every string argument and
 * produced 488 "escapes" for one real session — almost all of them regex literals and synthetic
 * fixtures inside `edit`'s `old_string`/`new_string`. A leak check with that false-positive rate is
 * worse than none, because it trains the reader to ignore it.
 */
const PATH_KEYS = new Set([
  'file_path',
  'path',
  'paths',
  'cwd',
  'workdir',
  'directory',
  'root',
  'pattern',
  'notebook_path',
  'log_file',
]);

/** Keys that are never a path, whatever they contain. */
const NEVER_PATH_KEYS = new Set([
  'description',
  'content',
  'code',
  'regex',
  'old_string',
  'new_string',
  'text',
  'note',
  'message',
  'arguments',
  'name',
  'target',
]);

/** `grep.pattern` is a regular expression while `glob.pattern` is a path, so the tool disambiguates. */
const REGEX_KEYS_BY_TOOL = new Map([['grep', new Set(['pattern'])]]);

/** Free-text keys that are reported as mentions but never decide the verdict. */
const MENTION_KEYS = new Set(['command']);

/**
 * Read a session log, compressed or not.
 *
 * `zstdDecompressSync` is newer than this package's declared Node floor, so its absence is handled
 * rather than assumed: an uncompressed `.jsonl` log is read as text, and a `.zstd` one without the
 * API is reported as unreadable instead of crashing the audit.
 *
 * @param {string} path
 * @returns {string}
 */
export function readSession(path) {
  const bytes = readFileSync(path);
  if (!path.endsWith('.zstd')) return bytes.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('this Node build has no zstd support; decompress the log first or use a plain .jsonl');
  }
  return zlib.zstdDecompressSync(bytes).toString('utf8');
}

/** Parse JSONL session text into records, skipping anything unparseable. */
export function parseSession(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A truncated final line is normal for a log being written while it is read.
    }
  }
  return records;
}

/**
 * Every tool declaration the host committed, newest revision last.
 *
 * Each revision also answers the discoverability question, because the header is the only place where
 * the answer is a fact rather than an inference: a deferred tool is absent from the model's declaration
 * set, so it is discoverable only if the description of a tool that *is* declared names it
 * (`drafting/issues/0001`). The declarations carry their descriptions, so this needs no extra access.
 *
 * @param {object[]} records
 * @returns {{
 *   revisions: Array<{ seq: number, tools: Array<{ name: string, deferred: boolean }>, unreachable: string[] }>,
 *   added: string[],
 *   removed: string[],
 *   namedBy: Map<string, string[]>,
 * }}
 */
export function declaredTools(records) {
  const revisions = [];
  for (const record of records) {
    if (record?.type !== 'request/header') continue;
    const tools = record.data?.header?.tools ?? [];
    revisions.push({
      seq: record.seq,
      tools: tools.map((tool) => ({ name: tool.name, deferred: tool.deferLoading === true })),
      unreachable: unreachableDeferred(tools),
    });
  }
  const added = new Set();
  const removed = new Set();
  for (let index = 1; index < revisions.length; index += 1) {
    const before = new Set(revisions[index - 1].tools.map((tool) => tool.name));
    const after = new Set(revisions[index].tools.map((tool) => tool.name));
    for (const name of after) if (!before.has(name)) added.add(name);
    for (const name of before) if (!after.has(name)) removed.add(name);
  }
  return { revisions, added: [...added].sort(), removed: [...removed].sort(), namedBy: namingDeclarations(records) };
}

/** For each deferred tool of the latest revision, which declared tool names it. */
function namingDeclarations(records) {
  const tools = [...records].reverse().find((record) => record?.type === 'request/header')?.data?.header?.tools ?? [];
  const namedBy = new Map();
  for (const tool of tools) {
    if (tool.deferLoading !== true) continue;
    namedBy.set(
      tool.name,
      tools
        .filter((other) => other.name !== tool.name && typeof other.description === 'string')
        .filter((other) => other.description.includes(tool.name))
        .map((other) => other.name),
    );
  }
  return namedBy;
}

/** Deferred tools no other declaration mentions — callable, but unknowable to the model. */
function unreachableDeferred(tools) {
  return tools
    .filter((tool) => tool.deferLoading === true)
    .filter(
      (tool) =>
        !tools.some(
          (other) =>
            other.name !== tool.name &&
            typeof other.description === 'string' &&
            other.description.includes(tool.name),
        ),
    )
    .map((tool) => tool.name);
}

/** The `tool-addition` / `tool-removal` blocks the host announced to the model. */
export function toolChangeBlocks(records) {
  const additions = [];
  const removals = [];
  for (const record of records) {
    if (record?.type !== 'developer/message') continue;
    for (const block of record.data?.message?.content ?? []) {
      if (block?.type === 'tool-addition') additions.push(block.toolName);
      else if (block?.type === 'tool-removal') removals.push(block.toolName);
    }
  }
  return { additions, removals };
}

/** Every tool call, with its arguments parsed when they are JSON. */
export function toolCalls(records) {
  const calls = [];
  for (const record of records) {
    if (record?.type !== 'tool/call') continue;
    let args = record.data?.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        // Keep the raw text: an unparseable argument string still gets scanned for paths.
      }
    }
    calls.push({ seq: record.seq, name: record.data?.name ?? '(unnamed)', args });
  }
  return calls;
}

/**
 * Path candidates in one string: any token that contains a separator.
 *
 * Being deliberately loose about *what* a path is costs nothing here, because the classification is
 * what decides inside versus outside — a token that contains no separator cannot escape anywhere.
 * Being loose matters in the other direction: an anchored pattern that only matched drive letters and
 * leading slashes missed `other/b.cs` and mis-read `../sibling/c.cs` as `/sibling/c.cs`, so a relative
 * escape was reported with the wrong text and a plain relative read was not counted at all.
 *
 * URLs are removed first: `https://api.nuget.org/v3/index.json` contains something that looks exactly
 * like a path, and reporting a NuGet feed as an out-of-root read would be a false accusation.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function pathCandidates(text) {
  const scrubbed = text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`]+/gi, ' ');
  return [...scrubbed.matchAll(/[^\s"'`,;)\]}]+[\\/][^\s"'`,;)\]}]*/g)].map((match) => match[0]);
}

/** Walk a parsed argument value, sorting string fields into the strict and mention buckets. */
function collectPaths(value, key, tool, strict, mentions) {
  if (typeof value === 'string') {
    if (NEVER_PATH_KEYS.has(key) || REGEX_KEYS_BY_TOOL.get(tool)?.has(key) === true) return;
    if (PATH_KEYS.has(key)) strict.push(...pathCandidates(value));
    else if (MENTION_KEYS.has(key)) mentions.push(...pathCandidates(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, key, tool, strict, mentions);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) collectPaths(item, name, tool, strict, mentions);
  }
}

/**
 * Classify every path a session touched against a root.
 *
 * The verdict comes from the arguments the host resolves: a `file_path`, a `path`, a glob `pattern`.
 * `command` strings are scanned separately as *mentions* — a shell command may name a path it never
 * reads (a heredoc, a fixture inside a test program, a regex), so mentions are reported for a human to
 * read and never counted as escapes.
 *
 * Relative paths without `..` are inside by construction — the session's own `cwd` is the root — so
 * they are counted rather than listed. Escapes, which is what `..` and an absolute path outside the
 * root both are, are listed individually with the call that produced them. A glob pattern is
 * classified like any other path: `glob { pattern: 'C:/Users/**' }` reads outside the workspace, and
 * skipping it because it "is not a path" would be exactly the blind spot this tool exists to close.
 *
 * @param {Array<{ seq: number, name: string, args: unknown }>} calls
 * @param {string} root
 * @returns {{
 *   inside: string[],
 *   outside: Array<{ path: string, tool: string, seq: number, pattern: boolean }>,
 *   mentions: string[],
 *   relative: number,
 *   patterns: number,
 * }}
 */
export function classifyPaths(calls, root) {
  const normalisedRoot = normalisePath(root);
  const inside = [];
  const outside = [];
  const mentioned = new Set();
  let relative = 0;
  let patterns = 0;

  for (const call of calls) {
    const strict = [];
    const loose = [];
    collectPaths(call.args, '', call.name, strict, loose);

    for (const candidate of strict) {
      const isPattern = /[*?]/.test(candidate);
      const isAbsolute = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(candidate);
      const escapes = candidate.split(/[\\/]/).includes('..');
      if (!isAbsolute && !escapes) {
        // A relative path that cannot climb out of the root is inside by construction.
        if (isPattern) patterns += 1;
        else relative += 1;
        continue;
      }
      // `..` hides an escape in an absolute path too: `C:/work/project/../secrets.txt` starts with the
      // root and lands outside it, so the comparison has to run against the resolved form.
      const normalised = normalisePath(isAbsolute ? resolve(candidate) : resolve(root, candidate));
      if (isPattern) patterns += 1;
      if (isInside(normalised, normalisedRoot)) inside.push(candidate);
      else outside.push({ path: candidate, tool: call.name, seq: call.seq, pattern: isPattern });
    }

    for (const candidate of loose) {
      if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(candidate)) continue;
      if (!isInside(normalisePath(resolve(candidate)), normalisedRoot)) mentioned.add(candidate);
    }
  }
  return { inside, outside, mentions: [...mentioned].sort(), relative, patterns };
}

/** Compare two paths the way this platform does — case folding is a platform property (spec §10.4). */
function isInside(path, root) {
  const adapter = selectAdapter();
  const left = adapter.foldPath(path);
  const right = adapter.foldPath(root);
  return left === right || left.startsWith(right.endsWith('/') ? right : `${right}/`);
}

/** Normalise separators so a Windows log and a POSIX log compare the same way. */
function normalisePath(path) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Run the whole audit over one session log.
 *
 * @param {object[]} records
 * @param {{ root?: string, allow?: string[] }} [options]
 * @returns {object} a JSON-serialisable result
 */
export function audit(records, options = {}) {
  const sessionRecord = records.find((record) => record?.type === 'session');
  const root = options.root ?? sessionRecord?.cwd ?? process.cwd();
  const allow = options.allow ?? [];

  const declared = declaredTools(records);
  const changes = toolChangeBlocks(records);
  const calls = toolCalls(records);
  const paths = classifyPaths(calls, root);

  const declaredNames = new Set(declared.revisions.flatMap((revision) => revision.tools.map((tool) => tool.name)));
  const deferred = declared.revisions.at(-1)?.tools.filter((tool) => tool.deferred).map((tool) => tool.name) ?? [];
  const deferredCalls = calls.filter((call) => deferred.includes(call.name)).map((call) => call.name);
  const undeclaredCalls = [...new Set(calls.filter((call) => !declaredNames.has(call.name)).map((call) => call.name))];

  const allowed = [];
  const violations = [];
  for (const entry of paths.outside) {
    if (allow.some((prefix) => isInside(normalisePath(entry.path), normalisePath(prefix)))) allowed.push(entry);
    else violations.push(entry);
  }

  const byTool = new Map();
  for (const call of calls) byTool.set(call.name, (byTool.get(call.name) ?? 0) + 1);

  return {
    root,
    allow,
    records: records.length,
    headerRevisions: declared.revisions.length,
    declared: declared.revisions.at(-1)?.tools ?? [],
    declaredAdded: declared.added,
    declaredRemoved: declared.removed,
    deferred,
    namedBy: Object.fromEntries(declared.namedBy),
    unreachableDeferred: declared.revisions.at(-1)?.unreachable ?? [],
    deferredCalls,
    undeclaredCalls,
    toolChange: changes,
    calls: [...byTool.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    paths: { inside: paths.inside.length, relative: paths.relative, patterns: paths.patterns },
    outside: paths.outside,
    mentions: paths.mentions,
    allowed,
    violations,
  };
}

/** Render an audit result as the markdown a human reads in the acceptance record. */
export function renderAudit(result) {
  const lines = [];
  lines.push('# session audit');
  lines.push('');
  lines.push(`Root: ${result.root}`);
  lines.push(`Records: ${result.records}, request headers: ${result.headerRevisions}, tool calls: ${result.calls.reduce((total, entry) => total + entry.count, 0)}`);
  lines.push('');
  lines.push('## 1. Tool changes announced to the model');
  lines.push('');
  lines.push(`tool-addition: ${result.toolChange.additions.length}, tool-removal: ${result.toolChange.removals.length}`);
  if (result.toolChange.additions.length === 0 && result.toolChange.removals.length === 0) {
    lines.push('None. A tool that was deferred from the moment it was registered is never announced here.');
  }
  lines.push('');
  lines.push('## 2. Declared tools');
  lines.push('');
  lines.push(`${result.declared.length} declared, ${result.deferred.length} deferred`);
  for (const tool of result.declared) {
    if (tool.deferred) lines.push(`  [deferred] ${tool.name}`);
  }
  // The wire-level form of the field-test defect: a deferred tool is not in the model's declaration set,
  // so if no declaration's text names it, the model has no way to learn that it exists.
  for (const [name, sources] of Object.entries(result.namedBy)) {
    lines.push(`  ${name} is named by: ${sources.length === 0 ? 'nothing' : sources.join(', ')}`);
  }
  if (result.unreachableDeferred.length > 0) {
    lines.push(
      `Unreachable deferred tools: ${result.unreachableDeferred.join(', ')} - callable, but nothing tells the model they exist.`,
    );
  }
  if (result.declaredAdded.length > 0) lines.push(`Added across revisions: ${result.declaredAdded.join(', ')}`);
  if (result.declaredRemoved.length > 0) lines.push(`Removed across revisions: ${result.declaredRemoved.join(', ')}`);
  lines.push('');
  lines.push('## 3. Calls');
  lines.push('');
  for (const entry of result.calls) lines.push(`  ${String(entry.count).padStart(3)}  ${entry.name}`);
  if (result.deferredCalls.length > 0) {
    lines.push('');
    lines.push(`Calls to deferred tools: ${result.deferredCalls.join(', ')} - callable, but not in the declaration set.`);
  }
  if (result.undeclaredCalls.length > 0) {
    lines.push('');
    lines.push(`Calls to names no header declared: ${result.undeclaredCalls.join(', ')}`);
  }
  lines.push('');
  lines.push(`## 4. Paths under ${result.root}`);
  lines.push('');
  lines.push(`Inside: ${result.paths.inside}, relative: ${result.paths.relative}, patterns: ${result.paths.patterns}`);
  for (const entry of result.outside) lines.push(`Outside: ${entry.path} (${entry.tool}, seq ${entry.seq})`);
  for (const entry of result.allowed) lines.push(`Outside but allowed: ${entry.path} (${entry.tool}, seq ${entry.seq})`);
  if (result.mentions.length > 0) {
    lines.push('');
    lines.push('Mentioned in a command but not resolved by the host — informational, not counted as escapes:');
    for (const mention of result.mentions) lines.push(`  ${mention}`);
  }
  lines.push('');
  lines.push('## 5. Verdict');
  lines.push('');
  lines.push(
    result.violations.length === 0
      ? 'CLEAN - every path this session touched resolves inside the root.'
      : `LEAK - ${result.violations.length} path(s) outside the root and not covered by --allow.`,
  );
  return lines.join('\n');
}

/** Parse argv into `{ session, root, allow, json }`; returns an error string instead of throwing. */
export function parseArgv(argv) {
  const options = { session: undefined, root: undefined, allow: [], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--session' || argument === '--root' || argument === '--allow') {
      const value = argv[index + 1];
      if (value === undefined) return `--${argument.slice(2)} needs a value`;
      index += 1;
      if (argument === '--session') options.session = value;
      else if (argument === '--root') options.root = value;
      else options.allow.push(value);
    } else return `unrecognised argument ${JSON.stringify(argument)}`;
  }
  if (options.session === undefined) return '--session <session.v4.jsonl.zstd> is required';
  return options;
}

function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (typeof parsed === 'string') {
    process.stderr.write(`session-audit: ${parsed}\n`);
    process.stderr.write(
      'usage: node tools/session-audit.mjs --session <session.v4.jsonl.zstd> [--root <dir>] [--allow <prefix>] [--json]\n',
    );
    process.exitCode = 2;
    return;
  }
  let records;
  try {
    records = parseSession(readSession(parsed.session));
  } catch (error) {
    process.stderr.write(`session-audit: cannot read ${parsed.session}: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const result = audit(records, { root: parsed.root, allow: parsed.allow });
  process.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderAudit(result)}\n`);
  process.exitCode = result.violations.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
