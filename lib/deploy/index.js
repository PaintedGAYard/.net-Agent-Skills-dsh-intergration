/**
 * Materializing a skill selection onto disk (doc/spec.md §10).
 *
 * Deployment is the *second* entry point to the same content, never part of the provider's data path:
 * the provider always reads `vendor/upstream/**`, because a copy that can go stale is exactly the
 * failure this design refuses to have in the catalog. What deployment is for is the other two
 * consumers — a user who prefers the Harness's own filesystem provider, and a human or an external
 * tool reading `SKILL.md`, `references/` and `scripts/` directly.
 *
 * Three properties carry the design:
 *
 *   symlink first   snapshot updates land immediately and there is only ever one copy of the content
 *                   (§10.3). The privilege question is settled by creating a real link inside the
 *                   target directory and deleting it again — never by inspecting the platform, because
 *                   the answer differs per directory on the same machine;
 *   precise reclaim only paths the manifest records are ever removed, so a user's own files in the
 *                   deploy root — or inside a copied skill directory — survive a re-deployment;
 *   visible state   degradation is written into the manifest as well as the log, because a user who
 *                   believes edits take effect immediately while the host reads an old copy is the
 *                   most expensive failure to diagnose (§10.3).
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { readManifest, writeManifest } from './manifest.js';

export { MANIFEST_NAME, MANIFEST_VERSION, readManifest } from './manifest.js';

/**
 * Error codes that mean "this target cannot carry symlinks", as opposed to "something is wrong".
 *
 * The list is §10.3's, not a guess: `EPERM` is both the Windows privilege refusal and what Linux
 * returns for a filesystem without symlink support, `ENOSYS` is the syscall being unavailable, and
 * `UNKNOWN` is Node's mapping for a Windows error it does not recognise — which is precisely the case
 * the spec says to treat as unsupported rather than to report.
 */
const SYMLINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'UNKNOWN']);

/**
 * Create a real link inside the target directory and delete it again.
 *
 * @param {string} root
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
function realProbe(root) {
  const stamp = `${process.pid}-${Date.now()}`;
  const target = join(root, `.symlink-probe-${stamp}`);
  const link = `${target}.link`;
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(target, '', 'utf8');
    symlinkSync(target, link, 'file');
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
  } finally {
    for (const path of [link, target]) {
      try {
        unlinkSync(path);
      } catch {
        // Nothing to clean up: the probe never created it, or the cleanup failed on a path that is
        // about to be reported anyway.
      }
    }
  }
}

/**
 * Decide whether this target directory can carry symlinks.
 *
 * @param {string} root
 * @param {{ adapter?: object, probe?: (root: string) => { ok: boolean, code?: string, message?: string } }} [options]
 * @returns {{ ok: boolean, fallback: boolean, code?: string, message?: string, hint?: string }}
 */
export function probeSymlink(root, { adapter, probe = realProbe } = {}) {
  const result = probe(root);
  if (result.ok) return { ok: true, fallback: false };
  const code = result.code ?? 'UNKNOWN';
  const hint = adapter?.symlinkHint?.(code);
  return {
    ok: false,
    fallback: SYMLINK_UNSUPPORTED.has(code),
    code,
    message: result.message,
    ...(hint === undefined ? {} : { hint }),
  };
}

/**
 * Materialize a selection into a deploy root.
 *
 * @param {object} input
 * @param {Array<{ skill: string, plugin: string, source: string }>} input.entries - absolute source directories
 * @param {string} input.root - the deploy root
 * @param {object} [input.adapter] - the platform adapter, for the degradation hint
 * @param {(root: string) => { ok: boolean, code?: string, message?: string }} [input.probe] - injectable for tests
 * @param {{ tag?: string, commit?: string }} [input.snapshot] - recorded for provenance
 * @param {(line: string) => void} [input.log]
 * @param {() => Date} [input.now] - injectable clock, for tests that assert the manifest's shape
 * @returns {{ mode: 'symlink' | 'copy', root: string, written: string[], removed: string[], kept: string[], probe: object, manifest: object }}
 */
export function deploy({ entries, root, adapter, probe = realProbe, snapshot, log = () => {}, now = () => new Date() }) {
  const previous = readManifest(root);
  if (previous.present && !previous.ok) {
    // Refusing is the honest answer: without the manifest the plugin cannot distinguish its own files
    // from the user's, and the alternative — emptying the root — is how a deployment eats a user's work.
    throw new Error(
      `the deployment manifest at ${previous.path} is unreadable (${previous.error}); ` +
        'refusing to deploy, because nothing can be reclaimed precisely without it',
    );
  }

  const decision = probeSymlink(root, { adapter, probe });
  if (!decision.ok && !decision.fallback) {
    throw new Error(
      `the symlink probe in ${root} failed with ${decision.code}` +
        `${decision.message === undefined ? '' : `: ${decision.message}`}; ` +
        'this is not a "symlinks are unsupported" code, so it is reported rather than degraded',
    );
  }
  if (!decision.ok) {
    log(
      `symlinks are not available in ${root} (${decision.code}), so this deployment is a copy` +
        (decision.hint === undefined ? '' : `; ${decision.hint}`),
    );
  }

  const mode = decision.ok ? 'symlink' : 'copy';
  const wanted = [...entries].sort((left, right) => (left.skill < right.skill ? -1 : left.skill > right.skill ? 1 : 0));
  const wantedSkills = new Map(wanted.map((entry) => [entry.skill, entry]));
  const previousEntries = previous.manifest?.entries ?? [];
  const previousMode = previous.manifest?.mode;
  // Case folding and prefix normalization are platform properties, so they come from the adapter when
  // one is supplied and are identity otherwise (see lib/platform/win32.js for why this matters).
  const fold = typeof adapter?.foldPath === 'function' ? adapter.foldPath : (path) => path;

  // Reclaim first, and only what the manifest recorded. An entry is reclaimed when it is no longer
  // wanted, when its path moved, when the mode changed, or — in copy mode — always, because a copy has
  // to be refreshed wholesale or a file upstream deleted would live on in the root forever.
  const removed = [];
  const kept = [];
  for (const entry of previousEntries) {
    const target = wantedSkills.get(entry.skill);
    const samePath = fold(entry.deployed ?? '') === fold(join(root, entry.skill));
    const settled =
      target !== undefined &&
      samePath &&
      previousMode === mode &&
      // A link that already points at the right place needs no work; a copy is always refreshed, because
      // a file upstream deleted would otherwise live on in the root forever.
      (mode === 'copy' ? false : isLinkTo(entry.deployed, target.source, fold));
    if (settled) continue;
    const result = reclaim(entry, previousMode, root);
    removed.push(...result.removed);
    kept.push(...result.kept);
  }

  mkdirSync(root, { recursive: true });

  // A path that exists without being in the previous manifest is not ours. What happens next is the one
  // place where the copy mode is *safer* than the preferred one: a copy merges into whatever is there
  // and records only the files it wrote, while a link cannot be merged into a directory at all. Deleting
  // the user's directory to make room is the failure this design refuses to have, so that skill is
  // skipped and named instead, and the deployment is reported as incomplete rather than silently
  // destructive.
  const collisions = [];
  const skipped = [];
  for (const entry of wanted) {
    const deployed = join(root, entry.skill);
    if (!existsSync(deployed)) continue;
    const ours = previousEntries.some((previousEntry) => fold(previousEntry.deployed ?? '') === fold(deployed));
    if (ours) continue; // the reclaim loop above already removed it
    collisions.push(deployed);
    if (mode === 'symlink') {
      skipped.push(entry.skill);
      log(`${deployed} already exists and this plugin did not write it; skipping ${entry.skill} rather than deleting it`);
    } else {
      log(`${deployed} already exists and this plugin did not write it; the copy merges into it and leaves everything else alone`);
    }
  }
  const writable = skipped.length === 0 ? wanted : wanted.filter((entry) => !skipped.includes(entry.skill));

  let written;
  let manifest;
  try {
    written = mode === 'symlink' ? writeLinks(writable, root, fold) : writeCopies(writable, root);
    manifest = buildManifest({ mode, entries: written, root, snapshot, decision, now: now() });
  } catch (error) {
    if (mode !== 'symlink' || !SYMLINK_UNSUPPORTED.has(error?.code)) throw error;
    // The probe is a sample, not a guarantee: a directory inside the root can refuse on its own. The
    // whole batch degrades together (§10.3), so a root never mixes the two modes.
    log(`a symlink failed while writing (${error.code}), so the whole batch falls back to copies`);
    for (const entry of writable) removeOwnedPath(join(root, entry.skill));
    const degraded = { ok: false, fallback: true, code: error.code, message: String(error.message ?? '') };
    written = writeCopies(writable, root);
    manifest = buildManifest({ mode: 'copy', entries: written, root, snapshot, decision: degraded, now: now() });
    writeManifest(root, manifest);
    return { mode: 'copy', root, written: written.map((entry) => entry.deployed), removed, kept, collisions, skipped, probe: degraded, manifest };
  }

  writeManifest(root, manifest);
  return { mode, root, written: written.map((entry) => entry.deployed), removed, kept, collisions, skipped, probe: decision, manifest };
}

/**
 * Remove exactly what a previous manifest recorded, and nothing else.
 *
 * @param {{ skill: string, deployed: string, files?: string[] }} entry
 * @param {string | undefined} mode
 * @param {string} root
 * @returns {{ removed: string[], kept: string[] }}
 */
function reclaim(entry, mode, root) {
  const removed = [];
  const kept = [];
  const deployed = entry.deployed ?? join(root, entry.skill);

  if (mode !== 'copy') {
    // Symlink mode owns exactly one path, which is the link itself. `removeOwnedPath` never follows it.
    if (removeOwnedPath(deployed)) removed.push(deployed);
    return { removed, kept };
  }

  // Copy mode owns the files it wrote. A user file inside a deployed skill directory is not one of
  // them, so the directory survives — and says so, because silently keeping a directory is how "why is
  // the old skill still listed?" becomes a mystery.
  const files = entry.files ?? [];
  for (const file of files) {
    const path = join(deployed, file.split('/').join(sep));
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { force: true });
      removed.push(path);
    } catch (error) {
      kept.push(`${path} (${error?.code ?? 'error'})`);
    }
  }
  for (const directory of directoriesOf(files, deployed)) pruneEmptyDirectories(directory, deployed);
  if (!existsSync(deployed)) return { removed, kept };
  if (isEmptyDirectory(deployed)) {
    try {
      rmdirSync(deployed);
      removed.push(deployed);
    } catch (error) {
      kept.push(`${deployed} (${error?.code ?? 'error'})`);
    }
    return { removed, kept };
  }
  const leftover = readdirSync(deployed).length;
  kept.push(`${deployed} (kept: ${leftover} entr${leftover === 1 ? 'y' : 'ies'} this plugin did not write)`);
  return { removed, kept };
}

/** The distinct parent directories of a set of recorded files, deepest first. */
function directoriesOf(files, deployed) {
  const directories = files.map((file) => dirname(join(deployed, file.split('/').join(sep))));
  return [...new Set(directories)].sort((left, right) => right.length - left.length);
}

/** Remove a directory and its ancestors only while they are empty. */
function pruneEmptyDirectories(directory, stopAt) {
  let current = directory;
  while (current !== stopAt && current.startsWith(stopAt)) {
    if (!isEmptyDirectory(current)) return;
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function isEmptyDirectory(path) {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/**
 * Remove one path this plugin owns.
 *
 * A link is unlinked, never followed: `rmSync` on a symbolic link removes the link, but going through
 * `lstat` makes that explicit rather than incidental — a bug here deletes the snapshot.
 */
function removeOwnedPath(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return false;
  }
  try {
    if (stats.isSymbolicLink() || stats.isFile()) unlinkSync(path);
    else rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Symlink every wanted entry into the root, leaving a link that already points at the right place alone.
 *
 * Re-creating an existing link is not merely wasteful: on Windows it throws `EEXIST`, which would turn
 * "nothing changed" into a failed deployment. Measured, on the first real re-deployment.
 */
function writeLinks(wanted, root, fold = (value) => value) {
  return wanted.map((entry) => {
    const deployed = join(root, entry.skill);
    if (!isLinkTo(deployed, entry.source, fold)) symlinkSync(entry.source, deployed, 'dir');
    return { ...entry, deployed };
  });
}

/** Copy every wanted entry into the root, recording each file so reclaim stays precise. */
function writeCopies(wanted, root) {
  return wanted.map((entry) => {
    const deployed = join(root, entry.skill);
    cpSync(entry.source, deployed, { recursive: true, force: true });
    return { ...entry, deployed, files: listFiles(entry.source) };
  });
}

/**
 * Whether a path is a link pointing at a target.
 *
 * `fold` is the platform's path folding, because a byte comparison is not a path comparison: on
 * Windows an existing link read back as `\\?\C:\…` against a target of `C:\…` says "different link"
 * and produces a duplicate-link error on a re-deployment that should have done nothing.
 */
function isLinkTo(path, target, fold = (value) => value) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    return fold(resolve(readlinkSync(path))) === fold(resolve(target));
  } catch {
    return false;
  }
}

/** Every regular file under a directory, as sorted POSIX-relative paths. */
export function listFiles(root) {
  const files = [];
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

function buildManifest({ mode, entries, root, snapshot, decision, now }) {
  return {
    plugin: 'dsh-dotnet-skills',
    mode,
    root,
    updatedAt: now.toISOString(),
    snapshot: snapshot ?? null,
    ...(mode === 'copy' && decision?.fallback === true && decision.code !== undefined
      ? { degradedReason: `${decision.code}${decision.hint === undefined ? '' : ` — ${decision.hint}`}` }
      : {}),
    entries,
  };
}

/**
 * Inspect what is deployed at a root, for the status report (§11.4 item 6).
 *
 * `complete` is the deployment-level answer to "can every deployed skill still be read": a link whose
 * target was deleted, or a copy whose recorded files are missing, is reported as dangling rather than
 * counted as a deployment. The provider's own `complete` flag is a different question — it is about
 * reading the snapshot — and the two are deliberately not merged.
 *
 * @param {object} input
 * @param {string} input.root
 * @param {object} [input.adapter] - accepted for symmetry with `deploy`; inspection never needs it
 * @returns {object}
 */
export function inspectDeployment({ root, adapter = undefined }) {
  void adapter;
  const read = readManifest(root);
  if (!read.present) {
    return { mode: 'none', root, entries: 0, skills: [], dangling: [], complete: true, reason: `nothing is deployed at ${root}` };
  }
  if (!read.ok) {
    return {
      mode: 'unknown',
      root,
      entries: 0,
      skills: [],
      dangling: [],
      complete: false,
      reason: `the manifest at ${read.path} is unreadable: ${read.error}`,
    };
  }

  const manifest = read.manifest;
  const dangling = [];
  for (const entry of manifest.entries) {
    const deployed = entry.deployed ?? join(root, entry.skill);
    if (manifest.mode === 'copy') {
      if ((entry.files ?? []).some((file) => !existsSync(join(deployed, file.split('/').join(sep))))) dangling.push(entry.skill);
      continue;
    }
    try {
      lstatSync(deployed);
    } catch {
      dangling.push(entry.skill);
      continue;
    }
    try {
      statSync(deployed);
    } catch {
      // The link exists and its target does not: exactly the state that makes a skill silently vanish.
      dangling.push(entry.skill);
    }
  }

  return {
    mode: manifest.mode ?? 'none',
    root: manifest.root ?? root,
    entries: manifest.entries.length,
    skills: manifest.entries.map((entry) => entry.skill),
    dangling,
    complete: dangling.length === 0,
    updatedAt: manifest.updatedAt ?? null,
    snapshot: manifest.snapshot ?? null,
    ...(manifest.degradedReason === undefined ? {} : { degradedReason: manifest.degradedReason }),
  };
}
