/**
 * The deployment manifest (doc/spec.md §10.2).
 *
 * The manifest is what makes reclamation precise. A copy-mode deployment cannot be cleaned up by
 * emptying the root — the root is a directory a human may also put things in — so every path this
 * plugin materialized is written down, and only those paths are ever removed. A corrupt manifest is
 * therefore not a cosmetic problem: without it the plugin cannot tell its own files from the user's,
 * and `deploy` refuses to run rather than guess.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Written at the deploy root. Hidden-ish, and named after the plugin rather than the tool. */
export const MANIFEST_NAME = '.dsh-dotnet-skills-manifest.json';

/** Bump only when the manifest's shape changes in a way an older reader would misread. */
export const MANIFEST_VERSION = 1;

/**
 * Read the manifest at a deploy root.
 *
 * Three outcomes are distinguishable on purpose: absent (nothing was ever deployed here), present and
 * unreadable (something is wrong and reclaim must not proceed), and present and parsed.
 *
 * @param {string} root
 * @returns {{ present: boolean, ok: boolean, path: string, manifest?: object, error?: string }}
 */
export function readManifest(root) {
  const path = join(root, MANIFEST_NAME);
  if (!existsSync(path)) return { present: false, ok: true, path };
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) {
      return { present: true, ok: false, path, error: 'the manifest has no entries array' };
    }
    return { present: true, ok: true, path, manifest };
  } catch (error) {
    return { present: true, ok: false, path, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Write the manifest, entries sorted by skill so that two identical deployments produce identical
 * bytes and a diff of the root means something changed.
 *
 * @param {string} root
 * @param {object} manifest
 * @returns {string} the path written
 */
export function writeManifest(root, manifest) {
  const path = join(root, MANIFEST_NAME);
  const ordered = {
    ...manifest,
    manifestVersion: MANIFEST_VERSION,
    entries: [...(manifest.entries ?? [])].sort((left, right) => (left.skill < right.skill ? -1 : left.skill > right.skill ? 1 : 0)),
  };
  writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
  return path;
}
