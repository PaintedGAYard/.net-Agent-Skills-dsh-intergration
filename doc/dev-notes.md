# Development notes

Findings from building P0, recorded because they change what the next phase should do or because
they correct a number in the design documents. Everything here was measured on the pinned baseline
(`dotnet/skills` `v1.0.0`, `cb7c10bd32b250459632df9e6fa1350cdaf00b18`).

## Where the design documents and the baseline disagree

Three numbers in `doc/spec.md` do not survive measurement. The implementation follows the
measurement, and each of these is asserted in the test suite so the correction cannot silently
revert.

### 1. The label census is 47 / 21, not 50 / 18

`doc/spec.md` §2.4 says 50 descriptions carry `USE FOR:`, 50 carry `DO NOT USE FOR:`, and 18 carry
neither. The measured counts over the 68 in-range skills are:

| | count |
|---|---|
| contain the exact text `USE FOR:` | **47** |
| contain the exact text `DO NOT USE FOR:` | **47** |
| contain both | **47** |
| contain neither | **21** |
| contain only one | **0** |

The `50` comes from counting lines that *start with* `USE FOR:`: four descriptions mention it only as
a sentence inside prose rather than as a tag. The number that matters is unchanged — §7.5's
"if and only if" still holds in both directions, and the 47 entries it constrains are the 47 §7.5
already calls out.

The consequence for P1 is real but small: **21 entries have no mechanical label guarantee, not 6.**
The six entries §2.4 names are the ones whose routing signal is buried in a long prose description,
which is why they are the ones worth human review; the other fifteen are short pass-through-grade
texts where nothing is being compressed. The authoring checklist for P1 should say "review the six"
and treat the other fifteen as ordinary.

### 2. The pointer census matches, but the dangling set does not

§2.8's census is confirmed exactly: **32** distinct in-range skills are pointed at, **36** are never
pointed at, and `build-perf-diagnostics` is the most-pointed-at target with 5 inbound pointers.

The two dense targets are not what §2.8 implies, though. `writing-mstest-tests` and
`test-anti-patterns` each have five inbound pointers in the whole baseline, but **four of each five
come from `dotnet-experimental` descriptions**, which this release neither ships nor authors. Inside
the 68-skill population each has exactly one inbound pointer.

The dangling-pointer set is also smaller than described. §2.8 and §7.6 report four pointers to
excluded names (`exp-assertion-quality`, `exp-mock-usage-analysis`, `exp-test-maintainability`,
`exp-test-smell-detection`) and W9's acceptance criterion asks for "exactly 4 names". Measured, there
is **one**: `dotnet-test/test-anti-patterns` → `exp-test-smell-detection`. The other three live inside
the excluded descriptions themselves, so they never enter the authored population.

`tools/descriptions.mjs verify` reports whatever it measures, and the test asserts the measured set.
The acceptance criterion should be restated as "report the dangling set, and confirm it is what the
census says" rather than a fixed count of four.

### 3. The catalog cost is 902 characters, not ~900 for 3 and ~20,800 for 68

The estimate in §8.4 was close for the default core set and is now exact, because the status tool
reports the length of the string the host actually publishes:

```
3 entries   865 characters of served description + 37 characters of shell = 902  (16 estimated tokens)
```

Reading *served* rather than *upstream* text matters: the upstream total for the same three skills is
1,173 characters, so an implementation that reports upstream lengths overstates the cost by 30%. The
`test/host-integration.test.mjs` case asserts the reported number against the catalog the real
`@deepseek-ai/dsh-skill` registry produces.

## Host behaviour that was confirmed, not assumed

- **A provider that throws is contained; an invalid candidate is not.** The registry wraps
  `provider.list()` in its own `try/catch` and merely marks the layer uncacheable, but candidate
  validation runs outside it. One malformed candidate rejects the host's whole catalog read — every
  provider's, not just ours. `test/host-integration.test.mjs` asserts both halves of this, because it
  is the reason the provider self-validates instead of trusting its own construction.
- **The documented rank constants are current**: `BUNDLED_SKILL_RANK` is 600, so `rank: 700` puts
  user and bundled roots ahead of this provider as §6.1 intends.
- **`ctx.provide` and `ctx.skills.registerProvider` return disposers**, and `ctx.effect` wants a
  callback that *returns* one. Passing the disposer directly registers the disposer as the cleanup
  and nothing ever unwinds. `apply()` wraps both, and an unload test asserts that the provider, the
  service and both tools all disappear.
- **`ctx.skills.snapshot()` reports `complete: false` without discarding the catalog**, and
  `dsh-tool-skill` skips publishing when it sees that. Returning `complete: false` is therefore safe
  but not free: it suppresses an update that would otherwise have been published.
- **`@deepseek-ai/schemastery` is not on a bundle's resolution path.** See below.
- **A deferred tool is callable but not discoverable, and a baseline one is never announced.**
  `deferLoading: true` keeps a tool out of the model's declaration set while the registry still resolves
  a call by name, so the two sets diverge. The announcement path cannot close the gap by itself:
  `dsh-agent-loop` builds `tool-addition` blocks by diffing tool names against the *previous* request
  header (`lib/index.js:1230-1247`), and `dsh-llm`'s `offered` set only decides which already-issued
  additions survive (`lib/index.js:806`). A tool deferred from the moment it is registered is in every
  header, so it is never *new*. Both directions were observed: two clean sessions showed 27 declared
  tools without `dotnet_skills_status` and zero `tool-addition` blocks, while a session that enabled this
  plugin mid-flight did receive an addition for it. The status tool's name is therefore published in the
  refresh tool's description, and `undiscoverableTools()` fails loudly if that stops being true.
- **The declared tool set is not the callable tool set**, so "no such tool exists" cannot be argued from
  an enumeration. The field test's agent listed 26 tools — omitting `write`, which it had used nine times
  — and asserted that no catalog-dumping tool existed while holding one that answered. To claim a tool is
  absent, probe the name once; the call is cheap and it settles the question.

## The `Config` fallback

The dsh installation does not put its own packages where a profile-installed bundle can resolve them:
the profile's `node_modules` is empty, this workspace has none either, and a static
`import z from '@deepseek-ai/schemastery'` fails at link time — which would take the whole plugin
down, not just the schema.

`lib/config.js` therefore attempts the import dynamically and keeps both paths:

| path | when | behaviour |
|---|---|---|
| `schemastery` | the package resolves | `Config` is exported and the host validates the row's `config` |
| `fallback` | it does not (the common case here) | `Config` is `undefined`, `resolveConfig()` applies the same field names, defaults and ranges |

Declaring `@deepseek-ai/schemastery` as a dependency **does not fix this, and that was measured.** The
plugin manager installs a local bundle directory with a `link:` specifier, and pnpm does not traverse a
linked package's dependencies at all. After adding the dependency to `dependencies`, `pnpm install` in
the profile still reported *"Already up to date"* and `node_modules/@deepseek-ai` stayed absent. The
declaration was reverted rather than kept as decoration.

The observable consequence today is that the plugin row reports `status: "absent"` in
`Config.listConfigs`, so the Plugin Manager card offers no configuration form. Everything else works:
`resolveConfig()` validates types and ranges, unknown fields warn, and the same field names, defaults
and `ui` tiers from §11.2 apply. The status tool records that the fallback is live, so the difference
is visible rather than silent.

Two ways to reach the schema path, neither available to this package on its own:

- the Harness resolves its own packages for bundles, or installs local directories as `file:` rather
  than `link:`; or
- the bundle vendors schemastery (118 KiB, zero dependencies, MIT) under its own tree.

The dynamic import means either would begin working with no code change here.

## The `pnpm` prerequisite, and one consequence for iterating

`plugin_manager install_bundle` shells out to the bare name `pnpm`, so it needs `pnpm` on the Harness
process's `PATH`. On this machine `pnpm` lives in `%APPDATA%\npm`, which was absent from both the
machine and user `PATH`; adding it there fixed the install. `npx pnpm` cannot substitute, because the
plugin manager spawns `pnpm` directly.

A consequence worth knowing before the next code change: the profile depends on the bundle by symlink,
so edits are visible immediately — but **a module the running process has already imported is never
re-imported**. The Harness's HMR watcher runs with `root: []`, so it watches only the profile's patch
files and `package.json`; touching a source file under the bundle does nothing, and `set_bundle`
off/on reloads the *row*, not the module. After changing plugin code, restart the Harness.

This cost one full install cycle here: the first activation failed on a schema defect
(`schema.properties.format.required is not supported on type "string"`), the code was fixed and
verified against the host's own `assertSupportedJsonSchema`, and the running process kept reporting the
old error from its cached module generation.

## Deliberately not built in P0

- **`lib/deploy/`, `lib/platform/`, `lib/analytics.js`.** Scheduled for P1 (W12) and P2. `lib/detect.js`
  was the third one and is no longer missing — see "W11: project detection" below.
- **The remaining 51 authored descriptions.** `tools/descriptions.mjs prepare` emits the input pack
  for all of them, with the pointer lists split into "must keep" and "droppable", so the work is
  writing text rather than building tooling.
- **Project detection's signal table.** *Resolved in W11: the note here was circular.* It said the
  table "needs M10's false-positive data to be worth writing, and that data needs a live install" —
  but there is no way to measure detection without a detection to measure. The table was written from
  §9.2 instead, and M10's data prunes it afterwards; dev-plan §2.3 already grants that, and removing a
  signal does not violate grow-only, which is a within-session rule.

## Live verification (first successful install)

The plugin installed as the `web` profile's bundle `dsh-dotnet-skills` and activated. Recorded here
because these are P0's Measure items and the numbers are the baseline for P1's decisions.

| item | observed |
|---|---|
| Catalog | 3 entries, **902 characters**, 16 estimated tokens |
| Snapshot | `v1.0.0` (`cb7c10bd`), digest `ok`, 11 files / 56,171 bytes, line endings `lf`, age 0 days |
| Selected skills | `csharp-scripts`, `dotnet-pinvoke`, `nuget-trusted-publishing`, all `core-set` |
| `descriptionMode` | `authored`; 0 descriptions truncated by `cap()` |
| `resourceBase` (M2) | the `skill` tool result carried `Base directory for this skill: …\vendor\upstream\dotnet\skills\csharp-scripts`, so relative references resolve |
| `dotnet_skills_refresh` | returned `invalidated: true` and the catalog was unchanged afterwards, as it must be while the snapshot has not moved |
| PowerShell (M3) | `pwsh: PowerShell 7.6.6` — probed once, not assumed |
| Output schema | accepted by the host's own `assertSupportedJsonSchema` after the `required` fix |
| Shadowing | the report lists ranks 100/200/300/400/500/600/700 with this provider last, and states plainly that the host cannot list shadowed definitions |

The catalog cost is worth reading carefully: 902 characters is the length of the string the host
publishes, and the status tool reports it by asking the provider for its own candidates. The upstream
descriptions for the same three skills total 1,173 characters, so a report built from upstream text
would have overstated the cost by 30%.

### M4 and M5: verified to the boundary a session can reach

Both are client interactions, so both were verified as far as the policy the client consults — and no
further. Claiming more would be claiming a click nobody made.

- **M4 (sidebar preview).** `dsh-client-ui-skill` implements it as
  `catalog.find((skill) => '/name' === ref)?.path` followed by opening that file. Every candidate
  carries an absolute `path`, and the file it points at reads back as the published `SKILL.md`,
  frontmatter (`USE FOR:` and all) included — because authoring changes the catalog text and never the
  body.
- **M5 (`/name` gesture).** `dsh-tool-skill` injects the body for a name where `isUserInvocable` holds.
  All three summaries are user- and model-invocable, asserted against the host's own predicates in
  `test/host-integration.test.mjs`. The catalog is already reaching the model: the `available_skills`
  list in this session contains the three entries with their authored descriptions, delivered through
  this provider.

What remains for both is typing `/csharp-scripts` and clicking the token. Neither is in doubt — the
code on both sides of the boundary is asserted against the real host — but neither is measured either.

## W11: project detection

`lib/detect.js` answers one question about a workspace — which upstream plugins does this project give
evidence for — from the filesystem alone, with no shelling out (§9.1). The host names the workspace:
`@deepseek-ai/dsh-tool-skill` calls `list({ cwd: exec.agent?.session.header.cwd })`, so the same `cwd`
reaches the fold, the `project-detection` selector and this module. `test/detect.test.mjs` runs the
signal table row by row against real fixture directories.

### The definitions §9.2 leaves open

| §9.2 row | how it is read here | enables |
|---|---|---|
| `.sln` / `.slnx` / `.csproj` / `Directory.Build.props` / `Directory.Packages.props` / `global.json` / `nuget.config` | name, case-insensitive | **nothing** — `dotnet` is always in (rule one) |
| `*.binlog` or `-bl` artifacts | name matches `*.binlog` / `*.binlog.*` | `dotnet-msbuild` |
| `Directory.Build.targets` | name | `dotnet-msbuild` |
| deep `*.props` hierarchy | a `*.props` at relative depth ≥ 3 | `dotnet-msbuild` |
| test SDK / MSTest / xUnit / NUnit / TUnit / `UseMicrosoftTestingPlatformRunner` | package names in project text, whole-word for the short ones | `dotnet-test` |
| VSTest **and** MTP traces | (`Microsoft.TestPlatform` / `Microsoft.NET.Test.Sdk` / `*.runsettings`) **and** (`UseMicrosoftTestingPlatformRunner` / `Microsoft.Testing.Platform` / `TestingPlatformDotnetTestSupport` / `EnableMSTestRunner` / `EnableNUnitRunner` / `dotnet.config`) | `dotnet-test` |
| `<UseMaui>` / `MauiProgram.cs` | project text, or name | `dotnet-maui` |
| `Microsoft.NET.Sdk.Web` / top-level `app.MapGet` | project text, or a source line matching `^\s*app\.MapGet\(` | `dotnet-aspnet` |
| `Microsoft.EntityFrameworkCore` | project text | `dotnet-data` |
| `net8.0` / `net9.0` / `net10.0` beside a higher target | `net(\d+)\.(\d+)` collected across project text: the lowest ∈ {8.0, 9.0, 10.0} **and** something strictly higher | `dotnet-upgrade` |
| `Microsoft.ML` / `Microsoft.SemanticKernel` / MCP server | project text, or a `.mcp.json` / `mcp.json` / `.mcp` entry | `dotnet-ai` |
| `.template.config` | directory name | `dotnet-template-engine` |
| `*.dmp` / `*.nettrace` / symbolicated stack / tombstone | name, or a `.txt`/`.log` line matching `^\s*at [a-z_][\w.`+]*\(` | `dotnet-diag` |

`netstandard2.0` and `net472` cannot match the target-framework pattern (it needs digits immediately
after `net` and a dot after them), and `net11.0` on its own matches nothing: rule two — the upgrade
skills cover 10-to-11, but there is no `dotnet11` plugin to enable.

**`dotnet-nuget` has no row.** Its only skill is `convert-to-cpm`, and `Directory.Packages.props` is
evidence *against* that change rather than for it, so those files stay in row one as
.NET-repository evidence. The plugin remains reachable through `enabledPlugins: ['dotnet-nuget']`, and
the suite asserts the exception list — a marketplace range that grows turns this into a failing test
rather than a silent dark spot.

### What the scan refuses to do

- **Read generated output.** `obj/`, `bin/`, `.git/`, `.vs/` and `node_modules/` are never descended
  into: `obj/project.assets.json` lists every transitive package, so reading it would report
  `Microsoft.EntityFrameworkCore` for any repository that depends on something that depends on EF Core.
- **Read text that carries no signal.** Content comes from `.csproj`, `.props`, `.targets`, `.sln`,
  `.slnx`, `.cs`, `.txt` and `.log`. `.json` is name-only (`global.json`, `nuget.config`, `.mcp.json`),
  and `.razor` is not read at all — rule two says Blazor has no plugin in this release.
- **Match short names loosely.** `TUnit` as a substring matches `oppor<u>tunit</u>y`, so the short
  framework names are matched whole-word.
- **Follow a link.** `withFileTypes` reports a symlink as neither file nor directory, which is what
  keeps a link loop from turning the walk into an infinite one.
- **Descend into a nested repository.** A directory other than the root that carries a `.git` entry is
  its own project — a submodule, a vendored checkout, a nested clone — so its build files, test fixtures
  and sample logs are evidence about *that* project rather than about the workspace the session was
  opened in. This rule is the first thing a live measurement changed; the measurement is below.

### The four contract properties

| property | how it is held | how it is checked |
|---|---|---|
| bounded | `probe.maxFiles` caps entries — files **and** directories counted, so a tree of empty directories is bounded too — `probe.maxDepth` caps the descent, 256 KiB per file and 8 MiB of content per scan | a `maxFiles: 3` fixture reports `truncated: 'entries'`; a binlog below `maxDepth` is not seen, and is seen when the bound is raised |
| pure | no clock, no globals, no `process.cwd()`, no shelling out | two independent detectors over equal fixtures deep-equal; fixtures pin every mtime so the memo key is deterministic |
| memoized | key is `(cwd, mtime bucket)` with `bucket = floor(max(cwd mtime, newest child mtime) / 2000)` — file mtimes rather than the clock, which is also why creating or deleting a file lands in a new bucket | the same bucket returns *the same object*; a bumped mtime rescans; `bucketMs: 0` disables the memo for debugging |
| grow-only | the memo keeps the plugin set per workspace and unions each scan into it, reporting what only an earlier scan saw as `retained` | deleting the `*.binlog` after a first read still selects `dotnet-msbuild`, and a second fold is a superset of the first |

The bucket exists because the host reads the catalog more than once per session and a workspace scan is
not free; 2000 ms matches the coarsest mtime granularity this has to run on.

### Acceptance

`dotnet_skills_status` after a restart — the tool is deferred, so its name comes from the refresh
tool's description (issue 0001):

- §1 reads `Project detection: enabled. Last detection (<workspace>): … - scanned N files / M dirs
  [signals: …]`. The states that look alike are named rather than implied: `no workspace was named, so
  nothing was scanned`, `<dir> could not be read, so nothing was scanned`, and `no signal matched`.
- `dotnet_skills_status(cwd: <dir>)` reports a workspace other than the session's, which is how M10 can
  run over a set of repositories. A directory holding a test project selects `dotnet-test`'s skills with
  `project-detection:dotnet-test` as the reason; a directory holding only a `.csproj` stays at the three
  core skills.
- `probe.enabled: false` prints `disabled by probe.enabled.`, records no `last`, and scans nothing.

The fixture this was checked against locally — one directory exercising four rows plus one deliberate
trap, written under the gitignored `.tmp-test/`:

```text
.tmp-test/detect-fixture/
  Directory.Packages.props                  row one: .NET evidence, enables nothing
  App.sln                                   row one
  msbuild.binlog                            -> dotnet-msbuild
  src/App/App.csproj                        net8.0;net10.0            -> dotnet-upgrade
                                            Microsoft.EntityFrameworkCore -> dotnet-data
  tests/Tests.csproj                        Microsoft.NET.Test.Sdk + xunit -> dotnet-test
  obj/Debug/net10.0/Generated.csproj        <UseMaui>true</UseMaui> inside obj/: must NOT select dotnet-maui
```

Reported: `dotnet-data+dotnet-msbuild+dotnet-test+dotnet-upgrade`, 5 files / 4 dirs scanned, signals
`dotnet-repo, msbuild, test-sdk, ef-core, upgrade`, no Maui — the trap holds. Note that a scratch
project *inside* the session's own workspace is, correctly, evidence for that workspace: delete it
before measuring the default catalog, or the session will select those four plugins.

### M10, first measurement: the live run, and what it caught

The first live run of W11 was this plugin's own repository, and it is the most useful measurement the
feature has produced so far. Restart, `dotnet_skills_status`, one line:

```text
Project detection: enabled. Last detection (…\.net-Agent-Skills-dsh-intergration):
dotnet-ai+dotnet-aspnet+dotnet-data+dotnet-diag+dotnet-msbuild+dotnet-test —
scanned 1457 files / 667 dirs [signals: dotnet-repo, msbuild, test-sdk, mtp-migration, aspnet, ef-core, ai, diag]
```

That is 49 catalog entries / 16,390 characters / 298 estimated tokens for a JavaScript repository, and
the wiring itself was fine: the host passed the session workspace, the memo and the bounds held, the
line rendered, and every root cause was traceable in one call — which is what §11.4 item 1 was built for.
Reading the evidence showed all of it came from one directory: `submodule/dotnet-skills/**`, the pinned
upstream checkout, which is a real .NET solution with a validator project, ~40 skill test fixtures, an
ASP.NET sample, an EF Core sample and four `tombstone_*.txt` samples. The scan was right about the files
and wrong about the project.

| | before | after |
|---|---|---|
| plugins selected | ai, aspnet, data, diag, msbuild, test | none |
| catalog | 49 entries / 16,390 chars / 298 est tokens | 3 / 902 / 16 |
| scanned | 1457 files / 667 dirs / 4.5 MB read, depth 9 | 347 files / 155 dirs / 7.7 KB, depth 7 |
| cold wall clock | ~250 ms | not separately measured (fewer entries by construction) |

The fix is the nested-repository rule above, and it generalises: a submodule or vendored checkout is a
different project whether it is the upstream skills repository or someone's vendored library. Two tests
hold it — one asserts that a nested repository's fixtures contribute nothing while the root's own test
project still selects `dotnet-test`, the other asserts that a workspace which is *itself* a repository
is still scanned, since that is the ordinary case and not an exception.

What this measurement says for §2.3's question ("which signals are noise"): the noisy thing was not a
signal row but the scan scope, and the row that came closest — `mtp-migration`, firing on upstream test
fixtures that pair a `.runsettings` with MTP traces — is now silent here for the same reason. Signals
worth re-examining once M10 runs over real repositories: `aspnet` via top-level `app.MapGet` (any sample
or tutorial in a repository will contain one) and `diag` via a symbolicated stack in any `.txt` or `.log`
(a crash report filed in the repository is not a diagnostic workload).

## W12: the deployment pipeline

`lib/platform/{index,win32,linux,macos}.js` + `lib/deploy/{index,manifest}.js` + `tools/deploy.mjs`,
per §10. Deployment stays off the provider's data path — the catalog always comes from
`vendor/upstream/**` — and materializes the same selection a session would see (core set + configuration
baseline + detection for `--cwd`), or the whole range with `--all`.

### The Windows symlink privilege, measured

The design premise is that **most users cannot create symlinks**, so the copy fallback is the ordinary
path rather than an edge case. Operator-confirmed and consistent with what was measured: Windows grants
symlink creation to administrators by default, and to other accounts only through Developer Mode or a
group policy granting `SeCreateSymbolicLinkPrivilege`. This machine is configured for all accounts, and
Developer Mode is *off* (`AllowDevelopmentWithoutDevLicense` is absent) — so the privilege here comes
from the policy, not from Developer Mode.

| environment | probe | deployment |
|---|---|---|
| this machine, unsandboxed process | `ok` | `symlink`: real directory links, snapshot edits visible through them, a re-run is a no-op |
| the same directory, inside the Harness file sandbox | `EPERM` | `copy`, logged and recorded in the manifest with the reason |
| WSL | **not measured** | `wsl.exe` denies access from this session (`Wsl/E_ACCESSDENIED`); §10.5's rule stands — `$HOME` on ext4 only, never `/mnt/c` |

The sandbox row is the interesting one: the restricted token loses the privilege that the account has,
so a deployment run *from inside an agent session* silently gets the worse mode. That is exactly the
case §10.3 says must be loud, and it is: the CLI writes it to stderr, the manifest records
`degradedReason`, and `dotnet_skills_status` §6 prints it.

### Two defects the real-links run caught

Both were unreachable while symlinks were refused, which is why the acceptance suite has to run outside
the sandbox at least once (210 tests, 0 skipped there; 6 cases skip when links are unavailable, and the
skip reason is the measured code).

- **A re-deployment tried to re-create existing links** (`EEXIST`). Two causes, both fixed: Windows
  reads a link back as `\\?\C:\…` while its target was written as `C:\…`, so a byte comparison said
  "different link" — path folding is now a platform property (`win32.foldPath` strips the prefix and
  folds case, `linux.foldPath` is identity, and `tools/session-audit.mjs` was migrated onto it, which is
  also what removed the last `process.platform` outside `lib/platform/`); and the writer itself now
  leaves a correct link alone instead of calling `symlinkSync` over it.
- **A collision deleted a user's directory.** The first version removed whatever sat at a wanted
  destination to make room, which is the "deployment eats your work" failure. The rule is now: a path
  that exists and is not in the previous manifest is *not ours* — copy mode merges into it and records
  only the files it wrote, symlink mode skips that skill and says so, and the manifest records what was
  actually deployed rather than what was wanted. Deleting a path this plugin did not write is now
  something no code path does.

### Acceptance

| | |
|---|---|
| suite, unsandboxed | **210 tests, 210 pass, 0 fail, 0 skipped** |
| suite, sandboxed | 204 pass, 0 fail, 6 skipped (links refused, copy path asserted by their siblings) |
| deploy, real symlinks | three links, `SKILL.md` byte-identical through the link, re-run reclaimed nothing |
| deploy, copy mode | files recorded in the manifest; a user file inside a deployed skill directory and a user directory in the root both survive |
| dangling | deleting a link's target makes `--status` report `dangling: dotnet-pinvoke` and exit 1 |
| manifest | unreadable manifest → the deployment refuses and the report says `unknown`, rather than emptying the root |

One deviation is stated rather than hidden: §10's dev-plan case 7 also asks that `list()` return
`complete: false` when a link dangles. The provider's `complete` is about reading the *snapshot*, and
deployment is deliberately not on that path, so the deployment-level answer lives on the deployment
record (`inspectDeployment().complete`) and in §6 — merging the two would make one flag mean two things.
The `--status` exit code carries the same signal for scripts.

## Field test round 1, and what it changed

An independent clean-context test (`drafting/issues/`, raw report in the gitignored `.tmp-test/`) ran the
plugin for real: a subagent that was not allowed to read `vendor/`, `submodule/` or `data/` built a small
C# tool, and the bypass audit was done from its session log rather than from its own account.

**Confirmed, no action taken.** The catalog is byte-identical across two independent clean sessions
(3 entries, 902 characters); the `skill` payload's sha256 equals the snapshot's `SKILL.md` for two
different skills; the base directory is absolute and its relative references resolve to the right byte
count; the authored descriptions match `data/descriptions.json` exactly; one of four offered skills was
loaded and every exclusion traced back to a `DO NOT USE FOR:` clause; `refresh` left the catalog
unchanged; all gates were green.

**Fixed here.**

- **The status tool was callable but undiscoverable.** `deferLoading: true` is what §13 asks for, and the
  measured consequence is that the tool is invisible to the model and never announced (above). The name is
  now published in the refresh tool's description — built from `STATUS_TOOL_NAME`, so a rename cannot
  leave it pointing at a ghost — and `undiscoverableTools()` makes the invariant explicit at activation and
  in the suite. The alternative, dropping the flag, costs the status tool's whole description and schema in
  every request (roughly 100 tokens) against roughly 30 for the sentence; §13's intent is preserved instead
  of traded away. See §13 of the spec for the recorded semantics.
- **`probe.*` was a silent no-op.** The report now says detection is not wired and that the core set is the
  whole selection, and a configuration that sets `probe.*` warns once at activation. A wired `detect` reads
  as enabled or disabled instead, so the text cannot go stale when P1 lands.

**Recorded, deliberately not fixed.** The offline file-based app failure is an upstream content gap (§6.6
forbids rewriting `SKILL.md`, and a description may not carry usage conditions): `drafting/upstream/`.
Project detection and the deploy pipeline stay in P1; their absence is now visible rather than inferred.

**Sequencing.** This fix round is accepted on the three-skill snapshot *before* P1 widens the range.
Widening it changes the very surface the acceptance inspects, and "the fix worked" would be
indistinguishable from "the catalog grew".

**Acceptance, live after a Harness restart (2026-10-14).** `tools/session-audit.mjs` reads the wire, so
before and after are facts rather than claims:

| | before the fix | after |
|---|---|---|
| declared tools in the session header | 31 (one deferred) | 31 (one deferred) |
| `dotnet_skills_status is named by` | `nothing` | `dotnet_skills_refresh` |
| `Unreachable deferred tools` | `dotnet_skills_status` | *(line absent)* |

The declared text, verbatim: *"Invalidate the skill catalog so project signals and configuration are
re-read. … when the skill list looks stale. For a diagnostic report covering the selected skills and why
they were chosen, catalog cost, snapshot provenance and effective limits, call `dotnet_skills_status`."*
The status tool still carries `deferLoading: true`, so §13 is untouched. A name probe
(`dotnet_skills_status {}`) answers with the full ten-section report, whose §1 now carries:

```text
Project detection: not implemented in this version - probe.* has no effect yet; the core set is the
whole selection (spec §9 lands with P1).
```

Everything the fix must not have moved is unchanged in the same report: 3 entries, 902 characters,
16 estimated tokens, snapshot digest `ok`, 11 files / 56,171 bytes, line endings `lf`, 2 authored
entries, 0 truncated by `cap()`, rank 700.

## Independent acceptance runs

The field test's value came from its *method* rather than its matrix: a clean-context subagent that was
forbidden to read the upstream text, plus an audit performed from the session log instead of from the
agent's own account. That method is now repeatable, and the fix for the status tool is validated by it.

**Protocol**

1. Run the work in a `subagent` (clean context), never in the session that wrote the code. Give it one
   deliverable, and forbid every path outside its working directory by name — `vendor/`, `submodule/`,
   `data/`, `lib/`, `test/`, `tools/`, and the session logs.
2. Have it keep its own evidence: the catalog block verbatim, each `skill` payload, each base directory,
   and every command with its exit code.
3. Audit its tool calls from `~/.dsh/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd` using
   `node tools/session-audit.mjs --session <file> --root <dir>`. A run whose audit fails is void, not
   "mostly fine".
4. Do the fidelity comparison — hashes, byte-for-byte — in the *controlling* session. That comparison is
   itself the bypass the subagent was forbidden to perform, so it cannot be its job.

The audit separates four things that are easy to conflate. `relative` counts paths that cannot leave the
root, `patterns` counts globs (a pattern outside the root is an escape, so it is classified rather than
skipped), `outside` is the only verdict-bearing list, and `mentions` are paths that appear inside a shell
command — reported for a human to read, never counted as escapes. That last split is not cosmetic: a
version that scanned every string argument accused this repository of 488 escapes in one session, nearly
all of them regex literals and synthetic fixtures inside an `edit` payload.

**Environment conventions, measured the hard way**

- **`DOTNET_CLI_HOME` and `NUGET_PACKAGES` must be absolute.** The SDK refuses a relative one outright
  (`'NUGET_PACKAGES' must contain an absolute path '.tmp-test/.nuget-a'`), which costs a whole call. Build
  them with `Join-Path (Get-Location).Path '.tmp-test/.nuget'` so the output still lands in the workspace.
- **Make an offline restore explicit.** A `nuget.config` with `<clear/>` in the test directory turns
  `NU1301` (no network) into `NU1101` (package genuinely absent), which is the difference between an
  environment problem and a content problem.
- **An offline file-based app needs `#:property PublishAot=false`.** `dotnet <file>.cs` defaults to
  `PublishAot=true`, and the publish path restores `Microsoft.DotNet.ILCompiler` and friends from NuGet.
  `-p:SelfContained=false` does not help; `PublishAot=false` does. This is an upstream content gap, and
  the plugin may not close it by editing `SKILL.md` — see `drafting/upstream/0003-offline-file-based-app.md`.
  It is recorded rather than fixed because §6.6 turns "the skill is wrong" into something the user can see.
- **Do not tidy the build output.** A file-based app builds under the DSH session temp area
  (`…\AppData\Local\Temp\dsh-*\dotnet\runfile\<name>-<hash>\`), so there is nothing in the workspace to clean.

## Command reference

```powershell
node tools/test.mjs                            # 210 tests, one process
node tools/descriptions.mjs verify             # invariants ①–⑩ and drift  (exit 0 required)
node tools/descriptions.mjs prepare            # authoring input pack → .authoring/
node tools/assemble-descriptions.mjs <specs.json> [--dry-run]   # clause lists → data/descriptions.json
node tools/version.mjs                         # CHANGELOG ↔ UPSTREAM.json  (exit 0 required)
node tools/sync-snapshot.mjs --ref v1.0.0 --dry-run
node tools/capture-fixtures.mjs [--check]      # refresh the frozen frontmatter fixtures
node tools/session-audit.mjs --session <session.v4.jsonl.zstd> [--root <dir>] [--allow <prefix>] [--json]
node tools/deploy.mjs [--cwd <dir>] [--root <dir>] [--plugins a,b] [--skills x,y] [--all] [--status] [--dry-run] [--json]
```

The deploy tool takes the platform's conventional root unless `--root` names one — the Harness's own
user skill root, `$DSH_HOME/skills` or `~/.dsh/skills`, which the host's filesystem provider already
scans at rank 400. Deploying there is the *alternative* to this plugin, not a companion to it: rank 400
wins a duplicate name, so the verbatim upstream text would replace the authored descriptions. §6 of the
status report says so whenever a deployment exists.

`tools/assemble-descriptions.mjs` is how the 53 authored entries of P1 were written, and it is kept for
the reason §7.7 gives: a moved upstream tag rewrites part of that surface, and the specs under
`drafting/authoring-specs/` hold the intent that makes the rewrite a diff rather than a re-read. It
decides only *how much of a clause list fits* the 320-character budget — never what to say — and it
refuses to write when a mandatory clause (every pointer, the first of each list) does not fit.

`node --test test/` fails in this sandbox because it spawns a child process per file with piped
stdio, which the sandbox denies (`spawn … EPERM`). `tools/test.mjs` adds
`--experimental-test-isolation=none`; the suite needs no process isolation.
