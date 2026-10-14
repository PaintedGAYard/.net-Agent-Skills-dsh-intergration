/**
 * Project signal detection (doc/spec.md §9).
 *
 * The job is to answer one question about a workspace — "which upstream plugins does this project
 * give evidence for?" — and to answer it from the filesystem alone. Signals only ever *add* plugins:
 * §9.3 rule one says the `dotnet` plugin is always in, so the presence of any `.csproj` is not
 * evidence for anything, and rule two says a signal with no content behind it in the shipped range
 * maps to nothing (`*.razor`, `*.fsproj`, `net11.0`, `System.Windows.Forms`).
 *
 * Four properties are contract, not implementation detail, because breaking any of them is visible
 * to the model:
 *
 *   bounded    `probe.maxFiles` and `probe.maxDepth` cap the walk, and byte budgets cap content
 *              reads, so a 200k-file repository cannot stall a catalog read;
 *   pure       no clock, no globals, no `process.cwd()`, no shelling out (§9.1) — the same fixture
 *              always answers the same way, which is what makes the signal table testable;
 *   memoized   keyed by (cwd, mtime bucket) so repeated catalog reads do not rescan;
 *   grow-only  within one session a workspace never loses a plugin it once matched, because a
 *              shrinking catalog makes the host re-issue a whole catalog and breaks the prompt
 *              cache (§6.2, hard rule two).
 *
 * Mapping details that §9.2 leaves to the implementation are spelled out in `doc/dev-notes.md`, and
 * `SIGNAL_TABLE` is the single copy of the table so tests and the status report cannot drift apart.
 * `detect` never throws: a workspace it cannot read is "no signal", with the reason stated.
 *
 * Scope is decided here as well as signal. Generated output (`obj/`, `bin/`) is never read, because a
 * generated file lists every transitive package, and a nested repository is never descended into,
 * because a submodule or vendored checkout is its own project: its build files are evidence about
 * *that* project, not about the one the session was opened in. Both rules exist for precision rather
 * than for speed, and both were added after a live measurement rather than before one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The mtime bucket width. 2000 ms matches the worst-case NTFS mtime granularity. */
const DEFAULT_BUCKET_MS = 2000;

/** How many immediate children may inform one bucket. Bounds the `stat` cost of a huge workspace root. */
const BUCKET_SAMPLE = 512;

/** Longest single file read as text. Project files and source files are far smaller than this. */
const MAX_FILE_BYTES = 256 * 1024;

/** Total content bytes read per scan. After this, name signals keep flowing but nothing more is read. */
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;

/** Evidence kept per signal. Enough to name the file an operator should look at, not a listing. */
const MAX_EVIDENCE = 5;

/** Workspaces remembered per process; each entry is a few hundred bytes plus the plugin set. */
const MAX_WORKSPACES = 8;

/**
 * Directories never descended into.
 *
 * `obj/` and `bin/` are here for correctness rather than speed: `obj/project.assets.json` lists
 * every transitive package, so reading generated output would report `Microsoft.EntityFrameworkCore`
 * for any repository that merely depends on a library that depends on EF Core.
 */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'bin', 'obj', '.vs']);

/** Extensions whose *text* may carry package, SDK and target-framework signals. */
const PROJECT_EXTENSIONS = new Set(['csproj', 'props', 'targets', 'sln', 'slnx']);

/** Extensions whose *text* may carry source-shaped signals (top-level `app.MapGet`, symbolicated stacks). */
const SOURCE_EXTENSIONS = new Set(['cs', 'txt', 'log']);

/**
 * The signal table of §9.2, one row per spec line.
 *
 * `plugin: null` is not an oversight: row one lists the files that prove a repository is .NET at all,
 * and .NET is what the always-on `dotnet` plugin covers. `dotnet-nuget` has no row either — its only
 * skill converts a project *to* central package management, and the presence of
 * `Directory.Packages.props` is evidence against that change rather than for it (dev-notes).
 *
 * @type {ReadonlyArray<{ id: string, plugin: string | null, spec: string }>}
 */
export const SIGNAL_TABLE = Object.freeze([
  Object.freeze({
    id: 'dotnet-repo',
    plugin: null,
    spec: '*.sln / *.slnx / *.csproj / Directory.Build.props / Directory.Packages.props / global.json / nuget.config',
  }),
  Object.freeze({
    id: 'msbuild',
    plugin: 'dotnet-msbuild',
    spec: '*.binlog or -bl artifacts, Directory.Build.targets, a deep *.props hierarchy',
  }),
  Object.freeze({
    id: 'test-sdk',
    plugin: 'dotnet-test',
    spec: 'Microsoft.NET.Test.Sdk / MSTest / xUnit / NUnit / TUnit / UseMicrosoftTestingPlatformRunner',
  }),
  Object.freeze({
    id: 'mtp-migration',
    plugin: 'dotnet-test',
    spec: 'VSTest in use together with traces of an MTP migration',
  }),
  Object.freeze({ id: 'maui', plugin: 'dotnet-maui', spec: '<UseMaui> / MauiProgram.cs' }),
  Object.freeze({ id: 'aspnet', plugin: 'dotnet-aspnet', spec: 'Microsoft.NET.Sdk.Web / top-level app.MapGet' }),
  Object.freeze({ id: 'ef-core', plugin: 'dotnet-data', spec: 'Microsoft.EntityFrameworkCore' }),
  Object.freeze({
    id: 'upgrade',
    plugin: 'dotnet-upgrade',
    spec: 'net8.0 / net9.0 / net10.0 beside an adjacent higher target',
  }),
  Object.freeze({ id: 'ai', plugin: 'dotnet-ai', spec: 'Microsoft.ML / Microsoft.SemanticKernel / an MCP server project' }),
  Object.freeze({ id: 'template', plugin: 'dotnet-template-engine', spec: '.template.config' }),
  Object.freeze({
    id: 'diag',
    plugin: 'dotnet-diag',
    spec: '*.dmp / *.nettrace / a symbolicated crash stack / a tombstone',
  }),
]);

/** Plugins a workspace can never make redundant, so detection never claims them (§9.3 rule one). */
export const ALWAYS_ON_PLUGIN = 'dotnet';

/**
 * A scan that read nothing, with the reason stated rather than implied.
 *
 * @param {'no-cwd' | 'disabled'} reason
 */
function emptyResult(reason) {
  return Object.freeze({
    plugins: Object.freeze([]),
    evidence: Object.freeze({}),
    scanned: Object.freeze({ cwd: null, files: 0, dirs: 0, bytes: 0, depth: 0, truncated: false, reason }),
    retained: Object.freeze([]),
  });
}

const NOT_SCANNED = emptyResult('no-cwd');
const DETECTION_DISABLED = emptyResult('disabled');

/**
 * Build the `detect` callback that `lib/selection.js` injects into the `project-detection` selector.
 *
 * @param {object} input
 * @param {object} input.config - resolved plugin config; only `probe.*` is read
 * @param {(line: string) => void} [input.log]
 * @param {number} [input.bucketMs] - mtime bucket width; `0` disables memoization (debugging and tests)
 * @returns {(context: { cwd?: string }) => object} `detect`, which never throws
 */
export function createProjectDetector({ config, log, bucketMs = DEFAULT_BUCKET_MS } = {}) {
  /** @type {Map<string, { bucket: number, plugins: Set<string>, result: object }>} */
  const cache = new Map();

  return function detect(context = {}) {
    // `probe.enabled: false` means "do not scan", not "scan and discard": a workspace whose
    // filesystem we have no business touching has to be able to say that no read happened.
    if (config?.probe?.enabled === false) return DETECTION_DISABLED;

    const cwd = typeof context.cwd === 'string' && context.cwd !== '' ? context.cwd : undefined;
    if (cwd === undefined) return NOT_SCANNED;

    const bucket = bucketMs > 0 ? mtimeBucket(cwd, bucketMs) : Number.NaN;
    const cached = cache.get(cwd);
    if (cached !== undefined && Number.isFinite(bucket) && cached.bucket === bucket) {
      // Re-insert so the least recently used workspace is the one evicted.
      cache.delete(cwd);
      cache.set(cwd, cached);
      return cached.result;
    }

    let found;
    try {
      found = scan(cwd, config?.probe ?? {});
    } catch (error) {
      // A pure scan can still meet an unreadable path or a race, and a throw here would take the
      // whole catalog read down. Degrading to "no signal" is the documented meaning of a failure,
      // and `reason` keeps it distinguishable from a workspace that genuinely matched nothing.
      log?.(`project detection failed for ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
      found = {
        plugins: new Set(),
        evidence: {},
        files: 0,
        dirs: 0,
        bytes: 0,
        depth: 0,
        truncated: false,
        reason: 'unreadable',
      };
    }

    if (found.truncated !== false) {
      log?.(
        `project detection stopped early in ${cwd}: ` +
          (found.truncated === 'entries'
            ? 'probe.maxFiles was reached, so deeper or later files were not evaluated'
            : 'the content budget was reached, so only file names were evaluated from that point'),
      );
    }

    // Grow-only: a plugin this workspace matched under an earlier bucket stays matched. The
    // evidence, unlike the plugin set, always describes the current state of the tree.
    const retained = [...(cached?.plugins ?? [])].filter((plugin) => !found.plugins.has(plugin));
    const plugins = new Set([...(cached?.plugins ?? []), ...found.plugins]);

    const result = Object.freeze({
      plugins: Object.freeze([...plugins].sort()),
      evidence: freezeEvidence(found.evidence),
      scanned: Object.freeze({
        cwd,
        files: found.files,
        dirs: found.dirs,
        bytes: found.bytes,
        depth: found.depth,
        truncated: found.truncated,
        ...(found.reason === undefined ? {} : { reason: found.reason }),
      }),
      retained: Object.freeze(retained.sort()),
    });

    cache.set(cwd, { bucket, plugins, result });
    while (cache.size > MAX_WORKSPACES) cache.delete(cache.keys().next().value);
    return result;
  };
}

/**
 * The memo key's second half: the newest mtime this workspace shows, floored into a bucket.
 *
 * File mtimes rather than the clock, because §9.1 requires the module be clock-free — and a
 * directory's own mtime moves when a child is added or removed, so creation and deletion both land
 * in a new bucket without any timer.
 *
 * @param {string} cwd
 * @param {number} bucketMs
 * @returns {number}
 */
function mtimeBucket(cwd, bucketMs) {
  let newest;
  try {
    newest = statSync(cwd).mtimeMs;
  } catch {
    return 0;
  }
  let names;
  try {
    names = readdirSync(cwd, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort()
      .slice(0, BUCKET_SAMPLE);
  } catch {
    return Math.floor(newest / bucketMs);
  }
  for (const name of names) {
    try {
      newest = Math.max(newest, statSync(join(cwd, name)).mtimeMs);
    } catch {
      // A file that vanished between readdir and stat simply contributes nothing.
    }
  }
  return Math.floor(newest / bucketMs);
}

/**
 * Walk the workspace once and collect signal evidence.
 *
 * Breadth-first with names sorted inside every directory: the result must not depend on the order the
 * filesystem happens to return entries in, or two identical workspaces would produce two different
 * catalogs.
 *
 * @param {string} root
 * @param {{ maxFiles?: number, maxDepth?: number }} probe
 */
function scan(root, probe) {
  const maxFiles = Number.isFinite(probe.maxFiles) && probe.maxFiles > 0 ? probe.maxFiles : 20000;
  const maxDepth = Number.isFinite(probe.maxDepth) && probe.maxDepth >= 0 ? probe.maxDepth : 8;

  /** @type {Map<string, string[]>} marker id → workspace-relative POSIX paths */
  const markers = new Map();
  const mark = (id, path) => {
    if (!markers.has(id)) markers.set(id, []);
    const list = markers.get(id);
    if (list.length < MAX_EVIDENCE && !list.includes(path)) list.push(path);
  };
  const state = { tfms: new Set() };

  let files = 0;
  let dirs = 0;
  let bytes = 0;
  let depth = 0;
  let hitEntryCap = false;
  let hitContentBudget = false;
  let readable = false;

  /** @type {Array<{ directory: string, depth: number }>} */
  const queue = [{ directory: root, depth: 0 }];

  walk: while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = readdirSync(current.directory, { withFileTypes: true }).sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
    } catch {
      continue;
    }
    readable = true;
    // A nested repository is not this workspace's project. A submodule or a vendored checkout carries
    // its own `.git`, and its projects, test fixtures and sample crash logs describe *it* rather than
    // the repository the session was opened in. Measured case: this plugin's own workspace pins the
    // upstream `dotnet/skills` checkout as a submodule, and reading it selected six plugins — 49
    // catalog entries — for a JavaScript repository. The root is exempt: a workspace that is itself a
    // repository is the ordinary case, not an exception.
    if (current.depth > 0 && entries.some((entry) => entry.name === '.git')) continue;
    for (const entry of entries) {
      if (files + dirs >= maxFiles) {
        hitEntryCap = true;
        break walk;
      }
      const full = join(current.directory, entry.name);
      const path = relative(root, full).split(sep).join('/');
      const childDepth = current.depth + 1;
      depth = Math.max(depth, childDepth);

      if (entry.isDirectory()) {
        dirs += 1;
        if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        observeDirectory(entry.name, path, childDepth, mark);
        if (childDepth <= maxDepth) queue.push({ directory: full, depth: childDepth });
        continue;
      }
      if (!entry.isFile()) continue; // symbolic links: never followed, so a link loop cannot hang the walk

      files += 1;
      observeName(entry.name, path, childDepth, mark);
      if (!isContentFile(entry.name)) continue;
      if (bytes >= MAX_CONTENT_BYTES) {
        hitContentBudget = true;
        continue;
      }
      const text = readText(full);
      if (text === undefined) continue;
      bytes += text.length;
      observeContent(text, entry.name, path, mark, state);
    }
  }

  const evidence = resolve(markers, state);
  return {
    plugins: new Set(Object.values(evidence).flatMap((row) => (row.plugin === null ? [] : [row.plugin]))),
    evidence,
    files,
    dirs,
    bytes,
    depth,
    truncated: hitEntryCap ? 'entries' : hitContentBudget ? 'content' : false,
    reason: readable ? undefined : 'unreadable',
  };
}

/** Whether a file's text may carry a signal. Anything else is name-only. */
function isContentFile(name) {
  const lower = name.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf('.') + 1);
  return PROJECT_EXTENSIONS.has(extension) || SOURCE_EXTENSIONS.has(extension);
}

/** Name-shaped signals: the file or directory name is the evidence, and `.json` is never read. */
function observeName(name, path, depth, mark) {
  const lower = name.toLowerCase();

  if (
    lower === 'nuget.config' ||
    lower === 'global.json' ||
    lower === 'directory.build.props' ||
    lower === 'directory.packages.props' ||
    lower.endsWith('.csproj') ||
    lower.endsWith('.sln') ||
    lower.endsWith('.slnx')
  ) {
    mark('dotnet-repo', path);
  }
  if (lower === 'directory.build.targets') mark('build-targets', path);
  if (/\.binlog(\.|$)/.test(lower)) mark('binlog', path);
  if (lower.endsWith('.props') && depth >= 3) mark('deep-props', path);
  if (lower.endsWith('.runsettings')) mark('runsettings', path);
  if (lower === 'dotnet.config') mark('dotnet-config', path);
  if (lower === 'mauiprogram.cs') mark('maui-file', path);
  if (lower === 'mcp.json' || lower === '.mcp.json') mark('mcp', path);
  if (
    lower.endsWith('.dmp') ||
    lower.endsWith('.nettrace') ||
    lower.endsWith('.tombstone') ||
    lower.startsWith('tombstone')
  ) {
    mark('diag', path);
  }
}

/** A directory's own name can be the whole signal: `.template.config` is how template authors mark a project. */
function observeDirectory(name, path, depth, mark) {
  const lower = name.toLowerCase();
  if (lower === '.template.config') mark('template', path);
  if (lower === '.mcp') mark('mcp', path);
  if (lower.endsWith('.props') && depth >= 3) mark('deep-props', path);
}

/** Read a candidate file as text, lowercased once so every predicate below is a plain substring test. */
function readText(full) {
  try {
    const stats = statSync(full);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return undefined;
    return readFileSync(full, 'utf8').toLowerCase();
  } catch {
    return undefined;
  }
}

/** Content-shaped signals. `text` is already lowercased. */
function observeContent(text, name, path, mark, state) {
  const lower = name.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf('.') + 1);
  const projectish = PROJECT_EXTENSIONS.has(extension);

  if (projectish) {
    if (text.includes('microsoft.net.test.sdk')) {
      mark('test-sdk', path);
      mark('vstest', path);
    }
    if (text.includes('microsoft.testplatform')) mark('vstest', path);
    if (word(text, 'mstest') || word(text, 'xunit') || word(text, 'nunit') || word(text, 'tunit')) {
      mark('test-sdk', path);
    }
    if (
      text.includes('usemicrosofttestingplatformrunner') ||
      text.includes('microsoft.testing.platform') ||
      text.includes('testingplatformdotnettestsupport') ||
      text.includes('enablemstestrunner') ||
      text.includes('enablenunitrunner')
    ) {
      mark('mtp-traces', path);
    }
    if (text.includes('usemaui')) mark('maui', path);
    if (text.includes('microsoft.net.sdk.web')) mark('aspnet-sdk', path);
    if (text.includes('microsoft.entityframeworkcore')) mark('ef-core', path);
    if (
      text.includes('microsoft.ml') ||
      text.includes('microsoft.semantickernel') ||
      text.includes('modelcontextprotocol')
    ) {
      mark('ai', path);
    }
    for (const match of text.matchAll(/\bnet(\d+)\.(\d+)/g)) state.tfms.add(`${match[1]}.${match[2]}`);
  }

  if (SOURCE_EXTENSIONS.has(extension)) {
    // §9.2 says "top-level `app.MapGet`", and top-level statements are written at column zero; the
    // leading-whitespace allowance only keeps indented fixtures testable.
    if (/^\s*app\.mapget\(/m.test(text)) mark('aspnet-source', path);
    // A symbolicated managed stack: `   at Sample.Program.Main(String[] args) in C:\...:line 12`.
    if (/^\s*at [a-z_][a-z0-9_.`+]*\(/m.test(text)) mark('diag', path);
  }
}

/**
 * A whole-word test for the short framework names.
 *
 * `TUnit` as a bare substring matches "oppor**tunit**y", which is exactly the kind of false positive
 * a signal table cannot afford.
 */
function word(text, needle) {
  return new RegExp(`(^|[^a-z0-9])${needle}([^a-z0-9]|$)`).test(text);
}

/**
 * Fold raw markers into §9.2's rows, which is where a plugin is decided.
 *
 * @param {Map<string, string[]>} markers
 * @param {{ tfms: Set<string> }} state
 * @returns {Record<string, { plugin: string | null, paths: string[] }>}
 */
function resolve(markers, state) {
  const list = (id) => markers.get(id) ?? [];
  /** @type {Record<string, { plugin: string | null, paths: string[] }>} */
  const rows = {};

  const put = (id, plugin, paths) => {
    if (paths.length === 0) return;
    rows[id] = { plugin, paths: [...new Set(paths)].sort().slice(0, MAX_EVIDENCE) };
  };

  put('dotnet-repo', null, list('dotnet-repo'));
  put('msbuild', 'dotnet-msbuild', [...list('binlog'), ...list('build-targets'), ...list('deep-props')]);
  put('test-sdk', 'dotnet-test', list('test-sdk'));

  // Row four is the one conditional row: a migration is only under way when both halves are present.
  const onVstest = [...list('vstest'), ...list('runsettings')];
  const migrating = [...list('mtp-traces'), ...list('dotnet-config')];
  put('mtp-migration', 'dotnet-test', onVstest.length > 0 && migrating.length > 0 ? [...onVstest, ...migrating] : []);

  put('maui', 'dotnet-maui', [...list('maui'), ...list('maui-file')]);
  put('aspnet', 'dotnet-aspnet', [...list('aspnet-sdk'), ...list('aspnet-source')]);
  put('ef-core', 'dotnet-data', list('ef-core'));
  put('upgrade', 'dotnet-upgrade', state.tfms.size > 0 && adjacentTarget(state.tfms) ? [...state.tfms] : []);
  put('ai', 'dotnet-ai', [...list('ai'), ...list('mcp')]);
  put('template', 'dotnet-template-engine', list('template'));
  put('diag', 'dotnet-diag', list('diag'));

  return rows;
}

/**
 * §9.2 row eight: a supported target beside an adjacent higher one.
 *
 * Read as "the set contains one of 8.0 / 9.0 / 10.0 *and* something strictly higher", which is what a
 * migration in progress looks like — multi-targeting `net8.0;net10.0`, or a project still on `net8.0`
 * beside a companion project already moved up. `net11.0` alone matches nothing, which is rule two: the
 * upgrade skills cover 10-to-11, but there is no `dotnet11` plugin to enable.
 *
 * @param {Set<string>} tfms
 */
function adjacentTarget(tfms) {
  const values = [...tfms].map((tfm) => {
    const [major, minor] = tfm.split('.');
    return Number(major) * 100 + Number(minor);
  });
  const lowest = Math.min(...values);
  return [800, 900, 1000].includes(lowest) && values.some((value) => value > lowest);
}

/** Freeze the evidence table so a caller cannot corrupt the memoized result (§9.1 purity). */
function freezeEvidence(rows) {
  /** @type {Record<string, { plugin: string | null, paths: readonly string[] }>} */
  const frozen = {};
  for (const [id, row] of Object.entries(rows)) {
    frozen[id] = Object.freeze({ plugin: row.plugin, paths: Object.freeze(row.paths) });
  }
  return Object.freeze(frozen);
}
