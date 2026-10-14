/**
 * The Windows adapter (doc/spec.md §10.4).
 *
 * Everything platform-specific about a deployment lives in this directory, and this module is the
 * Windows half: where a deployment belongs, and what a refused symlink means here. It deliberately
 * knows nothing about skills, manifests or the snapshot — it answers two questions and stops.
 */

import { join } from 'node:path';

/** @type {string} */
export const platform = 'win32';

/**
 * Where a deployment belongs when the operator does not name a root of their own.
 *
 * This is the Harness's own user skill root, not a directory invented for this plugin: a deployment
 * there is discovered by the host's filesystem provider (rank 400) with no configuration at all,
 * which is the whole point of the second entry point in §10.1. `DSH_HOME` wins when the Harness was
 * installed somewhere other than the default, because that is the directory the host itself scans.
 *
 * @param {{ env?: Record<string, string | undefined>, home: string }} input
 * @returns {string}
 */
export function defaultDeployRoot({ env = process.env, home }) {
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : join(home, '.dsh');
  return join(dshHome, 'skills');
}

/**
 * What a refused symlink means on Windows, for the log line and the status report.
 *
 * The privilege model, as confirmed by the operator of the machine this was measured on: creating a
 * symlink is granted to administrators by default, and to everyone else only through Developer Mode or
 * a group policy that grants `SeCreateSymbolicLinkPrivilege` — so the default answer on a normal user's
 * machine is "refused", which is why §10.3 probes and why the copy fallback has to be good rather than
 * an afterthought. A restricted sandbox can also deny the call for this process even on a machine that
 * is configured for it, which is exactly what happened here: the same machine refused the link from
 * inside the Harness's file sandbox and allowed it outside.
 *
 * Phrased as the list of plausible causes rather than as a diagnosis, because the code alone does not
 * identify one.
 *
 * @param {string | undefined} code
 * @returns {string | undefined}
 */
export function symlinkHint(code) {
  if (code === 'EPERM' || code === 'EACCES') {
    return (
      'Windows grants symlink creation to administrators by default, and to other accounts only through ' +
      'Developer Mode or a group policy granting SeCreateSymbolicLinkPrivilege; a restricted sandbox or ' +
      'a OneDrive-managed folder can also refuse it for this process alone, which is what a copy ' +
      'deployment is for'
    );
  }
  return undefined;
}

/**
 * Fold a path for comparison, because this platform's filesystem does not distinguish case.
 *
 * Callers that compare paths — the deployment kernel against its manifest, a session audit against the
 * workspace root — must not decide this for themselves: the answer is a platform property, and §10.4
 * keeps platform properties here.
 *
 * The long-path prefix is stripped as well, because it is an artifact Windows attaches to some paths
 * and not others: a directory symlink created by `fs.symlinkSync` reads back as `\\?\C:\…` while its
 * target was written as `C:\…`, and a byte comparison of the two says they differ when they do not.
 * Measured, not assumed: this is what made a re-deployment try to create a link that already existed.
 *
 * @param {string} path
 * @returns {string}
 */
export function foldPath(path) {
  const withoutPrefix = path.startsWith('\\\\?\\UNC\\')
    ? `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
    : path.startsWith('\\\\?\\')
      ? path.slice('\\\\?\\'.length)
      : path;
  return withoutPrefix.toLowerCase();
}
