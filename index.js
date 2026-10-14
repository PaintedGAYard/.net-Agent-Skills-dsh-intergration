/**
 * `dsh-dotnet-skills` — bridges .NET Agent Skills into a DeepSeek Harness session.
 *
 * The plugin's whole job is to make the curated skills of `dotnet/skills` (pinned to a tag,
 * shipped inside this package under `vendor/upstream/`) appear in the session skill catalog with
 * routing descriptions a human reviewed, without renaming a skill, rewriting a `SKILL.md` body or
 * touching a byte of the snapshot.
 *
 * Registration order matters and is fixed (§1.2 of the plan):
 *   log → content source → configuration check → provider → selection service → tools.
 * Everything is registered through `ctx.effect`/`ctx.on` so it unwinds cleanly.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

import { Config, declaredWith, probeOverrides, resolveConfig } from './lib/config.js';
import { inspectDeployment } from './lib/deploy/index.js';
import { createProjectDetector } from './lib/detect.js';
import { loadDescriptions } from './lib/descriptions.js';
import { createProvider, createJournal } from './lib/provider.js';
import { selectAdapter } from './lib/platform/index.js';
import { createSelectionService } from './lib/selection.js';
import { createSnapshotSource } from './lib/source-snapshot.js';
import { descriptionsPath, readUpstreamManifest } from './lib/snapshot.js';
import { buildStatusReport } from './lib/status.js';
import { createRefreshTool, createStatusTool, undiscoverableTools } from './lib/tools.js';

/** Hard dependencies: the plugin is meaningless without either. */
export const inject = ['skills', 'tools'];

export { Config };

/** Diagnostic notes that are not tied to a single catalog read. */
const activationNotes = [];

/**
 * @param {object} ctx - Cordis plugin context
 * @param {object} rawConfig - the row's configuration
 */
export function apply(ctx, rawConfig = {}) {
  const log = makeLogger(ctx, rawConfig);
  activationNotes.length = 0;

  // The host validates `config` against the exported `Config` when there is one. When schemastery
  // could not be resolved there is no schema, so the same rules run here instead (§11.1, S2).
  const config = resolveConfig(rawConfig, (line) => log.warn(line));
  if (declaredWith === 'fallback') {
    activationNotes.push(
      'configuration was validated by the built-in fallback because @deepseek-ai/schemastery ' +
        'is not resolvable from this bundle; field names, defaults and UI tiers are unchanged',
    );
  }

  // ---- content source -------------------------------------------------------------------
  const manifestRead = readUpstreamManifest();
  const manifest = manifestRead.ok ? manifestRead.manifest : undefined;
  if (!manifestRead.ok) log.warn(`snapshot provenance unavailable: ${manifestRead.error}`);

  // Only ship the plugins this release includes; the range is data, not a code change (§3.5).
  const includedPlugins = (manifest?.includedPlugins ?? []).map((plugin) => plugin.name);
  const source = createSnapshotSource(
    includedPlugins.length === 0 ? {} : { plugins: includedPlugins },
  );
  if (!existsSync(source.root)) log.warn(`snapshot is missing at ${source.root}; no skills will be offered`);

  // ---- configuration check --------------------------------------------------------------
  const descriptions = loadDescriptions({
    path: descriptionsPath,
    manifest,
    budget: config.catalogSummaryBudget,
  });
  for (const diagnostic of descriptions.diagnostics) log.warn(diagnostic);

  const journal = createJournal();
  for (const note of source.diagnostics()) journal.notes.push(note);

  // ---- selection service (the extension seam of §8.2) -----------------------------------
  const detector = createProjectDetector({ config, log: (line) => log.warn(line) });
  const detect = (context) => {
    const result = detector(context);
    // §11.4 item 1 asks what selection actually did, and "detection ran and matched nothing" is only
    // distinguishable from "detection never ran" if the result is recorded. It belongs here rather
    // than inside the detector: `lib/detect.js` stays a pure function of a workspace, while this
    // closure knows it is feeding a report. The report folds before it assembles itself, so what it
    // reads is the detection belonging to the workspace the report is about.
    journal.detection = { ...result, cwd: context?.cwd ?? null };
    return result;
  };
  const selection = createSelectionService({
    config,
    manifest,
    pluginSkills: source.pluginSkills(),
    detect,
    log: (line) => log.warn(line),
  });
  // `ctx.provide` and `ctx.skills.registerProvider` each return the disposer that unwinds them, and
  // `ctx.effect` wants a callback that *returns* such a disposer. Handing the disposer to `effect`
  // directly would register the disposer itself as the cleanup.
  ctx.effect(() => ctx.provide('dotnetSkills', selection));

  // `probe.*` is in the configuration schema before detection exists in the code, so a setting that is
  // present and inert has to say so. Warning here rather than silently accepting it is the whole point:
  // "no signal matched" and "nothing is scanned" produce the same catalog (§9, dev-notes).
  //
  // §9 is wired now, so this branch can no longer fire in this build. It stays because the failure it
  // names is invisible from the outside: a `probe.*` setting with nothing behind it looks exactly like
  // a detection run that matched nothing, and that is one plausible end state of a future refactor.
  const inertProbeKeys = probeOverrides(rawConfig);
  if (inertProbeKeys.length > 0 && !selection.hasDetect()) {
    log.warn(
      `${inertProbeKeys.join(', ')} has no effect in this version: project detection is not wired yet ` +
        '(spec §9 lands with P1), so the core set is the whole selection',
    );
  }

  // ---- provider ------------------------------------------------------------------------
  const provider = createProvider({ source, selection, descriptions, config, journal, log: log.warn });
  let control;
  ctx.effect(() =>
    ctx.skills.registerProvider((providerControl) => {
      control = providerControl;
      return provider;
    }),
  );

  // ---- tools ---------------------------------------------------------------------------
  const reportDependencies = { ctx, config, manifest, source, provider, journal, descriptions, selection };
  const statusTool = createStatusTool({ report: (cwd) => buildReport(reportDependencies, cwd) });
  const refreshTool = createRefreshTool({
    invalidate: () => {
      if (control === undefined) return false;
      control.invalidate();
      return true;
    },
  });
  // A deferred tool is absent from the model's declaration set, so a name no declared tool mentions is
  // simply unreachable — callable, but only by an agent that already knew it. The suite asserts this;
  // saying it out loud on activation is what keeps a third tool from being added the broken way.
  for (const name of undiscoverableTools([statusTool, refreshTool])) {
    log.warn(`${name} is deferred and no declared tool names it, so the model cannot discover it`);
  }
  ctx.effect(() => ctx.tools.register(statusTool));
  ctx.effect(() => ctx.tools.register(refreshTool));

  log.info(
    `dotnet-agent-skills ready: rank ${String(config.rank)}, ${String(includedPlugins.length)} plugin(s) in range, ` +
      `${String(journal.registered ?? 0)} skill(s) listed`,
  );
}

/**
 * Assemble the status report, deferring every expensive read to the moment the tool is called.
 *
 * The report is a diagnostic, so it is allowed to be slower than `list()`; what it must not do is
 * run on activation.
 *
 * `cwd` is the workspace the caller asked about. It is threaded through to both the fold and the
 * provider read, which is what makes the report able to describe a project other than the session's
 * own — the reason detection can be measured over a set of repositories instead of one.
 *
 * @param {object} dependencies
 * @param {string} [cwd]
 */
function buildReport({ ctx, config, manifest, source, provider, journal, descriptions, selection }, cwd) {
  const otherProviders = [];
  // `ctx.tools.get` reads the *global* view. The host's `skill` tool is composed by an agent preset,
  // so it is scoped to agents and legitimately absent here. Reporting that as "unavailable" would be
  // wrong, and saying nothing would hide why we cannot read its configuration.
  const skillTool = ctx.tools?.get?.('skill');
  otherProviders.push(
    skillTool === undefined
      ? 'the host skill tool is agent-scoped, so its configuration cannot be read from this provider; ' +
        'catalogDescriptionMaxLength below is this plugin\u2019s own copy of that setting'
      : 'the host skill tool is visible from this scope',
  );
  for (const note of activationNotes) {
    if (!journal.notes.includes(note)) journal.notes.push(note);
  }
  return buildStatusReport({
    manifest,
    config,
    source,
    provider,
    journal,
    descriptions,
    selection,
    otherProviders,
    cwd,
    // §11.4 item 8 asks whether the selected skills' `scripts/*.ps1` can actually run. That is a
    // process-level question, so it is answered by probing once and remembering the answer, not by
    // guessing — and the probe lives here rather than in `lib/`, because `lib/` must stay free of
    // process and platform assumptions (spec §9.1, §10.4).
    pwshVersion: detectPowerShell(),
    // §11.4 item 6. The report reads the deployment manifest rather than guessing from the platform:
    // what matters is what was actually materialized, and the manifest is the only record of that.
    // "nothing deployed", "unreadable" and "dangling" are three different answers, and inspection
    // keeps them apart instead of collapsing them into "none".
    deployment: inspectDeploymentAtDefaultRoot(),
  });
}

/**
 * Inspect the deployment at this platform's conventional root.
 *
 * A platform with no adapter — macOS today — has no conventional root, and the report says exactly
 * that instead of presenting "we could not look" as "nothing is deployed", which is a state an
 * operator would act on.
 *
 * @returns {object | undefined}
 */
function inspectDeploymentAtDefaultRoot() {
  try {
    const adapter = selectAdapter();
    return inspectDeployment({ root: adapter.defaultDeployRoot({ home: homedir() }), adapter });
  } catch (error) {
    return {
      mode: 'unknown',
      root: null,
      entries: 0,
      dangling: [],
      complete: false,
      reason: `the deployment root cannot be named here: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Detect the PowerShell that a skill's `scripts/*.ps1` would run under, once per process.
 *
 * `pwsh` is the cross-platform name, so this is a probe rather than a platform branch — it works the
 * same way on Windows and Linux, and "not found" is a truthful answer on both. The result is cached
 * because the report is a diagnostic and the answer cannot change while the process lives.
 *
 * @type {string | null | undefined} `undefined` until probed, `null` for absent
 */
let pwshProbe;

function detectPowerShell() {
  if (pwshProbe !== undefined) return pwshProbe ?? undefined;
  try {
    // Time-boxed and stdio-free: a missing or hanging interpreter must not stall the report.
    const version = execFileSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    pwshProbe = version === '' ? null : `PowerShell ${version}`;
  } catch {
    pwshProbe = null;
  }
  return pwshProbe ?? undefined;
}

/** A structured logger that stays quiet unless the operator asked for detail (§11.2). */
function makeLogger(ctx, config) {
  const level = config.log?.level ?? 'warn';
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = order[level] ?? order.warn;
  const emit = (name, message) => {
    if (order[name] < threshold) return;
    const logger = ctx.logger;
    if (logger !== undefined && typeof logger[name] === 'function') logger[name](`dotnet-skills: ${message}`);
    else if (name === 'error' || name === 'warn') process.emitWarning(`dotnet-skills: ${message}`);
  };
  return {
    debug: (message) => emit('debug', message),
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  };
}
