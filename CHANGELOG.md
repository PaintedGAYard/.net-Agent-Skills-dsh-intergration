# Changelog

Every release records the upstream tag, commit and skill count it was built from, because the
plugin's own version line is independent of upstream (`doc/spec.md` §3.3). `tools/version.mjs`
checks that this file and `vendor/UPSTREAM.json` agree, so a snapshot update cannot land without a
matching entry here.

<!-- release-please-start -->
## 0.1.0 (unreleased)

Upstream: dotnet/skills v1.0.0 (cb7c10bd), 11 plugins / 68 skills

Phase A, P0: the skeleton, the authoring mechanism and the provider, proved end to end on the
`dotnet` plugin's three skills.

- **Provider** `dotnet-agent-skills` at rank 700: every candidate self-validated before it is
  returned, `complete: false` instead of a throw when the snapshot cannot be read in full, and
  definitions re-read on every `get()`.
- **Restricted frontmatter parser** covering exactly the shapes the pinned baseline uses: plain,
  double-quoted, single-quoted, `>` and `>-` folded block scalars, with unknown keys preserved
  verbatim. Verified against all 40 folded, 21 quoted and 7 plain descriptions in the baseline.
- **Description authoring** as data: `data/descriptions.json` carries two authored entries for the
  three-skill range; `tools/descriptions.mjs` provides the `prepare` input pack and the `verify`
  gate that enforces invariants ①–⑩ and fails the sync on upstream drift.
- **Pointer conservation** by loose extraction plus a name-universe lookup, which separates real
  skill pointers from English prose without any natural-language processing.
- **Selection middleware** exposed as `ctx.provide('dotnetSkills', …)` with the fold rules of §8.1,
  ready for third-party selectors, plus the core set and configuration baseline.
- **Snapshot sync** pinned to an explicit tag or commit, which refuses to run without `--ref` and
  never falls back to `main`.
- **Tools**: `dotnet_skills_status` reporting all ten diagnostics of §11.4, and
  `dotnet_skills_refresh` to invalidate the catalog after a project changes.

Measured on activation: 3 catalog entries, 902 catalog characters (16 estimated tokens) for the default
core set — the exact length of the catalog the host publishes, asserted against the real
`@deepseek-ai/dsh-skill` registry.

Verified against the real host runtime (`@deepseek-ai/cordis` + `@deepseek-ai/dsh-skill` from the dsh
installation, in `test/host-integration.test.mjs` and `test/apply.test.mjs`): the registry accepts every
candidate, rank 700 loses a duplicate name to a smaller rank as intended, a throwing provider is
contained while an invalid candidate is fatal, `ctx.provide('dotnetSkills', …)` is resolvable by a
third party, and unloading the plugin withdraws the provider, the service and both tools. Both tool
output schemas are additionally checked against the host's own `assertSupportedJsonSchema`.

Installed and enabled in the `web` profile as the bundle `dsh-dotnet-skills`. First live measurement of
the default core set: 3 catalog entries, 902 characters, 16 estimated tokens, a snapshot digest of `ok`
with LF line endings, and a `skill` tool result carrying a usable `Base directory for this skill:` path
— which is what lets the 30 baseline skills with `references/` resolve their relative links. PowerShell
availability is probed rather than assumed (M3: `PowerShell 7.6.6` here).

M4 (sidebar preview) and M5 (`/name` gesture) are verified to the boundary a session can reach: every
candidate carries the absolute `path` the preview opens, the file at that path reads back as the
published `SKILL.md`, and all three skills satisfy the host's own `isUserInvocable` predicate. The
resulting click is the user's to make, so neither is claimed as measured.

Known limitation: `Config` is not exported in this environment, so the host skips schema validation and
the Plugin Manager card offers no configuration form. §11.1 assumed a bundle could resolve
`@deepseek-ai/schemastery` from the dsh installation; it cannot, and declaring the dependency does not
help because the plugin manager installs local bundle directories with a `link:` specifier, which pnpm
does not traverse. `lib/config.js` therefore enforces the same field names, defaults, types and UI tiers
itself, and the status tool records that the fallback is live. See `doc/dev-notes.md`.

### Field-test round 1 (independent clean-session test, 2026-10-14)

An independent clean-context session drove the plugin through a real task while forbidden to read the
snapshot or the authoring data. Fidelity was then checked by hash and byte comparison in the controlling
session, and the bypass audit read the session's own log rather than the agent's self-report. Findings and
their disposition are recorded in `drafting/issues/`.

- **Fixed: the status tool was callable but undiscoverable.** `deferLoading: true` (§13) keeps it out of the
  model's declaration set, and a tool deferred from the moment it is registered is never announced, so no
  text the model could read contained its name. `dotnet_skills_refresh`'s description now names it, built
  from the exported constant, and `undiscoverableTools()` asserts the invariant at activation and in the
  suite.
- **Fixed: `probe.*` was a silent no-op.** The status report states that project detection is not wired and
  that the core set is the whole selection, and a configuration that sets `probe.*` warns once at activation.
- **Accepted live, after a Harness restart.** The session header's declared description now names the
  deferred tool (`dotnet_skills_status is named by: dotnet_skills_refresh`, where it previously read
  `named by: nothing`), the tool still carries `deferLoading: true`, and a name probe returns the full
  ten-section report. The catalog is unchanged at 3 entries / 902 characters with the snapshot digest `ok`.
- **Confirmed unchanged:** catalog injection is byte-identical across independent clean sessions (3 entries,
  902 characters), `skill` payloads hash to the snapshot's `SKILL.md`, relative references resolve from the
  published base directory, and routing excluded the three irrelevant skills with every reason traceable to
  a `DO NOT USE FOR:` clause.
- **Recorded, not patched:** the offline file-based app failure is an upstream content gap (`drafting/upstream/`),
  and the same directory records a host-side question about whether a deferred baseline tool should be
  discoverable at all.
- **New dev tool:** `tools/session-audit.mjs` reads a session log and reports declared tools (with their
  `deferLoading` markers), announced tool changes, calls to names no header declared, and every path the
  session resolved outside a given root. It is deliberately not part of the shipped bundle.
- **New dev tool:** `tools/assemble-descriptions.mjs` turns a hand-written clause list into an authored
  entry inside the 320-character budget, dropping only what the author marked droppable and refusing to
  write when a mandatory clause — every pointer, the first of each list — does not fit. The specs behind
  P1's batches 3 and 4 live in `drafting/authoring-specs/`, and the suite re-assembles them to the exact
  text in `data/descriptions.json`.

### P1 batch 1: the shipped range grows to four plugins (2026-10-14)

`node tools/sync-snapshot.mjs --ref v1.0.0 --plugins dotnet,dotnet-nuget,dotnet-diag,dotnet-ai --allow-partial`
brings `dotnet-nuget`, `dotnet-diag` and `dotnet-ai` into the snapshot: **16 skills across 69 files**. The
default catalog is unchanged — the core set is still the `dotnet` plugin's three skills at 902 characters —
because a wider range only makes skills *selectable*: through `enabledPlugins` today, and through project
signals once P1's detection lands. The remaining seven marketplace plugins stay queued in
`outOfRangePlugins`, which the status report still names.

Nine of the newly in-range descriptions fall under the coverage rule and were authored to the 320-character
budget, keeping every `USE FOR:` / `DO NOT USE FOR:` label upstream has (and not adding one where it does
not) and every required pointer to the sibling skills in the same plugin.

`tools/sync-snapshot.mjs` gained the missing half of `--allow-partial`: the flag was parsed and then never
passed to `planSync`, so the deliberate-friction path its own error message pointed at was unreachable and
every narrowed sync failed. The tests that had baked in P0's range now derive their expectations from
`vendor/UPSTREAM.json` and `data/descriptions.json`, so the remaining batches do not have to edit them.

### P1 batch 2: dotnet-msbuild (2026-10-14)

The heaviest single batch joins the range: **14 skills**, of which **12 needed authoring** — 10 of them
carrying an `INVOKES:` section, so most of the baseline's 13 arrived at once. The snapshot is now
**5 plugins / 30 skills across 93 files**. The default catalog is still the `dotnet` plugin's three skills
at 902 characters, because a wider range only makes skills selectable.

`INVOKES:` sections are dropped from the catalog text, as invariant ⑥ requires, and the provider keeps
them in each candidate's `metadata.upstreamInvokes` — read from the upstream description rather than from
the authored entry, so compressing the text cannot lose the record of what a skill invokes.

No test needed editing for this batch. The previous one replaced the assertions that had baked in P0's
range with derivations from `vendor/UPSTREAM.json` and `data/descriptions.json`, and that is what a range
change now costs.

### P1 batch 3: dotnet-test (2026-10-14)

The test plugin joins: **17 skills**, 12 of them authored. The snapshot is now **6 plugins / 47 skills
across 128 files**. Two of this batch have no `USE FOR:` / `DO NOT USE FOR:` labels upstream, so their
authored text keeps the prose shape and adds no label — invariant ④ is bidirectional, and inventing a
label would be inventing structure the routing signal does not have.

This batch also makes the pointer census interesting for the first time, and the report says so:

- `test-anti-patterns` points at `exp-test-smell-detection`, which lives in the scope-excluded
  `dotnet-experimental` plugin. Dropping that pointer is allowed (§7.6) and it is **reported** under
  `Dropped by authoring` rather than quietly disappearing — the status tool now names the drop, its
  source and its target.
- Five shipped names are on §14's collision-prone list (`run-tests`, `filter-syntax`,
  `platform-detection`, `coverage-analysis`, `crap-score`), so the shadowing section no longer reads
  "none": it lists them as names another provider could win.

Four tests needed updating, all of them assertions that had encoded the old range's *facts* rather than
its equations: the dangling set, the collision-prone list, `user-invocable: false` skills, and a pointer
drop. Each is now stated as the rule it was testing — "every dropped pointer must be unloadable", "the
collision-prone list is exactly the shipped generic names" — so a range change cannot break them again.

### P1 batch 4: dotnet-maui, dotnet-upgrade, dotnet-template-engine (2026-10-14)

Eighteen skills arrive at once and **all eighteen needed authoring**, the largest single authoring step of
the rollout: the snapshot is now **9 plugins / 65 skills across 200 files**, and 53 authored entries cover
every in-range skill the coverage rule touches — the first point at which the gate reports zero gaps for
the whole shipped range.

Three of the eighteen keep a prose shape because upstream gives them no labels (`dotnet-maui-doctor`,
`maui-shell-navigation`, `maui-theming`): they say `Use when:` and `Do not use for:` in their own words,
and the authored text does too. Invariant ④ is symmetric, so adding a label they never had would be
inventing structure rather than preserving it.

The authoring helper that assembles these texts from clause lists learned the same distinction the hard
way: it treated every clause after the first as droppable, which silently dropped a required pointer from
a prose entry. Pointer clauses are now mandatory in both shapes, recognised by the `(use …)` form upstream
writes them in, and an over-long mandatory set is a rejection rather than a quiet truncation.

### P1 batch 5: the full marketplace range (2026-10-14)

The rollout closes. `node tools/sync-snapshot.mjs --ref v1.0.0` — no `--plugins`, no `--allow-partial` —
ships **11 plugins / 68 skills across 205 files**, and the shipped set is now exactly
`.claude-plugin/marketplace.json`, which turns the range check from a deliberate warning back into a hard
one. `dotnet-aspnet` and `dotnet-data` needed no authoring, so the 53 entries written in batches 1–4
already cover every in-range skill the coverage rule touches.

The two numbers the design predicted and the implementation now reproduces:

- **32 distinct in-range pointer targets** — spec §2.8's census exactly.
- **1 dangling target**, `exp-test-smell-detection ← dotnet-test/test-anti-patterns`, which is the
  measured deviation `doc/dev-notes.md` records: the documents said four, because the other three live
  inside descriptions of the excluded `dotnet-experimental` plugin and never enter the authored population.

The default catalog is still the `dotnet` plugin's three skills at 902 characters. A wider range makes
skills *selectable*; choosing them by project signal is `lib/detect.js`, which is the next piece of P1.

### W11: project detection (2026-10-14)

`lib/detect.js` implements §9.2 as a filesystem-only scan of the workspace the host names in
`list({ cwd })`: eleven signal rows, four contract properties — bounded, pure, memoized by mtime
bucket, grow-only within a session — and a `detect` callback wired into the `project-detection`
selector that had been installed and inert since P0.

- **The signal table is written down once.** `SIGNAL_TABLE` is exported and shared by the module, the
  tests and the report, so a row cannot match in code and be missing from the tests. Row one
  (`.csproj` and friends) enables nothing by design — `dotnet` is always in — and `dotnet-nuget` has no
  row at all: its only skill converts a project *to* central package management, and
  `Directory.Packages.props` is evidence against that change. The suite asserts that exception list, so
  a growing marketplace range becomes a failing test instead of a silent dark spot.
- **False positives are the failure mode, not slow scans.** `obj/`, `bin/`, `.git/` and `node_modules/`
  are never descended into: `obj/project.assets.json` lists every transitive package, so reading
  generated output would report `Microsoft.EntityFrameworkCore` for any repository that depends on
  something that depends on EF Core. `.json` is never read as content, and short framework names are
  matched whole-word so that `oppor**tunit**y` cannot select `dotnet-test`.
- **A nested repository is another project.** A directory other than the root that carries its own
  `.git` is a submodule or a vendored checkout, and its build files are evidence about *it*, not about
  the workspace the session was opened in. This rule came from the first live measurement (below).
- **A workspace cannot lose a plugin it once matched** (§6.2, hard rule two): the memo keeps the plugin
  set per workspace and unions each new scan into it, reporting anything retained that way. The
  evidence, unlike the plugin set, always describes the tree as it is now.
- **§11.4 item 1 gained the line it was missing.** The report prints the last detection with its
  numbers — workspace, matched plugins, files and directories scanned, signals that fired, truncation
  and retention — because "no workspace was named", "the workspace could not be read" and "scanned and
  matched nothing" all leave the same catalog behind.
- **`dotnet_skills_status` accepts an optional `cwd`.** Detection is a property of a workspace, and this
  is the only way to ask about one that is not the current session's; with no argument the session's own
  workspace (`exec.agent.session.header.cwd`, the value the host passes to `list()`) is the answer, and
  with neither, nothing is scanned and the report says so. This is what makes M10 measurable over a set
  of repositories rather than one.

188 tests pass in a single process. `descriptions verify` and `version.mjs` stay at exit 0: no authored
text, snapshot byte or `SKILL.md` changed in this step.

Live measurements from the restart preceding this step, recorded because they close the range rollout:
the shipped range reads **11 plugins / 68 skills** with no out-of-range note, the default catalog is
unchanged at 3 entries / **902 characters** / 16 estimated tokens, and `dotnet_skills_status` — absent
from the model's declaration set by design — answered a call by name, which is issue 0001's resolution
holding in a live session.

### W11, live: M10's first measurement, and the rule it changed (2026-10-14)

The restart after W11 landed ran detection over this plugin's own repository for real, and that is the
most useful thing the feature has done so far. The wiring was correct — the host passes the session
workspace, the bounds hold, the new §1 line renders — and the *answer* was wrong in an instructive way:
`dotnet-ai+dotnet-aspnet+dotnet-data+dotnet-diag+dotnet-msbuild+dotnet-test`, 49 catalog entries and
16,390 characters (298 estimated tokens) for a JavaScript repository, from a scan of 1457 files and 667
directories.

Every root cause was visible in one call — which is what §11.4 item 1 was added for — and all of it came
from one directory: `submodule/dotnet-skills/**`, the pinned upstream checkout, which is a real .NET
solution with a validator project, about forty skill test fixtures, an ASP.NET sample, an EF Core sample
and four `tombstone_*.txt` samples. The scan was right about the files and wrong about the project.

The fix is one rule: a directory other than the root that carries its own `.git` is a nested repository,
and a nested repository is never descended into. Two tests hold it — one that a nested repository's
fixtures contribute nothing while the root's own test project still selects `dotnet-test`, and one that a
workspace which *is* itself a repository is still scanned. After the fix the same workspace reports no
plugins from 347 files and 155 directories, and the catalog returns to the three core skills.

For §2.3's "which signals are noise": the noise here was scan scope rather than a signal row, but the
measurement points at two rows to re-examine once M10 runs over real repositories — `aspnet` through a
top-level `app.MapGet`, since any sample or tutorial in a repository contains one, and `diag` through a
symbolicated stack in any `.txt` or `.log`, since a crash report filed in the repository is not a
diagnostic workload. `doc/dev-notes.md` records the numbers.

### W12: the deployment pipeline (2026-10-14)

The second content entry point of §10 exists: `lib/platform/{index,win32,linux,macos}.js`,
`lib/deploy/{index,manifest}.js` and `tools/deploy.mjs`. A deployment materializes the same selection a
session would see — core set, configuration baseline, and detection for `--cwd` — into the platform's
conventional root (`$DSH_HOME/skills` or `~/.dsh/skills`), or the whole range with `--all`.

- **Symlink first, probed rather than assumed.** A real link is created inside the target directory and
  deleted again; `EPERM` / `ENOSYS` / `UNKNOWN` degrade the whole batch to copies, and any other error is
  reported instead of degraded. Deployment is deliberately not on the provider's data path — the catalog
  always reads the snapshot — because a copy that can go stale is the failure this design refuses to have
  in the catalog.
- **A copy is reclaimed precisely.** Every file the deployment wrote is recorded in a manifest, and only
  those paths are ever removed, so a user's file in the deploy root — or inside a copied skill directory
  — survives a re-deployment. An unreadable manifest stops the deployment rather than emptying the root.
- **Degradation is loud in both channels §10.3 asks for**: the log, and §6 of `dotnet_skills_status`,
  which now reports the mode, the root, how many skills are deployed, the degradation reason, and any
  dangling entry.
- **Platform decisions live in `lib/platform/` only.** `tools/session-audit.mjs` was migrated onto the
  adapter's path folding, which removed the last `process.platform` outside that directory; a test scans
  `lib/**` and `tools/**` in both directions — no `process.platform`, and no platform-literal comparison.
  `macos.js` throws `macOS adapter not implemented` from every entry point that decides where to write.

Measured on this machine, which is configured by group policy (Developer Mode is off) to allow symlinks
for all accounts: an unsandboxed deployment produced three real directory links, `SKILL.md` read
byte-identical through them, a snapshot edit was visible without re-deploying, and a re-run reclaimed
nothing. The same directory inside the Harness file sandbox returns `EPERM` and degrades to copies — the
restricted token loses the privilege the account has, which is exactly the case the fallback exists for,
since Windows grants symlink creation to administrators by default and to other accounts only through
Developer Mode or that policy. WSL is not measured: `wsl.exe` denies access from this session.

Two defects were found only because the suite was run once outside the sandbox: a re-deployment tried to
re-create existing links (`EEXIST`, because Windows reads a link back as `\\?\C:\…`), and a collision
deleted a user's directory to make room for a skill of the same name. The second is now a rule no code
path may break: a path this plugin did not write is never deleted — copy mode merges into it, symlink
mode skips that skill and says so, and the manifest records what was deployed rather than what was
wanted.

210 tests, 0 failures, 0 skipped outside the sandbox; 6 skip inside it, each with the measured error code
as its reason. `descriptions verify` and `version.mjs` stay at exit 0.

Not yet in this version: usage analytics (P2), and the release workflow (W13).
