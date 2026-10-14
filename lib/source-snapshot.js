/**
 * `SkillContentSource` over the bundled snapshot (doc/spec.md §4).
 *
 * The rest of the plugin depends on this interface, not on the fact that content arrives as
 * a snapshot, so the same provider can later serve a live checkout or a packaged
 * distribution. Within P0 the source is also the seam that lets provider tests hand in a
 * throwaway directory.
 *
 * Everything here is synchronous and reads straight from disk: no clock, no network, no
 * cache. Definitions are re-read on every `get()` because the host contract forbids caching
 * them (§6.5).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { isSkillName, parseDocument, readRequiredKeys, unknownKeys } from './frontmatter.js';
import { snapshotRoot } from './snapshot.js';

/**
 * @typedef {object} SnapshotSkillRecord
 * @property {string} plugin
 * @property {string} name
 * @property {string} skillDir
 * @property {string} bodyPath
 * @property {Map<string, string>} frontmatter
 * @property {string} description - normalised upstream description
 * @property {string} rawDescription - the description as parsed, before normalisation
 * @property {boolean} userInvocable
 * @property {Record<string, string>} extraFrontmatter
 * @property {Record<string, number>} resources - known resource subdirectory → entry count
 */

/**
 * Build a snapshot content source.
 *
 * @param {object} [options]
 * @param {string} [options.root] - snapshot root; defaults to `vendor/upstream`
 * @param {string[]} [options.plugins] - plugin ids to expose; defaults to every directory present
 * @returns {{
 *   root: string,
 *   resolve: (pluginId: string) => { manifest: object | undefined, skills: SnapshotSkillRecord[] } | undefined,
 *   listPlugins: () => Array<{ id: string, version?: string, description?: string, skillCount: number }>,
 *   readBody: (skill: SnapshotSkillRecord) => string | undefined,
 *   pluginSkills: () => Map<string, string[]>,
 *   diagnostics: () => string[],
 * }}
 */
export function createSnapshotSource({ root = snapshotRoot, plugins } = {}) {
  const resolvedRoot = resolve(root);
  /** @type {string[]} */
  const diagnostics = [];

  const pluginDirectory = (pluginId) => join(resolvedRoot, pluginId);

  /**
   * Read one plugin's manifest and skills from disk.
   *
   * Deliberately uncached. The snapshot is 214 files and 1.4 MiB, so a re-read costs nothing
   * measurable, and not caching is what makes an edit to the snapshot — or a deleted directory —
   * visible on the very next `list()`. A cache here would also hide the failures the provider is
   * required to report as `complete: false`.
   */
  const loadPlugin = (pluginId) => {
    const directory = pluginDirectory(pluginId);
    const entry = { manifest: readManifest(directory, pluginId, diagnostics), skills: [], byName: new Map() };
    if (!existsSync(directory)) {
      diagnostics.push(`plugin ${pluginId}: missing from the snapshot at ${directory}`);
      return entry;
    }
    const skillsDir = join(directory, 'skills');
    if (!existsSync(skillsDir)) return entry;

    for (const child of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!child.isDirectory()) continue;
      const name = child.name;
      if (!isSkillName(name)) {
        diagnostics.push(`${pluginId}/${name}: directory name violates the skill-name grammar; skipped`);
        continue;
      }
      const skillDir = join(skillsDir, name);
      const bodyPath = join(skillDir, 'SKILL.md');
      let source;
      try {
        source = readFileSync(bodyPath, 'utf8');
      } catch (error) {
        diagnostics.push(`${pluginId}/${name}: cannot read SKILL.md (${error.message}); skipped`);
        continue;
      }
      let parsed;
      try {
        parsed = parseDocument(source);
      } catch (error) {
        diagnostics.push(`${pluginId}/${name}: ${error.message}; skipped`);
        continue;
      }
      const required = readRequiredKeys(parsed.frontmatter);
      if (!required.ok) {
        diagnostics.push(`${pluginId}/${name}: ${required.reason}; skipped`);
        continue;
      }
      if (required.name !== name) {
        diagnostics.push(
          `${pluginId}/${name}: frontmatter name ${JSON.stringify(required.name)} does not match the directory; skipped`,
        );
        continue;
      }
      entry.skills.push({
        plugin: pluginId,
        name,
        skillDir,
        bodyPath,
        frontmatter: parsed.frontmatter,
        description: required.description,
        rawDescription: parsed.frontmatter.get('description') ?? '',
        userInvocable: required.userInvocable,
        extraFrontmatter: unknownKeys(parsed.frontmatter),
        resources: resourceDirectories(skillDir),
      });
      entry.byName.set(name, entry.skills[entry.skills.length - 1]);
    }
    return entry;
  };

  return {
    root: resolvedRoot,
    resolve: (pluginId) => {
      const entry = loadPlugin(pluginId);
      if (entry.skills.length === 0 && entry.manifest === undefined) return undefined;
      return { manifest: entry.manifest, skills: entry.skills };
    },
    /**
     * Resolve a plugin and report what had to be skipped while doing it.
     *
     * The diagnostics belong to this call, not to a running list: the provider turns a non-empty
     * list into `complete: false`, which is the only honest way to say "the snapshot directory
     * exists but not everything in it could be read".
     */
    inspect: (pluginId) => {
      const before = diagnostics.length;
      const entry = loadPlugin(pluginId);
      return { manifest: entry.manifest, skills: entry.skills, diagnostics: diagnostics.slice(before) };
    },
    listPlugins: () => {
      const ids = plugins ?? listPluginDirectories(resolvedRoot, diagnostics);
      return ids.map((id) => {
        const entry = loadPlugin(id);
        return {
          id,
          version: entry.manifest?.version,
          description: entry.manifest?.description,
          skillCount: entry.skills.length,
        };
      });
    },
    readBody: (skill) => {
      try {
        return readFileSync(skill.bodyPath, 'utf8');
      } catch {
        return undefined;
      }
    },
    pluginSkills: () => {
      const map = new Map();
      for (const plugin of plugins ?? listPluginDirectories(resolvedRoot, diagnostics)) {
        map.set(plugin, loadPlugin(plugin).skills.map((skill) => skill.name));
      }
      return map;
    },
    diagnostics: () => [...diagnostics],
  };
}

/** Resource subdirectories a skill ships; §11.4 item 8 needs to know about `scripts/`. */
export function resourceDirectories(skillDir) {
  /** @type {Record<string, number>} */
  const found = {};
  for (const directory of ['references', 'scripts', 'extensions', 'assets']) {
    const full = join(skillDir, directory);
    if (!existsSync(full)) continue;
    try {
      found[directory] = readdirSync(full).length;
    } catch {
      found[directory] = 0;
    }
  }
  return found;
}

function readManifest(pluginDir, pluginId, diagnostics) {
  const path = join(pluginDir, 'plugin.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    diagnostics.push(`plugin ${pluginId}: cannot parse plugin.json (${error.message})`);
    return undefined;
  }
}

function listPluginDirectories(root, diagnostics) {
  if (!existsSync(root)) {
    diagnostics.push(`snapshot root is missing: ${root}`);
    return [];
  }
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.'))
      .sort();
  } catch (error) {
    diagnostics.push(`cannot list snapshot root ${root}: ${error.message}`);
    return [];
  }
}

/** True when a path is a readable file, used by the deployment status diagnostics. */
export function isReadableFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The absolute `SKILL.md` path for a skill directory, as the host's sidebar preview needs it. */
export function skillBodyPath(skillDir) {
  return join(skillDir, 'SKILL.md');
}

/** POSIX-normalised path, for diagnostics that must not look platform-specific. */
export function normalisePath(path) {
  return path.split(sep).join('/');
}
