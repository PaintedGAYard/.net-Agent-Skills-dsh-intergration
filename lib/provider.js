/**
 * The `ctx.skills` provider (doc/spec.md §6).
 *
 * Three rules from the host contract shape everything below.
 *
 * 1. **Never emit a candidate that could fail validation.** The host validates candidates
 *    *outside* its own try/catch: one bad candidate throws out of the layer collection and
 *    takes every provider's catalog down with it, not just ours. Each candidate is therefore
 *    self-checked before it is returned.
 * 2. **Never throw out of `list()`.** A missing snapshot, an unreadable file, a broken
 *    authored entry — all of it degrades to `complete: false`, which tells the host to keep
 *    its last good catalog instead of concluding that every skill was deleted.
 * 3. **Never cache a definition.** `get()` re-reads the body on every call, and returns the
 *    same `name` the candidate carried, because a name mismatch invalidates the host's whole
 *    catalog cache.
 */

import { readFileSync } from 'node:fs';

import { isSkillName } from './frontmatter.js';
import { resolveDescription } from './descriptions.js';

/** Provider name. `runtime` is reserved by the host and would throw at registration. */
export const PROVIDER_NAME = 'dotnet-agent-skills';

/** `source` value for every candidate: the snapshot ships inside the package (§6.1). */
export const PROVIDER_SOURCE = 'bundled';

/** Invocation policy for a skill with no upstream `user-invocable` key (§6.4). */
const DEFAULT_INVOCATION = { modelInvocable: true, userInvocable: true };

/**
 * A mutable diagnostics record, so a failure observed during `list()` is still reportable
 * later by the status tool (§11.4).
 *
 * @returns {{ notes: string[], registered?: number, rank?: number, mode?: string, complete?: boolean }}
 */
export function createJournal() {
  return { notes: [] };
}

/**
 * Create the provider object the host calls.
 *
 * Every collaborator is injected, so the suite can drive the whole provider over a throwaway
 * snapshot and a stub selection service without a running host.
 *
 * @param {object} input
 * @param {object} input.source - `SkillContentSource` (see `lib/source-snapshot.js`)
 * @param {object} input.selection - the `dotnetSkills` service
 * @param {{ entries: Map<string, { text: string }> }} input.descriptions - loaded authored data
 * @param {object} input.config - resolved plugin config
 * @param {object} [input.journal] - diagnostics record from {@link createJournal}
 * @param {(path: string) => string} [input.readBody] - body reader; injectable for tests
 * @param {(line: string) => void} [input.log]
 * @returns {{ name: string, list: Function, get: Function }}
 */
export function createProvider({
  source,
  selection,
  descriptions,
  config,
  journal = createJournal(),
  readBody = (path) => readFileSync(path, 'utf8'),
  log,
}) {
  const rank = config.rank ?? 700;
  const mode = config.descriptionMode ?? 'authored';
  const maxLength = config.catalogDescriptionMaxLength ?? 500;

  /** skill name → owning plugin, so a folded selection fans out to plugin reads. */
  const owner = new Map();
  for (const [plugin, skills] of source.pluginSkills()) {
    for (const skill of skills) owner.set(skill, plugin);
  }

  /** Workspace → the skill names this provider has already advertised there (§6.2 hard rule two). */
  const advertised = new Map();

  const buildCandidate = (skill, reason) => {
    const resolved = resolveDescription({
      key: `${skill.plugin}/${skill.name}`,
      upstreamDescription: skill.description,
      descriptions,
      mode,
      maxLength,
    });
    const invokes = invokesOf(skill.description);
    return {
      name: skill.name,
      description: resolved.text,
      invocation: skill.userInvocable ? { ...DEFAULT_INVOCATION } : { modelInvocable: true, userInvocable: false },
      source: PROVIDER_SOURCE,
      provider: PROVIDER_NAME,
      rank,
      path: skill.bodyPath,
      resourceBase: { kind: 'directory', path: skill.skillDir },
      locator: {
        plugin: skill.plugin,
        skill: skill.name,
        skillDir: skill.skillDir,
        bodyPath: skill.bodyPath,
      },
      metadata: {
        plugin: skill.plugin,
        upstreamDescription: skill.description,
        upstreamDescriptionChars: skill.description.length,
        ...(invokes === undefined ? {} : { upstreamInvokes: invokes }),
        ...(Object.keys(skill.extraFrontmatter).length === 0 ? {} : { upstreamFrontmatter: skill.extraFrontmatter }),
        descriptionSource: resolved.source,
        selectionReason: reason,
      },
    };
  };

  const list = async (options = {}) => {
    /** @type {object[]} */
    const candidates = [];
    let complete = true;

    // The fold is never allowed to escape: an empty selection is a valid answer, a throw is not.
    let folded;
    try {
      folded = selection.fold({ cwd: options.cwd, current: advertised.get(options.cwd ?? '') ?? [] });
    } catch (error) {
      record(journal, `selection fold failed: ${message(error)}`);
      folded = { names: [], reasons: new Map() };
    }

    // §6.2 hard rule two: the advertised set may only grow within one workspace. Anything this
    // workspace has already been shown stays listed even if the selection no longer picks it,
    // because a shrinking catalog makes the host append a whole replacement catalog and breaks
    // the prompt cache — and because a skill the model may already have used must not vanish.
    // The budget selector's cuts still apply for a workspace they are first decided in.
    const key = options.cwd ?? '';
    const selected = new Set(folded.names ?? []);
    const seen = advertised.get(key) ?? new Set();
    if (config.monotonic === false) seen.clear();
    for (const name of selected) seen.add(name);
    advertised.set(key, seen);
    journal.monotonic = { workspace: key, advertised: seen.size, selected: selected.size };

    /** @type {Map<string, Set<string>>} */
    const byPlugin = new Map();
    for (const name of seen) {
      const plugin = owner.get(name);
      if (plugin === undefined) {
        // A name this release does not ship. Configuration naming a departed skill is a warning,
        // not a failure (§14), so it never makes the observation incomplete.
        record(journal, `selected skill "${name}" belongs to no plugin in the snapshot`);
        continue;
      }
      if (!byPlugin.has(plugin)) byPlugin.set(plugin, new Set());
      byPlugin.get(plugin).add(name);
    }

    for (const pluginId of [...byPlugin.keys()].sort()) {
      let resolved;
      try {
        resolved = source.inspect(pluginId);
      } catch (error) {
        complete = false;
        record(journal, `snapshot read failed for plugin ${pluginId}: ${message(error)}`);
        continue;
      }
      if (resolved === undefined) {
        complete = false;
        record(journal, `plugin ${pluginId} is selected but absent from the snapshot`);
        continue;
      }
      // A skill the snapshot holds but cannot parse is missing from the catalog, so the
      // observation is incomplete even though the read itself succeeded.
      for (const note of resolved.diagnostics ?? []) {
        complete = false;
        record(journal, note);
      }
      const wanted = byPlugin.get(pluginId);
      for (const skill of resolved.skills) {
        if (!wanted.has(skill.name)) continue;
        let candidate;
        try {
          candidate = buildCandidate(skill, folded.reasons?.get(skill.name) ?? 'unknown');
        } catch (error) {
          complete = false;
          record(journal, `cannot build a candidate for ${skill.name}: ${message(error)}`);
          continue;
        }
        const problem = validateCandidate(candidate);
        if (problem !== undefined) {
          complete = false;
          record(journal, `candidate ${skill.name} failed self-validation: ${problem}`);
          continue;
        }
        candidates.push(candidate);
      }
    }

    candidates.sort(byName);
    journal.registered = candidates.length;
    journal.rank = rank;
    journal.mode = mode;
    journal.complete = complete;
    return { candidates, complete };
  };

  const get = async (candidate) => {
    const locator = candidate?.locator;
    if (locator === null || typeof locator !== 'object' || typeof locator.bodyPath !== 'string') {
      record(journal, 'get() received a candidate without a usable locator');
      return undefined;
    }
    let content;
    try {
      // Deliberately re-read every time: the host contract forbids a cached definition (§6.5).
      content = readBody(locator.bodyPath);
    } catch (error) {
      record(journal, `cannot read ${locator.bodyPath}: ${message(error)}`);
      return undefined;
    }
    if (typeof content !== 'string') {
      record(journal, `skill "${candidate.name}" is no longer readable at ${locator.bodyPath}`);
      return undefined;
    }
    return {
      // The returned name must equal the candidate's, or the host drops its whole catalog.
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      source: candidate.source,
      provider: candidate.provider,
      path: candidate.path,
      resourceBase: candidate.resourceBase,
      metadata: candidate.metadata,
      content,
    };
  };

  return { name: PROVIDER_NAME, list, get };
}

/**
 * Self-check every field the host validates, plus the two it renders from (§6.2).
 *
 * @param {object} candidate
 * @returns {string | undefined} the problem, or `undefined` when the candidate is safe
 */
export function validateCandidate(candidate) {
  if (candidate === null || typeof candidate !== 'object') return 'candidate is not an object';
  if (typeof candidate.name !== 'string') return 'name is not a string';
  if (!isSkillName(candidate.name)) return `name ${JSON.stringify(candidate.name)} is not a valid skill name`;
  if (typeof candidate.description !== 'string') return 'description is not a string';
  if (candidate.description.length === 0) return 'description is empty';
  if (candidate.whenToUse !== undefined && typeof candidate.whenToUse !== 'string') return 'whenToUse is not a string';
  const invocation = candidate.invocation;
  if (invocation === null || typeof invocation !== 'object') return 'invocation is not an object';
  if (typeof invocation.modelInvocable !== 'boolean') return 'invocation.modelInvocable is not a boolean';
  if (typeof invocation.userInvocable !== 'boolean') return 'invocation.userInvocable is not a boolean';
  if (typeof candidate.source !== 'string') return 'source is not a string';
  if (typeof candidate.provider !== 'string') return 'provider is not a string';
  if (candidate.provider !== PROVIDER_NAME) {
    return `provider is ${JSON.stringify(candidate.provider)}, expected ${JSON.stringify(PROVIDER_NAME)}`;
  }
  if (typeof candidate.rank !== 'number' || !Number.isFinite(candidate.rank)) return 'rank is not a finite number';
  if (candidate.path !== undefined && typeof candidate.path !== 'string') return 'path is not a string';
  if (candidate.resourceBase !== undefined) {
    const base = candidate.resourceBase;
    if (base === null || typeof base !== 'object') return 'resourceBase is not an object';
    if (base.kind === 'directory' && typeof base.path !== 'string') return 'resourceBase.path is not a string';
    if (base.kind === 'url' && typeof base.url !== 'string') return 'resourceBase.url is not a string';
    if (base.kind === 'opaque' && typeof base.description !== 'string') {
      return 'resourceBase.description is not a string';
    }
  }
  if (candidate.locator === null || typeof candidate.locator !== 'object') return 'locator is not an object';
  return undefined;
}

function record(journal, note) {
  if (journal.notes.includes(note)) return;
  journal.notes.push(note);
  if (journal.notes.length > 50) journal.notes.shift();
}

/** The `INVOKES:` section, preserved in metadata after the catalog text drops it (§7.10). */
function invokesOf(description) {
  const match = /INVOKES:([\s\S]*)$/.exec(description);
  return match === null ? undefined : `INVOKES:${match[1]}`.trim();
}

function byName(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
