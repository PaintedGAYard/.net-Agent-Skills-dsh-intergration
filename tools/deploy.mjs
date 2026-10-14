/**
 * `tools/deploy.mjs` — materialize the selected skills onto disk (doc/spec.md §10).
 *
 * Deployment is not on the provider's data path: the catalog always comes from `vendor/upstream/**`.
 * This tool exists for the two other consumers of the same content — the host's own filesystem skill
 * provider, and a human or an external tool reading `SKILL.md` and its references directly.
 *
 * The selection it materializes is the same selection a session would get: the core set, the
 * configuration baseline, and project detection for `--cwd`. `--all` deploys the whole shipped range
 * for browsing, and `--plugins` / `--skills` add to the baseline exactly as they do in the plugin's
 * own configuration.
 *
 * ```
 * node tools/deploy.mjs --cwd . --dry-run          what would be written, and where
 * node tools/deploy.mjs --cwd .                    deploy the selection for this workspace
 * node tools/deploy.mjs --status                   what is deployed at the default root
 * node tools/deploy.mjs --all --root D:\browse     the whole range, somewhere private
 * ```
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveConfig } from '../lib/config.js';
import { deploy, inspectDeployment, readManifest } from '../lib/deploy/index.js';
import { createProjectDetector } from '../lib/detect.js';
import { selectAdapter } from '../lib/platform/index.js';
import { createSelectionService } from '../lib/selection.js';
import { createSnapshotSource } from '../lib/source-snapshot.js';
import { readUpstreamManifest } from '../lib/snapshot.js';

/**
 * Parse argv into `{ root, cwd, plugins, skills, all, status, dryRun, json }`.
 *
 * Returns an error string rather than throwing, the way the other tools in this directory do.
 *
 * @param {string[]} argv
 * @returns {object | string}
 */
export function parseArgv(argv) {
  const options = { root: undefined, cwd: undefined, plugins: [], skills: [], all: false, status: false, dryRun: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--all') options.all = true;
    else if (argument === '--status') options.status = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--root' || argument === '--cwd' || argument === '--plugins' || argument === '--skills') {
      const value = argv[index + 1];
      if (value === undefined) return `${argument} needs a value`;
      index += 1;
      if (argument === '--root') options.root = value;
      else if (argument === '--cwd') options.cwd = value;
      else if (argument === '--plugins') options.plugins = splitList(value);
      else options.skills = splitList(value);
    } else return `unrecognised argument ${JSON.stringify(argument)}`;
  }
  return options;
}

function splitList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * The deploy root: what the operator named, or the platform's convention.
 *
 * @param {string | undefined} requested
 * @param {object} adapter
 * @returns {string}
 */
export function resolveRoot(requested, adapter) {
  return requested ?? adapter.defaultDeployRoot({ home: homedir() });
}

/**
 * Build the entries a deployment would write: the selected skills, each with its snapshot directory.
 *
 * @param {object} input
 * @param {object} input.source - snapshot content source
 * @param {object} input.selection - the `dotnetSkills` service
 * @param {string | undefined} input.cwd - workspace to select for
 * @returns {{ entries: Array<{ skill: string, plugin: string, source: string }>, missing: string[], selected: string[] }}
 */
export function collectEntries({ source, selection, cwd }) {
  const folded = selection.fold({ cwd });
  const entries = [];
  const missing = [];
  for (const skill of folded.names) {
    const plugin = selection.ownerOf.get(skill);
    const record =
      plugin === undefined ? undefined : (source.resolve(plugin)?.skills ?? []).find((candidate) => candidate.name === skill);
    if (record === undefined) {
      // Selection can name a skill this release does not ship — configuration written for a different
      // range. The provider journals it; a deployment simply cannot materialize it.
      missing.push(skill);
      continue;
    }
    entries.push({ skill, plugin, source: record.skillDir });
  }
  return { entries, missing, selected: folded.names };
}

function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (typeof parsed === 'string') {
    process.stderr.write(`deploy: ${parsed}\n`);
    process.stderr.write(
      'usage: node tools/deploy.mjs [--cwd <dir>] [--root <dir>] [--plugins a,b] [--skills x,y] ' +
        '[--all] [--status] [--dry-run] [--json]\n',
    );
    process.exitCode = 2;
    return;
  }

  let adapter;
  try {
    adapter = selectAdapter();
  } catch (error) {
    process.stderr.write(`deploy: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const root = resolveRoot(parsed.root, adapter);

  if (parsed.status) {
    const inspection = inspectDeployment({ root, adapter });
    if (parsed.json) process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
    else process.stdout.write(renderStatus(inspection));
    process.exitCode = inspection.dangling.length > 0 ? 1 : 0;
    return;
  }

  const manifestRead = readUpstreamManifest();
  if (!manifestRead.ok) {
    process.stderr.write(`deploy: ${manifestRead.error}\n`);
    process.exitCode = 2;
    return;
  }
  const manifest = manifestRead.manifest;
  const plugins = (manifest.includedPlugins ?? []).map((plugin) => plugin.name);
  const source = createSnapshotSource({ plugins });
  const config = resolveConfig({
    enabledPlugins: parsed.all ? plugins : parsed.plugins,
    enabledSkills: parsed.skills,
  });
  const detection = createProjectDetector({ config });
  const selection = createSelectionService({
    config,
    manifest,
    pluginSkills: source.pluginSkills(),
    detect: (context) => detection(context),
  });

  const { entries, missing, selected } = collectEntries({ source, selection, cwd: parsed.cwd });
  for (const skill of missing) process.stderr.write(`deploy: selection names "${skill}", which this release does not ship; skipping\n`);

  if (parsed.dryRun) {
    const previous = readManifest(root);
    const wanted = new Set(entries.map((entry) => entry.skill));
    const plan = {
      root,
      mode: 'decided by the symlink probe when this runs',
      selected: selected.length,
      write: entries.map((entry) => join(root, entry.skill)),
      remove: (previous.manifest?.entries ?? []).filter((entry) => !wanted.has(entry.skill)).map((entry) => entry.deployed ?? join(root, entry.skill)),
      manifest: previous.path,
    };
    process.stdout.write(parsed.json ? `${JSON.stringify(plan, null, 2)}\n` : renderPlan(plan));
    return;
  }

  let result;
  try {
    result = deploy({
      entries,
      root,
      adapter,
      snapshot: { tag: manifest.tag, commit: manifest.commit },
      log: (line) => process.stderr.write(`deploy: ${line}\n`),
    });
  } catch (error) {
    process.stderr.write(`deploy: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (parsed.json) process.stdout.write(`${JSON.stringify({ mode: result.mode, root: result.root, written: result.written, removed: result.removed, kept: result.kept, probe: result.probe, entries: result.manifest.entries }, null, 2)}\n`);
  else process.stdout.write(renderResult(result));
}

function renderStatus(inspection) {
  const lines = [`root: ${inspection.root}`, `mode: ${inspection.mode}`];
  if (inspection.entries > 0) lines.push(`skills deployed: ${inspection.entries}`);
  if (inspection.dangling.length > 0) lines.push(`dangling: ${inspection.dangling.join(', ')}`);
  if (inspection.degradedReason !== undefined) lines.push(`degraded because: ${inspection.degradedReason}`);
  if (inspection.reason !== undefined) lines.push(inspection.reason);
  return `${lines.join('\n')}\n`;
}

function renderPlan(plan) {
  const lines = [`root: ${plan.root}`, `manifest: ${plan.manifest}`, `selected: ${plan.selected}`];
  lines.push(`would write ${plan.write.length} entr${plan.write.length === 1 ? 'y' : 'ies'}:`);
  for (const path of plan.write) lines.push(`  ${path}`);
  if (plan.remove.length > 0) {
    lines.push(`would reclaim ${plan.remove.length}:`);
    for (const path of plan.remove) lines.push(`  ${path}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderResult(result) {
  const lines = [`mode: ${result.mode}`, `root: ${result.root}`, `wrote ${result.written.length} entr${result.written.length === 1 ? 'y' : 'ies'}`];
  if (result.removed.length > 0) lines.push(`reclaimed ${result.removed.length} path(s) from the previous deployment`);
  for (const line of result.kept) lines.push(`kept ${line}`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
