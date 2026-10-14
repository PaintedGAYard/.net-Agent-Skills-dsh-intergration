/**
 * Platform selection (doc/spec.md §10.4).
 *
 * This file holds the repository's only `process.platform` branch. The rule is not stylistic: a
 * platform decision anywhere else is a decision nobody will find when macOS arrives, and the
 * deployment kernel is meant to be one implementation that every platform either satisfies or
 * degrades out of.
 */

import * as darwin from './macos.js';
import * as linux from './linux.js';
import * as win32 from './win32.js';

/** @type {Record<string, { platform: string, defaultDeployRoot: Function, symlinkHint: Function, foldPath: Function }>} */
const ADAPTERS = { win32, linux, darwin };

/**
 * The adapter for a platform.
 *
 * An unknown platform throws rather than falling back to Linux: the fallback would be a guess about
 * path conventions, and the wrong guess produces a deployment nothing discovers. `darwin` resolves to
 * the adapter that refuses every call, which is a fact worth stating rather than an error to hide.
 *
 * @param {string} [platform]
 * @returns {{ platform: string, defaultDeployRoot: Function, symlinkHint: Function, foldPath: Function }}
 */
export function selectAdapter(platform = process.platform) {
  const adapter = ADAPTERS[platform];
  if (adapter === undefined) {
    throw new Error(`no deployment adapter for platform "${platform}"; known platforms: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return adapter;
}

/** The platform names this build can name at all. */
export const KNOWN_PLATFORMS = Object.keys(ADAPTERS);
