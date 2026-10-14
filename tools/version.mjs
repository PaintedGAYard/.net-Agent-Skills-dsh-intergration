#!/usr/bin/env node
/**
 * Reconcile the snapshot provenance with the changelog (doc/spec.md §3.3).
 *
 * The plugin's version line is independent of upstream, so the only place the correspondence
 * between "this release" and "that upstream ref" is written down is `CHANGELOG.md`. This script is
 * the audit that keeps the two honest: it fails when someone re-syncs the snapshot and forgets to
 * record which upstream ref they landed on. It computes no version numbers — `package.json` is
 * owned by release-please.
 *
 * Usage: node tools/version.mjs [--quiet]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { packageRoot, readUpstreamManifest, verifySnapshotIntegrity } from '../lib/snapshot.js';

const changelogPath = join(packageRoot, 'CHANGELOG.md');
const packagePath = join(packageRoot, 'package.json');
const manifestPath = join(packageRoot, '.release-please-manifest.json');

function main(argv) {
  const quiet = argv.includes('--quiet');
  const problems = [];

  const read = readUpstreamManifest();
  if (!read.ok) {
    fail([read.error]);
    return;
  }
  const manifest = read.manifest;

  if (!existsSync(changelogPath)) {
    fail([`missing ${changelogPath}`]);
    return;
  }
  const changelog = readFileSync(changelogPath, 'utf8');
  const entry = latestUpstreamLine(changelog);
  if (entry === undefined) {
    fail([
      'CHANGELOG.md has no "Upstream: dotnet/skills <tag> (<short-commit>), N plugins / M skills" line',
    ]);
    return;
  }

  if (entry.tag !== manifest.tag) {
    problems.push(`changelog records upstream tag ${entry.tag}, vendor/UPSTREAM.json says ${manifest.tag}`);
  }
  if (manifest.commit.slice(0, entry.commit.length) !== entry.commit) {
    problems.push(
      `changelog records commit ${entry.commit}, vendor/UPSTREAM.json says ${manifest.commit.slice(0, entry.commit.length)}`,
    );
  }
  if (entry.plugins !== (manifest.includedPlugins ?? []).length) {
    problems.push(
      `changelog records ${entry.plugins} plugins, vendor/UPSTREAM.json lists ${(manifest.includedPlugins ?? []).length}`,
    );
  }
  if (entry.skills !== manifest.skillCount) {
    problems.push(`changelog records ${entry.skills} skills, vendor/UPSTREAM.json says ${manifest.skillCount}`);
  }

  const integrity = verifySnapshotIntegrity(manifest);
  if (!integrity.ok) {
    problems.push(
      integrity.error ?? `snapshot digest mismatch: recorded ${integrity.recorded}, actual ${integrity.actual}`,
    );
  }

  const version = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  if (!/^\d+\.\d+\.\d+/.test(String(version))) problems.push(`package.json version ${version} is not semver`);
  if (existsSync(manifestPath)) {
    const released = JSON.parse(readFileSync(manifestPath, 'utf8'))['.'];
    if (released !== undefined && released !== version) {
      // Only a note: release-please advances the manifest and the package together in its own PR.
      if (!quiet) {
        process.stdout.write(
          `note: package.json is ${version} while .release-please-manifest.json says ${released}; ` +
            'that is expected between a release PR and its merge\n',
        );
      }
    }
  }

  if (problems.length > 0) {
    fail(problems);
    return;
  }
  if (!quiet) {
    process.stdout.write(
      `ok: CHANGELOG and vendor/UPSTREAM.json agree on ${manifest.tag} (${manifest.commit.slice(0, 8)}), ` +
        `${(manifest.includedPlugins ?? []).length} plugins / ${manifest.skillCount} skills; ` +
        `snapshot digest matches ${integrity.files} files; plugin version ${version}\n`,
    );
  }
}

/**
 * Parse the newest `Upstream:` line in the changelog.
 *
 * The first occurrence wins, because the changelog is newest-first.
 *
 * @param {string} changelog
 * @returns {{ tag: string, commit: string, plugins: number, skills: number } | undefined}
 */
function latestUpstreamLine(changelog) {
  const match = /Upstream:\s*dotnet\/skills\s+(\S+)\s+\(([0-9a-f]{7,40})\),\s*(\d+)\s+plugins?\s*\/\s*(\d+)\s+skills?/.exec(
    changelog,
  );
  if (match === null) return undefined;
  return { tag: match[1], commit: match[2], plugins: Number(match[3]), skills: Number(match[4]) };
}

function fail(problems) {
  for (const problem of problems) process.stdout.write(`error: ${problem}\n`);
  process.exitCode = 1;
}

main(process.argv.slice(2));
