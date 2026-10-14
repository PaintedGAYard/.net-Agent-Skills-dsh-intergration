#!/usr/bin/env node
/**
 * Pin the upstream snapshot.
 *
 * Development-side only (spec §3.2): the running plugin reads `vendor/upstream/**`
 * and never learns that an upstream exists. Every run is a deliberate, reviewable act
 * that starts from an explicit ref — there is no default branch, and `main` is not a
 * fallback (§3.5).
 *
 * Usage:
 *   node tools/sync-snapshot.mjs --ref v1.0.0 [--plugins dotnet] [--allow-partial]
 *   node tools/sync-snapshot.mjs --ref v1.0.0 --dry-run
 *
 * Source of file content, in order:
 *   1. `--from <dir>` or $DOTNET_SKILLS_CHECKOUT, the local checkout (default `submodule/dotnet-skills`)
 *   2. `git clone --filter=blob:none` of $DOTNET_SKILLS_REPO (default the upstream URL)
 * The local checkout must already sit at `--ref`; its HEAD is verified, never moved.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { FrontmatterError, isSkillName, normalizeText, parseDocument, readRequiredKeys } from '../lib/frontmatter.js';
import { computeSnapshotSha256, packageRoot, snapshotRoot, upstreamManifestPath } from '../lib/snapshot.js';

const MARKETPLACE_RELATIVE = join('.claude-plugin', 'marketplace.json');
const PLUGIN_MANIFEST = 'plugin.json';
const GIT_REF_PATTERN = /^(?:[0-9a-f]{7,40}|[A-Za-z0-9][A-Za-z0-9._/-]*)$/;

class SyncError extends Error {}

function main(argv) {
  const options = parseArgs(argv);

  const source = resolveSource(options);
  const sourceRoot = ensureCheckout(source);
  const sync = planSync({ sourceRoot, plugins: options.plugins, allowPartial: options.allowPartial });

  const commit = git(sourceRoot, ['rev-parse', 'HEAD']);
  const tag = resolveTag(sourceRoot, options.ref, commit);

  report(options, source, { pluginNames: sync.selected.names, inventory: sync.inventory, failures: sync.failures, tag, commit });

  if (options.dryRun) {
    process.stdout.write('\n--dry-run: nothing written\n');
    return 0;
  }
  if (sync.failures.length > 0) throw new SyncError(sync.failures.join('\n  '));

  writeSnapshot(sourceRoot, sync.selected.names);
  const digest = computeSnapshotSha256();
  writeUpstreamManifest({
    source,
    tag,
    commit,
    pluginNames: sync.selected.names,
    marketplaceNames: sync.marketplaceNames,
    outOfRangePlugins: sync.outOfRangePlugins,
    extraPlugins: sync.extraPlugins,
    inventory: sync.inventory,
    digest,
    pluginMetadata: sync.selected.pluginMetadata,
  });

  process.stdout.write(
    `\nwrote ${relative(process.cwd(), upstreamManifestPath)}: ` +
      `${tag} (${commit.slice(0, 8)}) ${sync.selected.names.length} plugins / ${sync.selected.skillCount} skills, ` +
      `inventory ${sync.inventory.skillCount} skills, snapshot ${digest.sha256.slice(0, 16)}… (${digest.files} files)\n`,
  );
  if (sync.selected.names.length !== sync.marketplaceNames.length) {
    process.stdout.write('note: this range is narrower than the marketplace set (--allow-partial).\n');
  }
  return 0;
}

/**
 * Validate a checkout and decide what the snapshot should contain, without writing anything.
 *
 * Split out from {@link main} so the five validation rules of the plan's W2 table can be tested
 * against throwaway trees. A rule that can only be exercised by corrupting the real snapshot is a
 * rule nobody will exercise twice.
 *
 * @param {object} input
 * @param {string} input.sourceRoot - upstream checkout root
 * @param {string[]} [input.plugins] - narrowed range; defaults to the marketplace set
 * @param {boolean} [input.allowPartial] - accept a range narrower than the marketplace set on purpose
 * @param {string} [input.marketplaceRelative] - override for the marketplace path
 * @returns {object} the plan, including any `failures`
 */
export function planSync({ sourceRoot, plugins, allowPartial = false, marketplaceRelative = MARKETPLACE_RELATIVE }) {
  const marketplace = readJson(join(sourceRoot, marketplaceRelative));
  const marketplaceNames = marketplace.plugins.map((plugin) => plugin.name);
  if (new Set(marketplaceNames).size !== marketplaceNames.length) {
    throw new SyncError(`${marketplaceRelative} lists a plugin name more than once`);
  }

  const pluginNames = plugins ?? marketplaceNames;
  for (const name of pluginNames) {
    if (!marketplaceNames.includes(name)) {
      throw new SyncError(`--plugins names ${JSON.stringify(name)}, which ${marketplaceRelative} does not list`);
    }
  }

  const pluginRoot = join(sourceRoot, 'plugins');
  const availablePlugins = readdirSync(pluginRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  // Two different "not in the snapshot" sets, kept apart on purpose:
  //   - marketplace plugins this run narrowed away with --plugins (a range decision)
  //   - upstream plugins the marketplace never listed (a scope decision, §2.2)
  const outOfRangePlugins = marketplaceNames.filter((name) => !pluginNames.includes(name));
  const extraPlugins = availablePlugins.filter((name) => !marketplaceNames.includes(name));

  const inventory = collectInventory(pluginRoot, availablePlugins);
  const selected = collectPlugins(sourceRoot, pluginNames, inventory);
  const failures = [];
  // A narrowed range is deliberate friction, not an accident: `--plugins` without `--allow-partial`
  // fails so a typo cannot quietly ship four plugins instead of eleven, and `--allow-partial` is what
  // says the narrowing was meant. The flag is honoured here rather than only in the CLI note.
  if (selected.names.length !== marketplaceNames.length && allowPartial !== true) {
    failures.push(
      `included plugin set ${JSON.stringify(selected.names)} is not the marketplace set ` +
        `${JSON.stringify(marketplaceNames)}; pass --allow-partial to sync a narrowed range on purpose`,
    );
  }
  return { marketplaceNames, outOfRangePlugins, extraPlugins, inventory, selected, failures };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = {
    ref: undefined,
    plugins: undefined,
    from: undefined,
    repo: undefined,
    allowPartial: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new SyncError(`${arg} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--ref':
        options.ref = next();
        break;
      case '--plugins':
        options.plugins = next()
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '');
        if (options.plugins.length === 0) throw new SyncError('--plugins was given no plugin names');
        break;
      case '--from':
        options.from = next();
        break;
      case '--repo':
        options.repo = next();
        break;
      case '--allow-partial':
        options.allowPartial = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        throw new SyncError(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

/**
 * Resolve where file content comes from and which ref it must be at.
 *
 * The default ref is carried by the provenance file, never hard-coded (§3.2).
 */
function resolveSource(options) {
  const defaultRef = readDefaultRef();
  const ref = options.ref ?? defaultRef;
  if (ref === undefined) {
    throw new SyncError(
      'a ref is required and vendor/UPSTREAM.json has no "tag" to default to.\n' +
        '  usage: node tools/sync-snapshot.mjs --ref v1.0.0\n' +
        '  This pipeline never falls back to main: the baseline is always a tag or a commit (doc/spec.md §3.5).',
    );
  }
  if (!GIT_REF_PATTERN.test(ref) || ref.includes('..') || ref.startsWith('-')) {
    throw new SyncError(`ref ${JSON.stringify(ref)} does not look like a tag or commit`);
  }
  const repo = options.repo ?? process.env.DOTNET_SKILLS_REPO ?? 'https://github.com/dotnet/skills.git';
  if (!/^[A-Za-z0-9._/@:+-]+$/.test(repo) || repo.startsWith('-')) {
    throw new SyncError(`repository ${JSON.stringify(repo)} contains characters this pipeline will not pass to git`);
  }
  return {
    ref,
    repo,
    explicitRef: options.ref !== undefined,
    checkout: resolve(options.from ?? process.env.DOTNET_SKILLS_CHECKOUT ?? join(packageRoot, 'submodule', 'dotnet-skills')),
  };
}

function readDefaultRef() {
  if (!existsSync(upstreamManifestPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(upstreamManifestPath, 'utf8'));
    return typeof parsed.tag === 'string' && parsed.tag !== '' ? parsed.tag : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prove the checkout sits at the requested ref, cloning it when there is none.
 *
 * @returns {string} absolute path to a checkout at `ref`
 */
function ensureCheckout(source) {
  const head = tryGit(source.checkout, ['rev-parse', 'HEAD']);
  if (head !== undefined) {
    const matches = source.ref === head || source.ref === head.slice(0, source.ref.length) ||
      tryGit(source.checkout, ['tag', '--points-at', 'HEAD'])?.split('\n').includes(source.ref) === true;
    if (!matches) {
      throw new SyncError(
        `${source.checkout} is at ${head}, not ${source.ref}.\n` +
          '  This pipeline never moves an existing checkout. Check the ref out yourself, or pass --from <dir>.',
      );
    }
    process.stdout.write(`source: local checkout ${source.checkout} at ${head.slice(0, 12)}\n`);
    return source.checkout;
  }

  const target = join(tmpdir(), `dotnet-skills-${source.ref.replace(/[^A-Za-z0-9._-]/g, '_')}-${process.pid}`);
  rmSync(target, { recursive: true, force: true });
  process.stdout.write(`source: no checkout at ${source.checkout}; cloning ${source.repo} at ${source.ref}\n`);
  gitInherit(undefined, ['clone', '--filter=blob:none', '--no-checkout', source.repo, target]);
  gitInherit(target, ['fetch', '--depth', '1', 'origin', source.ref]);
  gitInherit(target, ['checkout', '--detach', 'FETCH_HEAD']);
  return target;
}

function resolveTag(checkout, ref, commit) {
  try {
    const exact = git(checkout, ['describe', '--tags', '--exact-match', commit]);
    return exact;
  } catch {
    return ref;
  }
}

/**
 * Walk every plugin under the source, parsing each `SKILL.md`.
 *
 * All five validation rules of the plan's W2 table live here, because a snapshot that
 * reaches `vendor/` has to be provably well formed: the runtime is not allowed to
 * repair it (§5.3, §6.6).
 */
function collectInventory(pluginRoot, pluginNames) {
  /** @type {Map<string, string[]>} */
  const perPlugin = new Map();
  /** @type {string[]} */
  const skills = [];
  /** @type {Map<string, string>} */
  const owner = new Map();
  /** @type {string[]} */
  const problems = [];
  /** @type {object[]} */
  const details = [];

  for (const plugin of pluginNames) {
    const directory = join(pluginRoot, plugin, 'skills');
    if (!existsSync(directory)) {
      perPlugin.set(plugin, []);
      continue;
    }
    /** @type {string[]} */
    const names = [];
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const skillFile = join(directory, name, 'SKILL.md');
      if (!isSkillName(name)) {
        problems.push(`${plugin}/skills/${name}: directory name violates the skill-name grammar`);
        continue;
      }
      if (!existsSync(skillFile)) {
        problems.push(`${plugin}/skills/${name}: no SKILL.md`);
        continue;
      }
      const previous = owner.get(name);
      if (previous !== undefined) {
        problems.push(
          `skill name ${JSON.stringify(name)} appears in both ${previous} and ${plugin}; ` +
            'duplicates shadow each other silently in the host registry',
        );
        continue;
      }
      const raw = readFileSync(skillFile, 'utf8');
      const crlf = raw.includes('\r\n');
      let parsed;
      try {
        parsed = parseDocument(raw);
      } catch (error) {
        const detail = error instanceof FrontmatterError ? error.message : String(error);
        problems.push(`${plugin}/skills/${name}/SKILL.md: ${detail}`);
        continue;
      }
      const required = readRequiredKeys(parsed.frontmatter);
      if (!required.ok) {
        problems.push(`${plugin}/skills/${name}/SKILL.md: ${required.reason}`);
        continue;
      }
      if (required.name !== name) {
        problems.push(
          `${plugin}/skills/${name}/SKILL.md: frontmatter name ${JSON.stringify(required.name)} ` +
            `does not match its directory name`,
        );
        continue;
      }
      if (crlf) problems.push(`${plugin}/skills/${name}/SKILL.md: contains CRLF line endings`);
      owner.set(name, plugin);
      names.push(name);
      skills.push(name);
      details.push({
        plugin,
        name,
        description: normalizeText(required.description),
        userInvocable: required.userInvocable,
        resources: resourceDirectories(join(directory, name)),
      });
    }
    perPlugin.set(plugin, names);
  }

  if (problems.length > 0) {
    throw new SyncError(`snapshot validation failed:\n  ${problems.join('\n  ')}`);
  }
  skills.sort();
  return { pluginNames, perPlugin, skills, skillCount: skills.length, details };
}

/** Resource subdirectories a skill ships, so the status tool can warn about them (§2.7). */
function resourceDirectories(skillDir) {
  const known = ['references', 'scripts', 'extensions', 'assets'];
  /** @type {Record<string, number>} */
  const found = {};
  for (const name of known) {
    const directory = join(skillDir, name);
    if (!existsSync(directory)) continue;
    found[name] = readdirSync(directory).length;
  }
  return found;
}

/**
 * Read `plugin.json` for the selected plugins and confirm each declared skills
 * directory really contains the skills the walk found.
 *
 * This is what keeps "the plugin says it publishes these" and "the snapshot actually
 * carries these" from drifting apart, without copying directories the plugin never
 * declared.
 */
function collectPlugins(sourceRoot, pluginNames, inventory) {
  /** @type {object[]} */
  const pluginMetadata = [];
  /** @type {string[]} */
  const problems = [];
  let skillCount = 0;

  for (const name of pluginNames) {
    const pluginDir = join(sourceRoot, 'plugins', name);
    const manifestPath = join(pluginDir, PLUGIN_MANIFEST);
    if (!existsSync(manifestPath)) {
      problems.push(`plugins/${name}: no ${PLUGIN_MANIFEST}`);
      continue;
    }
    const manifest = readJson(manifestPath);
    const actual = inventory.perPlugin.get(name) ?? [];
    if (manifest.name !== name) {
      problems.push(`plugins/${name}/${PLUGIN_MANIFEST}: name is ${JSON.stringify(manifest.name)}`);
    }
    if (!Array.isArray(manifest.skills) || manifest.skills.some((dir) => typeof dir !== 'string')) {
      problems.push(`plugins/${name}/${PLUGIN_MANIFEST}: "skills" must be an array of directory strings`);
      continue;
    }
    const declaredNames = new Set();
    for (const dir of manifest.skills) {
      const declaredDir = resolve(pluginDir, dir);
      if (!existsSync(declaredDir)) {
        problems.push(`plugins/${name}/${PLUGIN_MANIFEST}: declared skills directory ${dir} does not exist`);
        continue;
      }
      for (const entry of readdirSync(declaredDir, { withFileTypes: true })) {
        if (entry.isDirectory()) declaredNames.add(entry.name);
      }
    }
    for (const skill of actual) {
      if (!declaredNames.has(skill)) {
        problems.push(
          `plugins/${name}: skill ${JSON.stringify(skill)} is present on disk but not covered by the declared skills directories`,
        );
      }
    }
    skillCount += actual.length;
    pluginMetadata.push({
      name,
      version: manifest.version ?? null,
      description: manifest.description ?? null,
      dirs: manifest.skills,
      agents: manifest.agents ?? null,
      lspServers: manifest.lspServers ?? null,
      skills: actual,
    });
  }

  if (problems.length > 0) throw new SyncError(`plugin manifests failed validation:\n  ${problems.join('\n  ')}`);
  return { names: pluginNames, skillCount, pluginMetadata };
}

function writeSnapshot(sourceRoot, pluginNames) {
  mkdirSync(snapshotRoot, { recursive: true });
  for (const entry of readdirSync(snapshotRoot)) {
    if (entry === 'LICENSE') continue;
    rmSync(join(snapshotRoot, entry), { recursive: true, force: true });
  }
  for (const name of pluginNames) {
    cpSync(join(sourceRoot, 'plugins', name), join(snapshotRoot, name), { recursive: true, dereference: false });
  }
  if (!existsSync(join(snapshotRoot, 'LICENSE'))) {
    const license = join(sourceRoot, 'LICENSE');
    if (existsSync(license)) cpSync(license, join(snapshotRoot, 'LICENSE'));
  }
  process.stdout.write(`snapshot: ${pluginNames.length} plugins written to ${relative(process.cwd(), snapshotRoot)}\n`);
}

function writeUpstreamManifest({
  source,
  tag,
  commit,
  pluginNames,
  marketplaceNames,
  outOfRangePlugins,
  extraPlugins,
  inventory,
  digest,
  pluginMetadata,
}) {
  const metadataByName = new Map(pluginMetadata.map((plugin) => [plugin.name, plugin]));
  const manifest = {
    repo: 'https://github.com/dotnet/skills',
    tag,
    commit,
    fetchedAt: new Date().toISOString(),
    source: {
      kind: source.explicitRef ? 'explicit-ref' : 'recorded-tag',
      ref: source.ref,
      checkout: relative(packageRoot, source.checkout).split(sep).join('/'),
    },
    includedPlugins: pluginNames.map((name) => {
      const metadata = metadataByName.get(name) ?? {};
      return {
        name,
        version: metadata.version ?? null,
        description: metadata.description ?? null,
        skillCount: (inventory.perPlugin.get(name) ?? []).length,
        skills: inventory.perPlugin.get(name) ?? [],
        skillDirs: metadata.dirs ?? [],
        agents: metadata.agents ?? null,
        lspServers: metadata.lspServers ?? null,
      };
    }),
    // Marketplace plugins present upstream but deliberately outside this snapshot (§2.2).
    excludedPlugins: extraPlugins.map((name) => ({
      name,
      reason: 'not listed in .claude-plugin/marketplace.json, the upstream recommended set',
      skills: inventory.perPlugin.get(name) ?? [],
    })),
    // Marketplace plugins this run narrowed away with --plugins. Empty in a full sync.
    outOfRangePlugins: outOfRangePlugins.map((name) => ({
      name,
      skills: inventory.perPlugin.get(name) ?? [],
    })),
    marketplacePlugins: marketplaceNames,
    upstreamInventory: {
      pluginCount: inventory.pluginNames.length,
      skillCount: inventory.skillCount,
      skills: inventory.skills,
    },
    skillCount: pluginNames.reduce((total, name) => total + (inventory.perPlugin.get(name) ?? []).length, 0),
    skills: inventory.details
      .filter((detail) => pluginNames.includes(detail.plugin))
      .map((detail) => ({
        plugin: detail.plugin,
        name: detail.name,
        descriptionChars: Array.from(detail.description).length,
        userInvocable: detail.userInvocable,
        resources: detail.resources,
      })),
    snapshotSha256: digest.sha256,
    snapshotFiles: digest.files,
    snapshotBytes: digest.bytes,
  };
  writeFileSync(upstreamManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function report(options, source, { pluginNames, inventory, failures, tag, commit }) {
  process.stdout.write(`ref: ${source.ref}${source.explicitRef ? '' : ' (from vendor/UPSTREAM.json)'}, tag ${tag}, commit ${commit}\n`);
  process.stdout.write(`inventory: ${inventory.pluginNames.length} plugins / ${inventory.skillCount} skills\n`);
  for (const name of pluginNames) {
    const skills = inventory.perPlugin.get(name) ?? [];
    process.stdout.write(`  ${name}: ${skills.length} skills\n`);
  }
  if (options.plugins !== undefined && pluginNames.length !== inventory.pluginNames.length) {
    process.stdout.write(`range: narrowed by --plugins to ${pluginNames.length} of ${inventory.pluginNames.length} plugins\n`);
  }
  for (const failure of failures) process.stdout.write(`warning: ${failure}\n`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SyncError(`cannot read ${path}: ${error.message}`);
  }
}

/**
 * Run git and capture its stdout.
 *
 * Output is captured through a temporary file rather than a pipe on purpose: under the
 * restricted sandbox this pipeline is developed in, a spawned child cannot inherit a
 * pipe at all (`spawn … EPERM`), and a sync script that only works outside the sandbox
 * is not usable. File redirection is what keeps `git rev-parse` working inside it.
 */
function git(cwd, args) {
  const capture = join(mkdtempSync(join(tmpdir(), 'dotnet-skills-git-')), 'stdout');
  try {
    runGit(cwd, args, ['ignore', 'inherit', 'inherit'], capture);
    return readFileSync(capture, 'utf8').trim();
  } finally {
    rmSync(dirname(capture), { recursive: true, force: true });
  }
}

/** Run git with its own progress going straight to this process's streams. */
function gitInherit(cwd, args) {
  runGit(cwd, args, ['ignore', 'inherit', 'inherit'], undefined);
}

function runGit(cwd, args, stdio, stdoutFile) {
  const result = spawnSync('git', args, {
    cwd,
    stdio: stdoutFile === undefined ? stdio : [stdio[0], openSync(stdoutFile, 'w'), stdio[2]],
  });
  if (result.error !== undefined) {
    throw new SyncError(`git ${args.join(' ')} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new SyncError(`git ${args.join(' ')} failed with exit code ${String(result.status)}`);
  }
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

try {
  if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = main(process.argv.slice(2));
  }
} catch (error) {
  process.stderr.write(`sync-snapshot: ${error instanceof SyncError ? error.message : (error.stack ?? String(error))}\n`);
  process.exitCode = 1;
}
