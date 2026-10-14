/**
 * The bundled upstream snapshot: locating it, its provenance record, and its
 * integrity digest.
 *
 * `vendor/upstream/**` is the only content this plugin serves, and it is required to
 * be byte-identical to the pinned upstream ref (spec §6.6). `vendor/UPSTREAM.json` is
 * the single source of truth for "which upstream ref is this" (§3.1); nothing here
 * consults the network or the clock, so the runtime stays deterministic (§3.2).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the package root (the directory holding `index.js`). */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directory holding the byte-exact upstream snapshot. */
export const snapshotRoot = join(packageRoot, 'vendor', 'upstream');

/** Provenance record for the snapshot. */
export const upstreamManifestPath = join(packageRoot, 'vendor', 'UPSTREAM.json');

/** Directory holding the authored description overrides. */
export const descriptionsPath = join(packageRoot, 'data', 'descriptions.json');

/**
 * The development checkout of the upstream repository, when one is present.
 *
 * Development-side tooling uses it to see the complete pinned ref — all 12 plugins and 76
 * names — even while the shipped snapshot range is narrow. Nothing in the running provider
 * reads it; §3.2 keeps the runtime offline and snapshot-only.
 */
export function checkoutFallback() {
  return join(packageRoot, 'submodule', 'dotnet-skills');
}

/**
 * Read and check the provenance record.
 *
 * @returns {{ ok: true, manifest: object } | { ok: false, error: string, manifest?: undefined }}
 */
export function readUpstreamManifest() {
  if (!existsSync(upstreamManifestPath)) {
    return { ok: false, error: `missing snapshot provenance file: ${upstreamManifestPath}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(upstreamManifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, error: `cannot parse ${upstreamManifestPath}: ${error.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `${upstreamManifestPath} must contain a JSON object` };
  }
  if (typeof parsed.tag !== 'string' || typeof parsed.commit !== 'string') {
    return { ok: false, error: `${upstreamManifestPath} must carry string "tag" and "commit" fields` };
  }
  if (!Array.isArray(parsed.includedPlugins)) {
    return { ok: false, error: `${upstreamManifestPath} must carry an "includedPlugins" array` };
  }
  return { ok: true, manifest: parsed };
}

/**
 * Every regular file under the snapshot, as snapshot-relative POSIX paths.
 *
 * @param {string} [root]
 * @returns {string[]} sorted, deterministic order
 */
export function listSnapshotFiles(root = snapshotRoot) {
  /** @type {string[]} */
  const files = [];
  if (!existsSync(root)) return files;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  files.sort();
  return files;
}

/**
 * Digest over the whole snapshot: `sha256` of `path \0 content \0` for each file,
 * in sorted path order.
 *
 * Purpose is drift detection, not security: it answers "was the snapshot edited
 * outside the sync pipeline" (§3.1). It is stable across platforms because paths are
 * POSIX-joined and file bytes are used verbatim.
 *
 * @param {string} [root]
 * @returns {{ sha256: string, files: number, bytes: number }}
 */
export function computeSnapshotSha256(root = snapshotRoot) {
  const hash = createHash('sha256');
  const files = listSnapshotFiles(root);
  let bytes = 0;
  for (const path of files) {
    const content = readFileSync(join(root, path.split('/').join(sep)));
    hash.update(path, 'utf8');
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
    bytes += content.length;
  }
  return { sha256: hash.digest('hex'), files: files.length, bytes };
}

/**
 * Compare the recorded digest with the snapshot on disk.
 *
 * @returns {{ ok: boolean, recorded?: string, actual?: string, files?: number, bytes?: number,
 *             error?: string }}
 */
export function verifySnapshotIntegrity(manifest = undefined) {
  const read = manifest === undefined ? readUpstreamManifest() : { ok: true, manifest };
  if (!read.ok) return { ok: false, error: read.error };
  const recorded = read.manifest.snapshotSha256;
  if (typeof recorded !== 'string' || recorded === '') {
    return { ok: false, error: 'snapshot provenance has no snapshotSha256' };
  }
  if (!existsSync(snapshotRoot)) {
    return { ok: false, error: `snapshot directory is missing: ${snapshotRoot}`, recorded };
  }
  const actual = computeSnapshotSha256();
  return {
    ok: actual.sha256 === recorded,
    recorded,
    actual: actual.sha256,
    files: actual.files,
    bytes: actual.bytes,
  };
}

/**
 * Snapshot age in whole days, or `undefined` when the record has no usable timestamp.
 *
 * @param {object} manifest
 * @param {number} [now] - milliseconds since epoch; injectable so the caller owns the clock
 * @returns {number | undefined}
 */
export function snapshotAgeDays(manifest, now = Date.now()) {
  const fetchedAt = manifest?.fetchedAt;
  if (typeof fetchedAt !== 'string') return undefined;
  const time = Date.parse(fetchedAt);
  if (Number.isNaN(time)) return undefined;
  return Math.max(0, Math.floor((now - time) / 86_400_000));
}

/**
 * Cheap line-ending audit: true when every text file under the snapshot uses LF (§5.3).
 *
 * @param {string} [root]
 * @returns {{ ok: boolean, offenders: string[] }}
 */
export function auditLineEndings(root = snapshotRoot) {
  /** @type {string[]} */
  const offenders = [];
  for (const path of listSnapshotFiles(root)) {
    const full = join(root, path.split('/').join(sep));
    if (statSync(full).size > 4 * 1024 * 1024) continue;
    const buffer = readFileSync(full);
    if (buffer.includes(0)) continue;
    if (buffer.includes('\r\n')) offenders.push(path);
  }
  return { ok: offenders.length === 0, offenders };
}
