#!/usr/bin/env node
/**
 * The description authoring gates (doc/spec.md §7.2, §7.5, §7.7).
 *
 *   node tools/descriptions.mjs prepare [--out .authoring/descriptions-input.json]
 *   node tools/descriptions.mjs verify  [--allow-gaps] [--source <dir>] [--quiet]
 *
 * `prepare` emits the authoring input pack: the folded upstream text, its digest, the label
 * obligations, and the pointer lists split into "must keep" and "droppable but reported".
 * `verify` mechanically checks the ten invariants plus the drift conditions and exits
 * non-zero on any violation, which is what turns upstream drift into explicit friction
 * instead of silent rot.
 *
 * All of the logic lives in `lib/descriptions.js` and `lib/pointers.js` so the same
 * implementation answers the CLI and the unit tests; this file only decides exit codes and
 * formats the human-readable report.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import {
  buildAuthoringPack,
  readPopulation,
  readSkills,
  verifyDescriptions,
} from '../lib/descriptions.js';
import { descriptionsPath, packageRoot, readUpstreamManifest } from '../lib/snapshot.js';

class GateError extends Error {}

function main(argv) {
  const command = argv[0];
  const options = parseArgs(argv.slice(1));
  if (command === 'prepare') return prepare(options);
  if (command === 'verify') return verify(options);
  process.stderr.write(
    'usage: node tools/descriptions.mjs <prepare|verify> [--allow-gaps] [--out <path>] [--source <dir>] [--quiet]\n',
  );
  return 2;
}

function parseArgs(argv) {
  const options = { allowGaps: false, quiet: false, out: undefined, source: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--allow-gaps':
        options.allowGaps = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--out':
        options.out = argv[++index];
        break;
      case '--source':
        options.source = argv[++index];
        break;
      default:
        throw new GateError(`unknown argument ${JSON.stringify(argv[index])}`);
    }
  }
  return options;
}

function loadManifest() {
  const read = readUpstreamManifest();
  if (!read.ok) throw new GateError(read.error);
  return read.manifest;
}

function loadData() {
  if (!existsSync(descriptionsPath)) throw new GateError(`missing authored data file: ${descriptionsPath}`);
  try {
    return JSON.parse(readFileSync(descriptionsPath, 'utf8'));
  } catch (error) {
    throw new GateError(`cannot parse ${descriptionsPath}: ${error.message}`);
  }
}

function prepare(options) {
  const manifest = loadManifest();
  const data = loadData();
  const population = options.source === undefined ? readPopulation() : { skills: readSkills(resolve(options.source)), source: resolve(options.source) };
  const pack = buildAuthoringPack({ manifest, data, skills: population.skills, source: population.source });

  const outPath = resolve(options.out ?? join(packageRoot, '.authoring', 'descriptions-input.json'));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');

  if (!options.quiet) {
    process.stdout.write(`authoring input written to ${relative(process.cwd(), outPath)}\n`);
    process.stdout.write(
      `population ${pack.counts.population} skills from ${pack.populationSource}; ` +
        `${pack.counts.authoringCovered} in-range skills need authored text, ` +
        `${pack.counts.authoringPending} still unwritten, ${pack.counts.passThrough} pass through\n`,
    );
  }
  return 0;
}

function verify(options) {
  const manifest = loadManifest();
  const data = loadData();
  const source = options.source === undefined ? undefined : resolve(options.source);
  const result = verifyDescriptions({
    manifest,
    data,
    ...(source === undefined ? {} : { skills: readSkills(source), source }),
    allowGaps: options.allowGaps,
  });
  report(options, manifest, result);
  return result.problems.length > 0 ? 1 : 0;
}

function report(options, manifest, result) {
  const { problems, warnings, census, budget, population, counts } = result;
  // --quiet silences the informational block, never the verdict: a gate that can be made
  // silent while still failing is a gate nobody notices failing.
  if (!options.quiet) {
    const write = (line) => process.stdout.write(`${line}\n`);
    write(`descriptions verify — ${manifest.tag} (${manifest.commit.slice(0, 8)}), snapshot ${manifest.skillCount} skills`);
    write(
      `population ${counts.population} skills from ${population.source}; budget ${budget}; authored entries ${counts.entries}`,
    );
    write(`pointer census: ${census.required.size} distinct in-range targets, ${census.dangling.size} dangling target(s)`);
    for (const [target, sources] of census.dangling) write(`  dangling: ${target} ← ${sources.join(', ')}`);
    if (counts.gaps > 0) write(`coverage gaps: ${counts.gaps}`);
    for (const warning of warnings) write(`warning: ${warning}`);
    if (problems.length === 0) {
      write('ok: every authored entry satisfies invariants ①–⑦ and ⑩, with no drift, gaps or orphans');
      return;
    }
    write('');
  } else if (problems.length === 0) {
    return;
  }
  for (const problem of problems) process.stdout.write(`error: ${problem}\n`);
  process.stdout.write(`\n${problems.length} problem(s)\n`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`descriptions: ${error instanceof GateError ? error.message : (error.stack ?? String(error))}\n`);
  process.exitCode = 1;
}
