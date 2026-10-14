/**
 * The two tools (doc/spec.md §13).
 *
 * A phase A deliberately ships only two, because every tool costs schema tokens. Both take a
 * plain object definition — the host validates `output.render` is a function and checks that
 * `output.schema` is a JSON Schema it supports, but does not validate `parameters` at
 * registration time.
 */

import { buildStatusReport, DIAGNOSTIC_KEYS, renderStatusReport } from './status.js';

/** Name of the status tool, referenced by tests and the catalogue. */
export const STATUS_TOOL_NAME = 'dotnet_skills_status';

/** Name of the refresh tool. */
export const REFRESH_TOOL_NAME = 'dotnet_skills_refresh';

/** A tool result block, matching the host's content-block shape. */
const text = (value) => [{ type: 'text', text: value }];

/**
 * The status tool definition.
 *
 * `deferLoading: true` is what §13 specifies: this is a diagnostic tool rather than part of ordinary
 * work, so its schema stays out of every request.
 *
 * Measured in clean sessions (2026-10-14, `doc/dev-notes.md`), that flag also has a consequence the
 * design did not anticipate: a deferred tool is **absent from the model's declaration set**, and a
 * tool that is deferred from the moment it is registered is never announced either — the agent loop
 * emits `tool-addition` only for names missing from the previous request header, and this one is
 * always in it, `deferLoading` and all. The tool stays callable by name; what is lost is the way the
 * model would learn the name exists. So the name is published where the model always reads it: the
 * refresh tool's description. {@link undiscoverableTools} enforces that.
 *
 * @param {object} input
 * @param {(cwd?: string) => Promise<object>} input.report - builds the structured report on demand
 * @returns {object} a `ToolDefinition`
 */
export function createStatusTool({ report }) {
  return {
    name: STATUS_TOOL_NAME,
    description:
      'Report the state of the .NET Agent Skills provider: which skills are selected and why, catalog cost, ' +
      'snapshot provenance, effective description limits, pointers, PowerShell dependencies and skipped skills. ' +
      'Pass cwd to report another workspace instead of the calling session\u2019s.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'Render the report as markdown for reading, or as JSON for scripting. Defaults to markdown.',
        },
        cwd: {
          type: 'string',
          description:
            'Workspace to evaluate project detection against, instead of the calling session\u2019s.',
        },
      },
    },
    deferLoading: true,
    output: {
      // The host enforces a JSON Schema *subset* and rejects a registration that leaves it. `required`
      // is supported only as an array on an object node; a per-property `required: true` is refused at
      // registration time, which is exactly how the first install of this plugin failed to activate.
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['format'],
        properties: {
          format: { type: 'string', enum: ['markdown', 'json'] },
          markdown: { type: 'string' },
          report: { type: 'object' },
        },
      },
      render: (_args, value) => {
        if (value.format === 'json') return text(JSON.stringify(value.report, null, 2));
        return text(String(value.markdown ?? ''));
      },
    },
    async execute(args, exec) {
      // Detection is a property of a workspace, and this is the only place an operator can ask about
      // one that is not the current session's. Without an explicit `cwd`, the session's own workspace
      // is the right answer: it is the one the catalog being reported was built for.
      const requested = typeof args?.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined;
      const cwd = requested ?? exec?.agent?.session?.header?.cwd;
      const structured = await report(cwd);
      const format = args?.format === 'json' ? 'json' : 'markdown';
      return format === 'json'
        ? { format, report: structured }
        : { format, markdown: renderStatusReport(structured), report: structured };
    },
  };
}

/**
 * The refresh tool definition.
 *
 * The provider has no TTL, so a project that gains a test project mid-session would otherwise
 * keep its original catalog until restart. Invalidating is cheap and the host re-reads on its
 * next discovery.
 *
 * This description is also the **discovery channel for the deferred status tool**: it is the only
 * always-declared text this plugin owns, and a deferred tool's name appears nowhere else the model
 * can read. Keep the name in it, built from {@link STATUS_TOOL_NAME} rather than typed out, and keep
 * the invalidation sentence first — the tool's own job still has to be the first thing it says.
 *
 * @param {object} input
 * @param {() => boolean} input.invalidate - asks the host to drop its catalog caches
 * @returns {object} a `ToolDefinition`
 */
export function createRefreshTool({ invalidate }) {
  return {
    name: REFRESH_TOOL_NAME,
    description:
      'Invalidate the skill catalog so project signals and configuration are re-read. Use after adding project ' +
      'files mid-session (a new test project, a Directory.Build.props, a binlog) when the skill list looks stale. ' +
      'For a diagnostic report covering the selected skills and why they were chosen, catalog cost, snapshot ' +
      `provenance and effective limits, call ${STATUS_TOOL_NAME}.`,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['invalidated', 'note'],
        properties: {
          invalidated: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => text(String(value.note)),
    },
    async execute() {
      const invalidated = invalidate();
      return {
        invalidated,
        note: invalidated
          ? 'Skill catalog invalidated. The next catalog read re-runs selection and project detection.'
          : 'The provider is no longer registered, so there was nothing to invalidate.',
      };
    },
  };
}

/** Assert every diagnostic key of §11.4 is present, used by the suite and by activation smoke. */
export function missingDiagnosticKeys(report) {
  return DIAGNOSTIC_KEYS.filter((key) => report[key] === undefined);
}

/**
 * Deferred tools whose name no declared tool's description mentions.
 *
 * A deferred tool is invisible to the model's declaration set, so being named by a tool the model
 * *can* see is the only way it is discoverable at all. That makes this a behavioural invariant rather
 * than a style rule: without it, `deferLoading: true` silently means "callable only by an agent that
 * already knows the name" — which is the field-test defect (dev-notes, issue 0001), not a saving.
 *
 * @param {Array<{ name: string, description?: string, deferLoading?: boolean }>} definitions
 * @returns {string[]} the deferred tool names nothing points at
 */
export function undiscoverableTools(definitions) {
  return definitions
    .filter((definition) => definition.deferLoading === true)
    .filter(
      (definition) =>
        !definitions.some(
          (other) =>
            other !== definition &&
            typeof other.description === 'string' &&
            other.description.includes(definition.name),
        ),
    )
    .map((definition) => definition.name);
}

/** Build the report object the status tool serves, from the live collaborators. */
export function makeReportBuilder(dependencies) {
  return () => buildStatusReport(dependencies);
}
