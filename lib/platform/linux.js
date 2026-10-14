/**
 * The Linux adapter (doc/spec.md §10.4).
 *
 * The deployment code is shared with Windows on purpose — §10.3 forbids `if (linux) use symlink`,
 * because Linux is not a permission model, it is a platform whose *default* answer differs. A target
 * on FAT/exFAT or a network mount fails the probe here exactly as it does on Windows.
 */

import { join } from 'node:path';

/** @type {string} */
export const platform = 'linux';

/**
 * Where a deployment belongs when the operator does not name a root of their own.
 *
 * The same convention as Windows, and for the same reason: `~/.dsh/skills` is the directory the
 * Harness's own filesystem provider scans. Only the path semantics differ, and `node:path` handles
 * those.
 *
 * @param {{ env?: Record<string, string | undefined>, home: string }} input
 * @returns {string}
 */
export function defaultDeployRoot({ env = process.env, home }) {
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : join(home, '.dsh');
  return join(dshHome, 'skills');
}

/**
 * What a refused symlink means here.
 *
 * @param {string | undefined} code
 * @returns {string | undefined}
 */
export function symlinkHint(code) {
  if (code === 'EPERM' || code === 'EACCES' || code === 'EINVAL') {
    return (
      'the target filesystem may not carry symbolic links or may not permit them — FAT/exFAT and ' +
      'network mounts are the usual reasons, a mounted Windows path behaves like Windows here rather ' +
      'than like Linux (spec §10.5), and a sandbox can deny the call for this process'
    );
  }
  return undefined;
}

/**
 * Fold a path for comparison. This platform's filesystems are case-sensitive, so folding is identity.
 *
 * @param {string} path
 * @returns {string}
 */
export function foldPath(path) {
  return path;
}
