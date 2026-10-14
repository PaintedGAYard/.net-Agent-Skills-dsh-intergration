/**
 * The macOS adapter (doc/spec.md §10.4): deliberately empty.
 *
 * §10.4 asks for an unimplemented adapter rather than an absent file, so that adding macOS later is
 * filling in a known place instead of searching the repository for branches. Every entry point
 * throws, which is the honest answer: nothing here has ever been run on macOS, and a plausible-looking
 * path guess would be worse than a refusal.
 */

/** @type {string} */
export const platform = 'darwin';

/**
 * @returns {never}
 */
export function defaultDeployRoot() {
  throw new Error('macOS adapter not implemented');
}

/**
 * @returns {never}
 */
export function symlinkHint() {
  throw new Error('macOS adapter not implemented');
}

/**
 * Fold a path for comparison.
 *
 * This one does **not** throw, and the reason is worth stating: a comparison helper has a safe
 * conservative answer available (treat paths as case-sensitive, which can only over-report a path as
 * "outside", never under-report it), and a dev tool that refuses to run on a platform it merely has no
 * deployment support for would be a worse outcome than a slightly conservative audit. Every entry
 * point that decides where to *write* still refuses.
 *
 * @param {string} path
 * @returns {string}
 */
export function foldPath(path) {
  return path;
}
