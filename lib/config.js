/**
 * Plugin configuration (doc/spec.md §11).
 *
 * Every field is annotated with the UI tier it belongs to — `ui: 'exposed' | 'advanced' | 'hidden'`
 * — at the point of definition, so building a settings page later means reading the annotation
 * rather than re-deriving it from the whole field list (§11.3). The tier rides the schema's
 * description because `@deepseek-ai/schemastery` has no metadata slot for it.
 *
 * "Present in the configuration file but absent from the UI" is a first-class state here, not an
 * oversight: `rank` is the escape hatch for a name collision and is deliberately `hidden`.
 *
 * ## Why the import is dynamic, and why no dependency is declared
 *
 * The dsh installation does not put its own packages on a bundle's resolution path: a profile's
 * `node_modules` holds only the bundles themselves, and this workspace has no `node_modules` of its
 * own. A static `import z from '@deepseek-ai/schemastery'` therefore fails at link time, and a failing
 * link takes the entire plugin down, not just the schema.
 *
 * The plan's §11.1 assumed the host package would resolve from the dsh installation. It does not, so
 * the plan's S2 fallback applies and this is that fallback: `Config` is exported as `undefined`, the
 * host skips schema validation, and {@link resolveConfig} enforces the same field names, defaults,
 * types and ranges in `apply()`.
 *
 * Declaring the dependency does **not** fix it, and that was measured rather than assumed. The plugin
 * manager installs a local bundle directory with a `link:` specifier, and pnpm does not traverse a
 * linked package's dependencies at all — after adding `@deepseek-ai/schemastery` to `dependencies`,
 * `pnpm install` in the profile still reported "Already up to date" and `node_modules/@deepseek-ai`
 * stayed absent. Declaring it would therefore install nothing while implying a schema that is not
 * there.
 *
 * Two ways to reach the schema path, neither of which this package can take on its own:
 *   - the Harness resolves its own packages for bundles, or installs local directories as `file:`
 *     rather than `link:`; or
 *   - the bundle vendors schemastery under its own tree instead of importing a host package.
 * The dynamic import means either would start working with no code change here.
 */

/** @type {{ ui: string, text: string }} tiers, keyed by field, used by the fallback validator. */
export const UI_TIERS = {
  rank: 'hidden',
  descriptionMode: 'exposed',
  catalogSummaryBudget: 'advanced',
  catalogDescriptionMaxLength: 'advanced',
  catalogTokenBudget: 'advanced',
  enabledPlugins: 'exposed',
  enabledSkills: 'exposed',
  disabledSkills: 'exposed',
  pinnedSkills: 'exposed',
  disabledSelectors: 'advanced',
  'analytics.enabled': 'exposed',
  'analytics.includePaths': 'advanced',
  'analytics.retentionDays': 'advanced',
  'probe.enabled': 'exposed',
  'probe.maxFiles': 'advanced',
  'probe.maxDepth': 'advanced',
  'log.level': 'advanced',
  'log.bufferSize': 'advanced',
};

/** Defaults, mirroring spec §11.2 exactly. */
export const DEFAULTS = {
  rank: 700,
  descriptionMode: 'authored',
  catalogSummaryBudget: 320,
  catalogDescriptionMaxLength: 500,
  catalogTokenBudget: 0,
  enabledPlugins: [],
  enabledSkills: [],
  disabledSkills: [],
  pinnedSkills: [],
  disabledSelectors: [],
  analytics: { enabled: true, includePaths: false, retentionDays: 90 },
  probe: { enabled: true, maxFiles: 20000, maxDepth: 8 },
  log: { level: 'warn', bufferSize: 500 },
};

const TIER = (ui, text) => `[ui: ${ui}] ${text}`;

/** Field descriptions, shared by both declaration paths so they cannot drift apart. */
const DOC = {
  rank: TIER(
    'hidden',
    'Provider rank. Lower wins a duplicate skill name within one layer. The default sits below your own ' +
      '~/.dsh/skills (400) and ~/.agents/skills (500) and below the bundled roots (600), so your skills ' +
      'override ours without any configuration.',
  ),
  descriptionMode: TIER(
    'exposed',
    'authored uses the reviewed routing text for covered skills and the upstream text for the rest; verbatim ' +
      'uses upstream text everywhere, which lets the downstream limit truncate the long ones.',
  ),
  catalogSummaryBudget: TIER(
    'advanced',
    'Budget the authored descriptions were written to. Changing it invalidates that review.',
  ),
  catalogDescriptionMaxLength: TIER(
    'advanced',
    'The effective downstream limit for one catalog description. Set this to match the host skill tool\u2019s ' +
      'catalogDescriptionMaxLength so the reported truncation count is exact.',
  ),
  catalogTokenBudget: TIER(
    'advanced',
    'Estimated-token ceiling for the catalog. 0 disables the budget selector entirely.',
  ),
  enabledPlugins: TIER('exposed', 'Additional upstream plugins to include on top of the core set and detection.'),
  enabledSkills: TIER('exposed', 'Additional skill names to include.'),
  disabledSkills: TIER('exposed', 'Skill names to exclude. Subtraction happens after every include, so this wins.'),
  pinnedSkills: TIER('exposed', 'Skills the budget selector never drops.'),
  disabledSelectors: TIER('advanced', 'Names of built-in selectors to switch off.'),
  analytics: 'Local usage collection. Reserved for phase P2; nothing is written yet.',
  probe: 'Project detection. Reserved for phase P1; nothing is scanned yet.',
  log: 'Diagnostics. Reserved for phase P2; the ring buffer is not built yet.',
};

/**
 * `@deepseek-ai/schemastery`, when the host makes it resolvable.
 *
 * @type {object | undefined}
 */
let z;
let schemaSource = 'fallback';
try {
  z = (await import('@deepseek-ai/schemastery')).default;
  schemaSource = 'schemastery';
} catch {
  z = undefined;
}

/** The schema, when schemastery resolved. The host validates a row's `config` against it at activation. */
export const Config =
  z === undefined
    ? undefined
    : z.object({
        rank: z.number().default(DEFAULTS.rank).description(DOC.rank),
        descriptionMode: z
          .union([z.const('authored'), z.const('verbatim')])
          .default(DEFAULTS.descriptionMode)
          .description(DOC.descriptionMode),
        catalogSummaryBudget: z
          .number()
          .default(DEFAULTS.catalogSummaryBudget)
          .description(DOC.catalogSummaryBudget),
        catalogDescriptionMaxLength: z
          .number()
          .default(DEFAULTS.catalogDescriptionMaxLength)
          .description(DOC.catalogDescriptionMaxLength),
        catalogTokenBudget: z.number().default(DEFAULTS.catalogTokenBudget).description(DOC.catalogTokenBudget),
        enabledPlugins: z.array(z.string()).default([]).description(DOC.enabledPlugins),
        enabledSkills: z.array(z.string()).default([]).description(DOC.enabledSkills),
        disabledSkills: z.array(z.string()).default([]).description(DOC.disabledSkills),
        pinnedSkills: z.array(z.string()).default([]).description(DOC.pinnedSkills),
        disabledSelectors: z.array(z.string()).default([]).description(DOC.disabledSelectors),
        analytics: z
          .object({
            enabled: z.boolean().default(true).description(TIER('exposed', 'Write usage records locally as JSONL.')),
            includePaths: z
              .boolean()
              .default(false)
              .description(TIER('advanced', 'Store the workspace path in clear text instead of only a fingerprint.')),
            retentionDays: z
              .number()
              .default(90)
              .description(TIER('advanced', 'Delete usage records older than this.')),
          })
          .default({})
          .description(DOC.analytics),
        probe: z
          .object({
            enabled: z.boolean().default(true).description(TIER('exposed', 'Enable project signal detection.')),
            maxFiles: z.number().default(20000).description(TIER('advanced', 'Upper bound on files visited.')),
            maxDepth: z.number().default(8).description(TIER('advanced', 'Upper bound on directory depth.')),
          })
          .default({})
          .description(DOC.probe),
        log: z
          .object({
            level: z
              .union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')])
              .default('warn')
              .description(TIER('advanced', 'Structured log level.')),
            bufferSize: z
              .number()
              .default(500)
              .description(TIER('advanced', 'Entries kept in the in-memory ring buffer.')),
          })
          .default({})
          .description(DOC.log),
      });

/** Which declaration path is live: `'schemastery'` or `'fallback'`. Reported by the status tool. */
export const declaredWith = schemaSource;

/**
 * Fill in defaults and reject values outside the declared ranges.
 *
 * Used when `Config` is `undefined`, and also useful as a belt-and-braces check afterwards: the
 * point is that `apply()` never has to reason about a missing nested object.
 *
 * @param {object | undefined} raw
 * @param {(line: string) => void} [warn]
 * @returns {object} a complete configuration
 */
export function resolveConfig(raw, warn) {
  const input = raw ?? {};
  const config = {
    ...DEFAULTS,
    ...pickKnown(input, warn),
    analytics: { ...DEFAULTS.analytics, ...(input.analytics ?? {}) },
    probe: { ...DEFAULTS.probe, ...(input.probe ?? {}) },
    log: { ...DEFAULTS.log, ...(input.log ?? {}) },
  };

  if (!Number.isFinite(config.rank)) {
    warn?.(`rank ${String(config.rank)} is not a number; using ${DEFAULTS.rank}`);
    config.rank = DEFAULTS.rank;
  }
  if (config.descriptionMode !== 'authored' && config.descriptionMode !== 'verbatim') {
    warn?.(`descriptionMode ${JSON.stringify(config.descriptionMode)} is not recognised; using authored`);
    config.descriptionMode = 'authored';
  }
  for (const key of ['enabledPlugins', 'enabledSkills', 'disabledSkills', 'pinnedSkills', 'disabledSelectors']) {
    if (!Array.isArray(config[key])) {
      warn?.(`${key} must be an array; ignoring it`);
      config[key] = [];
    }
  }
  for (const key of ['catalogSummaryBudget', 'catalogDescriptionMaxLength', 'catalogTokenBudget']) {
    if (!Number.isFinite(config[key]) || config[key] < 0) {
      warn?.(`${key} must be a non-negative number; using ${String(DEFAULTS[key])}`);
      config[key] = DEFAULTS[key];
    }
  }
  return config;
}

/**
 * The `probe.*` settings a configuration actually sets, by name.
 *
 * `probe.*` exists in the configuration schema before detection exists in the code, so the only
 * honest thing to do with a setting that is present and inert is to say so out loud. Reading the raw
 * configuration rather than the resolved one is what makes that possible: after {@link resolveConfig}
 * every key has a default, and "the user asked for this" is no longer distinguishable from "this is
 * what it is when nobody says anything".
 *
 * @param {object | undefined} raw - the row's configuration, untouched
 * @returns {string[]} dotted key names, in declaration order
 */
export function probeOverrides(raw) {
  const probe = raw?.probe;
  if (probe === undefined || probe === null) return [];
  if (typeof probe !== 'object' || Array.isArray(probe)) return ['probe'];
  return ['enabled', 'maxFiles', 'maxDepth'].filter((key) => Object.hasOwn(probe, key)).map((key) => `probe.${key}`);
}

/** Copy the known top-level scalar fields, warning about anything unrecognised. */
function pickKnown(input, warn) {
  const known = new Set([
    'rank',
    'descriptionMode',
    'catalogSummaryBudget',
    'catalogDescriptionMaxLength',
    'catalogTokenBudget',
    'enabledPlugins',
    'enabledSkills',
    'disabledSkills',
    'pinnedSkills',
    'disabledSelectors',
    'analytics',
    'probe',
    'log',
  ]);
  /** @type {Record<string, unknown>} */
  const picked = {};
  for (const [key, value] of Object.entries(input)) {
    if (!known.has(key)) {
      warn?.(`unknown configuration field ${JSON.stringify(key)} is ignored`);
      continue;
    }
    picked[key] = value;
  }
  return picked;
}

export default Config;
