# `dsh-dotnet-skills` 规格说明

| 项 | 值 |
|---|---|
| 代号 | `dsh-dotnet-skills` |
| 宿主 | DeepSeek Harness（Cordis 插件体系） |
| 上游基线 | [`dotnet/skills`](https://github.com/dotnet/skills) tag `v1.0.0` = commit `cb7c10bd32b250459632df9e6fa1350cdaf00b18`，MIT |
| 阶段 | A 阶段（Skill 桥接），预留 B/C 扩张位 |
| 平台 | 核心逻辑跨平台；部署管线按平台各管各的。v1 只交付 Windows + Linux，macOS 仅留接口 |
| 语言范围 | 仅 C# |
| 版本 | 独立语义化版本线，初始 `0.1.0` |
| 状态 | 定稿，可实现 |

---

## 1. 范围与目标

### 1.1 目标

把 `.NET Agent Skills` 接入 DSH 会话，使模型能按需装载 .NET 团队的精选技能，并在 DSH 中达到与 Microsoft 本家 Copilot 集成相当的 .NET 开发辅助能力。

### 1.2 三件必须由插件解决的事

**其一：发现深度不匹配。**
DSH 的文件系统 skill provider 只扫一层：`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`，嵌套的 `**/SKILL.md` 明确不被发现。上游技能位于 `plugins/<plugin>/skills/<skill>/SKILL.md`，是第四层。直接指向仓库或某个 `skills/` 目录，一个技能都找不到。

**其二：目录规模与上下文预算冲突。**
入库 68 个技能，描述原文合计 45,428 字符。全量注入是一笔每个会话都要付的固定 token 成本。

**其三：描述形态与下游上限冲突。**
68 条里 53 条（77.9%）超过下游 500 字符上限或携带 `INVOKES:` 噪音。照搬会被下游硬截断，正好切掉 `DO NOT USE FOR:` 整段，并在词中间断开。

### 1.3 交付物

自定义 `ctx.skills` provider、可注入的技能选择中间件、描述授权层（§7）、用量观测（§12）、各平台自有部署管线（§10）。上游内容本身只作为**被索引的数据**存在。

### 1.4 非目标

| 非目标 | 理由 |
|---|---|
| F# 支持 | 上游无 F# 内容：路径命中 `.fs`/`.fsproj`/`.fsx`/`.fsi`/`fsharp` 共 0 处，`F#` 字面量仅 4 处且全部是枚举语言列表时的顺带提及。这是**内容层**缺口，不是集成层缺口，无法用配置弥补 |
| MCP 接入 | v1.0.0 没有任何 `mcpServers` |
| macOS 支持 | 无真机验证条件。仅保留适配点接口（§10.4），必须有真机验证才发布 |
| Blazor / WinForms / `dotnet11` | v1.0.0 无对应 plugin，无内容可启用 |
| 按 plugin 分组的专用浏览 UI | A 阶段只有 Plugin Manager 卡片与状态工具（§11.4） |
| 运行时联网更新快照 | 快照更新只在开发端（§3.2） |

### 1.5 语言范围

**仅 C#，且这是唯一的语言范围。** 12 个 plugin、76 个技能全部是 C# 语境：`csharp-scripts`、`dotnet-pinvoke`、`msbuild-modernization`，连 `dotnet-template-engine` 的 4 个技能也只用 C# 模板。

因此本插件的技能目录里不会有 F# 技能可路由。「支持 F# 开发」在当前上游内容下只能靠 C# 技能外溢（MSBuild、NuGet、测试这些确实语言无关），本项目不为它做任何设计：

- 探测信号表里不设 `*.fsproj` / `*.fsx` 之类的 F# 信号——没有内容可启用，加了只是噪声；
- 若上游将来补齐 F#，本插件按数据驱动自动受益：新增 plugin 目录入快照即可，无需改设计。

---

## 2. 上游基线

### 2.1 溯源

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/dotnet/skills` |
| 基线 | tag `v1.0.0` = commit `cb7c10bd32b250459632df9e6fa1350cdaf00b18` |
| 许可 | MIT（`vendor/upstream/LICENSE` 保留） |
| 全库规模 | 12 plugin / 76 技能 |
| **入库集合** | **11 plugin / 68 技能** |

基线永远是 **tag，不是分支**。理由见 §3.2 与 §3.5。

### 2.2 入库集合的界定

**入库集合 = `.claude-plugin/marketplace.json` 列出的 plugin。** 该文件列出 11 个 plugin，构成本项目对「上游官方推荐集」的权威引用；`.cursor-plugin/marketplace.json` 列出同样 11 个，构成第二条独立证据。

| 排除项 | 数量 | 理由 |
|---|---|---|
| `dotnet-experimental` | 8 技能 | 未列入上述两个 marketplace 文件；技能全部是 `exp-` 前缀的评估内容。想尝鲜的用户需自行 fork 或等后续 |
| `.agents/skills/` | 3 技能 | 内容是「怎么写技能」（`create-custom-agent`、`create-skill`、`create-skill-test`），不是「怎么写 .NET」 |

### 2.3 逐 plugin 规模与描述成本

| plugin | 技能数 | 描述原文合计字符 | 其中 >500 |
|---|---|---|---|
| `dotnet-test` | 17 | 12,195 | 12 |
| `dotnet-msbuild` | 14 | 10,385 | 12 |
| `dotnet-maui` | 8 | 5,817 | 8 |
| `dotnet-upgrade` | 6 | 4,344 | 5 |
| `dotnet-diag` | 7 | 3,760 | 3 |
| `dotnet-ai` | 5 | 3,535 | 5 |
| `dotnet-template-engine` | 4 | 2,810 | 4 |
| `dotnet` | 3 | 1,173 | 1 |
| `dotnet-nuget` | 1 | 850 | 1 |
| `dotnet-aspnet` | 2 | 309 | 0 |
| `dotnet-data` | 1 | 250 | 0 |
| **合计** | **68** | **45,428** | **51** |

### 2.4 描述长度分布

折叠块标量后的统计：

| 指标 | 值 |
|---|---|
| 合计 | 45,428 字符 |
| 平均 | 668.1 字符 |
| 中位 | 685 |
| p90 | 960 |
| 最短 | 55（`dotnet-aspnet/minimal-api-file-upload`） |
| 最长 | 1,022（`dotnet-test/migrate-mstest-v3-to-v4`） |
| ≤320 | 8 条 |
| 321–500 | 9 条 |
| **>500** | **51 条** |
| 含 `USE FOR:` | 50 条 |
| 含 `DO NOT USE FOR:` | 50 条 |
| 含 `INVOKES:` | 13 条 |

**两个标签是绑定的：50 条同时含 `USE FOR:` 与 `DO NOT USE FOR:`，另 18 条两个都没有。** 不存在只有其一的情况。这直接决定 §7.5 的不变量 ④⑤ 写法。

覆盖集 53 条里 47 条带这两个标签；**另 6 条两个都没有**，它们的路由信号以散文形式存在：

| plugin/skill | 字符数 |
|---|---|
| `dotnet-test/test-anti-patterns` | 986 |
| `dotnet-ai/technology-selection` | 892 |
| `dotnet-diag/apple-crash-symbolication` | 873 |
| `dotnet-test/writing-mstest-tests` | 787 |
| `dotnet-diag/android-tombstone-symbolication` | 754 |
| `dotnet-diag/microbenchmarking` | 665 |

长度前 8 名：

| plugin/skill | 字符数 |
|---|---|
| `dotnet-test/migrate-mstest-v3-to-v4` | 1,022 |
| `dotnet-upgrade/migrate-dotnet9-to-dotnet10` | 1,017 |
| `dotnet-test/migrate-static-to-wrapper` | 1,006 |
| `dotnet-test/migrate-mstest-v1v2-to-v3` | 1,005 |
| `dotnet-test/test-anti-patterns` | 986 |
| `dotnet-test/run-tests` | 970 |
| `dotnet-test/coverage-analysis` | 960 |
| `dotnet-msbuild/directory-build-organization` | 930 |

### 2.5 frontmatter 形态

上游 frontmatter 只使用 **3 个键**：

| 键 | 使用文件数 |
|---|---|
| `name` | 76 |
| `description` | 76 |
| `user-invocable` | 4（值均为 `false`） |

**没有** `license`、`metadata:`、`disable-model-invocation`、`whenToUse`。

`user-invocable: false` 的入库技能有 3 个：`dotnet-test/dotnet-test-frameworks`、`dotnet-test/filter-syntax`、`dotnet-test/platform-detection`（另有 1 个在已排除的 `dotnet-experimental`）。

**该键的语义是「人类可召唤性」，与模型可否路由无关。** 映射规则见 §6.4，这是本项目最容易映射错的一处。

### 2.6 description 标量形态：三种都真实存在

68 个入库技能的 `description` 标量形态：

| 形态 | 个数 | 占比 |
|---|---|---|
| 折叠块标量 `description: >` / `>-` | **40** | 58.8% |
| 双引号单行标量 `description: "..."` | **21** | 30.9% |
| 裸 plain 标量 `description: ...` | **7** | 10.3% |

`>` 31 个、`>-` 9 个；无 `|` / `|-`；无双引号以外的引号形式。

三个结论：

1. **块标量是首要形态**，解析器必须实现折叠，见 §5.1。
2. **引号剥除影响 21 条的长度**（每条差 2 个字符）。`sourceSha256` 必须按剥除引号后的文本计算，否则这 21 条的校验会全部失败。
3. 裸 plain 的 7 条是 `csharp-scripts`、`configuring-opentelemetry-dotnet`、`minimal-api-file-upload`、`optimizing-ef-core-queries`、`android-tombstone-symbolication`、`apple-crash-symbolication`、`dotnet-trace-collect`。

### 2.7 技能资源子目录

技能不是纯文档。68 个入库技能的资源子目录有三形态：

| 子目录 | 技能数 | 说明 |
|---|---|---|
| `references/` | 30 | 正文按相对路径引用 |
| `scripts/` | 4 | 5 个文件，**全部是 PowerShell** |
| `extensions/` | 1 | `dotnet-test/skills/code-testing-agent/extensions/dotnet.md`，全库唯一 |

`scripts/` 的 5 个文件：

```
plugins/dotnet-diag/skills/android-tombstone-symbolication/scripts/Symbolicate-Tombstone.ps1
plugins/dotnet-diag/skills/apple-crash-symbolication/scripts/Symbolicate-Crash.ps1
plugins/dotnet-test/skills/coverage-analysis/scripts/Compute-CrapScores.ps1
plugins/dotnet-test/skills/coverage-analysis/scripts/Extract-MethodCoverage.ps1
plugins/dotnet-upgrade/skills/migrate-nullable-references/scripts/Get-NullableReadiness.ps1
```

PowerShell 依赖与「Linux 也要支持」直接冲突，处理见 §11.4 与 §12 风险表。

### 2.8 技能间引用形态（指针普查）

技能靠名字互相连接，这是「不得重命名」的根据。指针有**两种书写形态**：

| 形态 | 例子 |
|---|---|
| 括号形态 | `(use binlog-generation)`、`(use run-tests for all of these)`、`(use migrate-mstest-v1v2-to-v3 first)`、`(use template-discovery and template-instantiation)` |
| `instead` 形态 | `use test-anti-patterns instead`、`— use binlog-failure-analysis instead` |

**`→ use X instead` 这种箭头写法实测 0 处。** `→`（U+2192）只在 2 条描述里出现，都与技能指针无关：`dotnet-msbuild/directory-build-organization` 用它表示 MSBuild 求值顺序，`dotnet-msbuild/msbuild-antipatterns` 用在 `BAD→GOOD` 里。

**注意两种形态都有带尾词的变体**（`for all of these`、`first`、`after baselining`、`and <另一个技能>`），按「名字后面必须紧跟 `)`」的紧正则抽取会漏掉真指针。抽取与判定规则见 §7.6。

普查结果（对 68 个入库技能的上游 description）：

| 项 | 值 |
|---|---|
| 指针指向的**入库**技能（`P ∩ V`） | **32 个不同技能** |
| 指针指向的**已排除**技能（`P \ V`） | **4 个**：`exp-assertion-quality`、`exp-mock-usage-analysis`、`exp-test-maintainability`、`exp-test-smell-detection` |
| 入库技能中**从未被任何指针指向**的 | 36 个（68 − 32） |
| 单技能被指向最多 | 5 次（`writing-mstest-tests`、`build-perf-diagnostics`、`test-anti-patterns`） |

被指向最密的几个技能：`writing-mstest-tests`(5)、`build-perf-diagnostics`(5)、`test-anti-patterns`(5)、`incremental-build`(3)、`maui-shell-navigation`(3)、`mcp-csharp-debug`(3)、`template-discovery`(3)。

**`P \ V` 的 4 个目标全部来自已排除的 `dotnet-experimental`。** 这是「排除该 plugin」在路由层的可见后果：有 4 个目标指向目录里不存在的名字。处理规则见 §7.6。

指针出现在哪个段落都算，**包括 `DO NOT USE FOR:` 段内**——那里常有定向改指（如 `analyzing an existing binlog (use binlog-failure-analysis instead)`）。授权时必须一并保住。

### 2.9 `plugin.json` 形态

| 字段 | 出现范围 |
|---|---|
| `name` / `version` / `description` / `skills` | 全部 12 个 plugin |
| `agents` | `dotnet-diag`、`dotnet-msbuild`、`dotnet-template-engine`、`dotnet-test` |
| `lspServers` | **仅 `dotnet`** |

**没有任何 `mcpServers`。**

`plugins/dotnet/plugin.json` 原文：

```json
{
  "name": "dotnet",
  "version": "0.1.0",
  "description": "Common everyday C#/.NET coding skills. Expected to be useful to all .NET developers.",
  "skills": ["./skills/"],
  "lspServers": "./lsp.json"
}
```

`plugins/dotnet/lsp.json` 是全库唯一的 LSP 声明：

```json
{
  "lspServers": {
    "csharp": {
      "command": "dotnet",
      "args": ["dnx", "roslyn-language-server", "--yes", "--prerelease", "--", "--stdio", "--autoLoadProjects"],
      "fileExtensions": { ".cs": "csharp" }
    }
  }
}
```

这条命令与沙箱写入限制同构：`dnx` + 首次联网下载 + 在 `~/.nuget` 落盘。它归属 C 阶段的**前置验证项**（见 §12 风险表），A/B 阶段不构成阻断。

### 2.10 上游没有可用的版本工具

| 项 | 状态 |
|---|---|
| 12 个 plugin 的 `plugin.json.version` | **全部 `0.1.0`** |
| `version.json`（NVG release base） | 不存在 |
| `eng/version/` | 不存在 |
| `version-bump-command.yml` | 不存在 |
| `weekly-version-sync.yml` | 不存在 |

含义有二：

1. **不能从上游客 plugin 的版本号推出「我们锁到了哪个上游版本」。** v1.0.0 的 `0.1.0` 是个常量，没有信息量。
2. 溯源锚点只能是 **git tag + commit**。`UPSTREAM.json` 里各 plugin 的 `version` 照录，但**只作记录，不作判断依据**。

### 2.11 快照体积

| 范围 | 文件数 | 字节 | MiB |
|---|---|---|---|
| `plugins/**` | 214 | 1,497,474 | 1.43 |
| 全库（不含 `.git`） | 1,707 | 12,189,560 | 11.62 |

这个体积使「如实落盘快照」的成本几乎可以忽略，也使符号链接的**省空间**理由不成立。符号链接的真实理由见 §10.3。

---

## 3. 溯源与版本

### 3.1 `vendor/UPSTREAM.json` —— 唯一事实源

```json
{
  "repo": "https://github.com/dotnet/skills",
  "tag": "v1.0.0",
  "commit": "cb7c10bd32b250459632df9e6fa1350cdaf00b18",
  "fetchedAt": "<ISO 8601>",
  "includedPlugins": [
    { "name": "dotnet", "version": "0.1.0", "skillCount": 3,
      "skills": ["csharp-scripts", "dotnet-pinvoke", "nuget-trusted-publishing"] },
    { "name": "dotnet-ai", "version": "0.1.0", "skillCount": 5, "skills": ["..."] }
  ],
  "excludedPlugins": [
    { "name": "dotnet-experimental", "reason": "marketplace.json 未列出",
      "skills": ["exp-assertion-quality", "exp-dotnet-test-frameworks", "exp-mock-usage-analysis",
                 "exp-simd-vectorization", "exp-test-gap-analysis", "exp-test-maintainability",
                 "exp-test-smell-detection", "exp-test-tagging"] }
  ],
  "upstreamInventory": { "pluginCount": 12, "skillCount": 76, "skills": ["...全部 76 个技能名..."] },
  "skillCount": 68,
  "snapshotSha256": "<hex>"
}
```

| 字段 | 用途 |
|---|---|
| `includedPlugins[].version` | **只作记录，不作判断依据**（§2.10）。v1.0.0 下全部是常量 `0.1.0` |
| `includedPlugins[].skills` | 入库技能名（`V`），供 §7.6 的指针查表 |
| `excludedPlugins[].skills` | 排除技能名，与 `V` 合起来构成名字全集 `U`（76），供 §7.6 区分「真指针」与「英文散文」 |
| `upstreamInventory` | **该 ref 的完整技能清单**，无论本轮入库了多少 plugin 都完整写出。作用：让 §7.6 的 `U` 在 P0（只入库 `dotnet`）与 P1（入库 11 个）两个阶段都不依赖 submodule 检出即可获得 |
| `snapshotSha256` | 覆盖 `vendor/upstream/**` 的规范化清单（`路径 + 内容哈希`，按路径排序后取哈希）。用途：检测快照被带外修改、供 `dotnet_skills_status` 报出、供测试断言 |

### 3.2 同步规则

- `tools/sync-snapshot.mjs` **必须**接受一个 tag 或 commit 参数；**未指定 ref 时拒绝执行**，不得默认取 `main`。默认值由 `UPSTREAM.json` 的 `tag` 字段承载，**不写死在代码里**。
- 同步**只在开发端**进行（人手动触发）。插件的运行时完全离线、完全确定：它只读 `vendor/upstream/**`，不知道也不需要知道上游是否存在。好处是内核可以是纯函数式的，没有网络与时钟依赖。
- 每次同步都产出可核查溯源：`tag`、`commit`、`fetchedAt`、各 plugin `version`、技能总数、`snapshotSha256`、以及**完整的 `upstreamInventory`**。
- 入库范围由 `--plugins <list>` 控制（P0 为 `dotnet`，P1 起为 marketplace 的 11 个），但**清单总是完整的 76 个技能名**——见 §3.1 的 `upstreamInventory`。
- 同步流程：

```
1. tools/sync-snapshot.mjs --ref v1.0.0 [--plugins dotnet]   ← ref 必须显式，不许留空
2. 从该 ref 逐字节复制所选 plugins/** 到 vendor/upstream/
3. 校验：技能名文法、description 非空、行尾为 LF、快照内技能名全局唯一
4. 写 vendor/UPSTREAM.json（含 includedPlugins[].skills、excludedPlugins[].skills、
   upstreamInventory 的完整 76 名清单、snapshotSha256）
5. tools/descriptions.mjs verify            ← 覆盖与漂移校验，不过即中止（§7.7）
6. tools/version.mjs                         ← UPSTREAM.json ↔ CHANGELOG 对帐
7. 提交 → PR → 发布
```

**客户端唯一知道的版本信息**是 `UPSTREAM.json` 里的 `tag` / `commit` / `fetchedAt`，由 `dotnet_skills_status` 报出来。快照年龄因此是一个数字，不是一次网络请求。

### 3.3 版本号：独立语义化线

- 插件走自己的语义化版本线，**不受上游影响，也不挂后缀**。初始版本 `0.1.0`。
- 对应关系记进 `CHANGELOG.md`：每条 release 显式写出绑定的上游 **tag + commit + skillCount**。
- `tools/version.mjs` 职责 = **审计校验**（不算版本号）：校验 `UPSTREAM.json` 与 CHANGELOG 的对应段是否一致，防止有人只改了快照忘了记帐。
- `package.json.version` 由 release-please 写，CI 里加校验，**不许手改**。

### 3.4 版本自动化

release-please 只允许出现在两个地方——`.github/workflows/release.yml` 与 `.release-please-manifest.json`。核心逻辑一律不依赖它；若日后换成 changesets，改动面就是这两个文件。

- 目标线：`origin/main`（GitHub Actions）。
- release PR 描述里注入一段由 `UPSTREAM.json` 生成的区块，人工审查时看这一段就是在审「我们锁到了哪个上游版本」：

```
Upstream: dotnet/skills v1.0.0 (cb7c10bd), 11 plugins / 68 skills
```

### 3.5 升级上游 tag 是一个显式决策

不是后台行为。换 tag → 重跑同步 → 看 diff → 走一次 release。

理由：v1.0.0 的 `dotnet` plugin 只有 3 个专门场景技能，而上游 `main` 上它是 4 个含 `csharp-expert` 的通用技能，用户感知到的能力差异极大。**若默认核心集在 v1.0.0 与 main 之间摇摆，等于给用户一个不确定的产品。** 锁 tag 让「我们交付了什么」变成可复现的事实。

升级时 `tools/descriptions.mjs verify` 必须重新通过（§7.7）。

---

## 4. 内容源抽象

`SkillContentSource` 是插件的扩张缝。插件的其余部分只依赖这个接口，不依赖「快照」这个事实：

```js
/**
 * 提供某 plugin 的 manifest 与技能清单。实现可以是内置快照、本地 git 检出，
 * 或未来的 npm/NuGet 分发包；上层选择中间件与 provider 对此无感。
 */
// resolve(pluginId) -> { manifest, skills: [{ name, dir, frontmatter, bodyPath }] } | undefined
// listPlugins()      -> [{ id, version, description, skillCount }]
```

内置快照是 v1 的唯一实现。**这不是投机抽象**——它同时服务三件已确定的事：

1. 快照更新流程的可测试性；
2. 未来 live checkout 的可选性（B/C 阶段）；
3. 单元测试里注入假数据源的能力。

---

## 5. frontmatter 解析与文本规范化

### 5.1 受限语法

解析器只支持实测存在的形态，**不做通用 YAML**：

| 形态 | 必需性 | 68 条中的实际用法 |
|---|---|---|
| `key: value`（裸 plain 标量） | 必需 | 7 条 |
| `key: "value"`（双引号，**剥除引号**） | 必需 | 21 条 |
| `key: 'value'`（单引号，**剥除引号**） | 支持即可 | 0 条 |
| `key: >` + 缩进续行（折叠） | **必需** | 31 条 |
| `key: >-` + 缩进续行（折叠 + 去尾换行） | **必需** | 9 条 |
| `key: \|` / `key: \|-` | 不需要（实测 0 条）；遇到即报错 |
| 嵌套映射、序列、锚点、多文档 | 不需要；遇到即报错 |

**折叠规则**：续行按 `trim` 后以单个空格连接；块内空行产出单个 `\n`；`>-` 去掉尾部换行。

**引号剥除是必须的，且只剥最外层一对。** 21 条使用双引号，每条的长度因此差 2 个字符。`sourceSha256` 一律按**剥除引号 → 折叠 → `replace(/\s+/g,' ').trim()`** 之后的文本计算（§7.3）。实现若漏了剥引号，这 21 条的校验会全部失败——这是本项目最容易踩的一处实现偏差。

由于目录文本在比较前统一做 `replace(/\s+/g, ' ').trim()`（§7.9），折叠产生的换行差异**不可观测**。因此实现可以保留上面这条简单规则，不必实现 YAML 的完整折叠语义。

### 5.2 未知键

未知 frontmatter 键**不做解释**，原样存入 `metadata.upstreamFrontmatter`（对象，值保持字符串原文）。这样上游加键时不会静默丢失信息，也不会因解析失败导致技能消失。

### 5.3 行尾

| 环节 | 规则 |
|---|---|
| 仓库 | `.gitattributes` 声明 `vendor/** -text`，防止 CRLF 污染快照 |
| 同步 | 校验行尾：发现 `\r\n` **报错**，不静默修复 |
| 运行时 | 读取时容忍 `\r\n`（规范化后再解析 frontmatter），但**永不改写文件** |

理由：快照走 symlink 部署时，被检出的文件内容就是运行时读到的东西，CRLF 污染会直接进模型的上下文。

### 5.4 必需键校验

| 键 | 校验 |
|---|---|
| `name` | 必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` |
| `description` | 必须非空字符串 |

两者缺失或非法 → 该技能**不进目录**，并记入 `dotnet_skills_status` 的诊断列表。这样「技能消失」与「技能非法」是可区分的。

---

## 6. provider 契约

### 6.1 注册

| 项 | 取值 |
|---|---|
| `provider.name` | `dotnet-agent-skills`（非保留名 `runtime`） |
| `rank` | **700**，可配置 |
| `source` | `'bundled'`（快照随包发布，语义准确） |
| 注册方式 | `ctx.skills.registerProvider(control => provider)`，在 `apply` 内**同步**调用 |
| 失效 | `control.invalidate()`；**无 TTL**；definition **永不缓存** |

**`rank = 700` 的理由**：用户自己的 `~/.dsh/skills`(400) 与 `~/.agents/skills`(500) 应能**无配置**覆盖我们；宿主的 bundled(600) 也应优先于我们。

层级与重名裁决（宿主行为，供调试参照）：

- 同一层内：先按 `rank` 升序，再按 provider 注册顺序，最后按 provider 内顺序；**rank 小者胜**。后落败者会被记录一条警告并被隐藏。
- 跨层：**近层直接胜**。
- 宿主**没有 API** 能列出「被遮蔽的全部定义」。因此遮蔽情况必须由状态工具报出（§11.4）。

### 6.2 `list()`

```
list({ cwd, signal }) -> SkillProviderObservation | SkillCandidate[]
```

返回 `SkillProviderObservation { candidates, complete }`。

**硬规则一：绝不吐出可能校验失败的候选。**

宿主把候选校验放在 `list()` 的 try/catch **之外**。返回一个非法候选，异常会穿出宿主的分层收集逻辑，导致**整层目录读取失败**——不是「跳过本 provider」，而是所有 provider 的目录一起崩。因此：

1. provider 在返回前对每个候选做**完整自校验**：名字文法、`description` 非空字符串、`invocation` 两个布尔、`source`/`provider` 字符串、`rank` 有限数、`path` 为字符串或缺失；`provider` 必须等于 `dotnet-agent-skills`。
2. **任何内部异常一律不向外抛**：文件读不到、快照缺失、frontmatter 解析失败、授权数据损坏，全部降级为 `complete: false`，并在候选集里保留能构建的部分。
3. `complete: false` 让宿主保留上一份 good catalog，而不是误判为「全删了」。

**硬规则二：会话内只增不减。**

目录变更会让 `dsh-tool-skill` 追加一份**完整替换目录**，打断 KV cache。选择结果在会话内只允许单调增长。

**硬规则三：探测只增不减。**

`cwd` 是项目探测的天然挂点，但探测结果只允许**增加**候选；探测失败等同于无信号。

### 6.3 candidate 逐字段

| 字段 | 取值 |
|---|---|
| `name` | 上游技能目录名，**永不重命名** |
| `description` | §7 的授权文本或上游原文，已规范化且不超过有效上限 |
| `whenToUse` | 上游不使用此键，v1 **恒不设置** |
| `invocation` | §6.4 |
| `source` | `'bundled'` |
| `provider` | `'dotnet-agent-skills'`，必须与 `provider.name` 完全一致 |
| `rank` | `Config.rank`，默认 `700` |
| `path` | `<skillDir>/SKILL.md` 的**绝对路径** |
| `resourceBase` | `{ kind: 'directory', path: <skillDir> }` |
| `locator` | provider 自用：`{ plugin, skill, skillDir, bodyPath }` |
| `metadata` | 见下 |

`metadata` 结构：

| 键 | 内容 |
|---|---|
| `plugin` | 所属 plugin 名 |
| `upstreamDescription` | 折叠并规范化后的完整上游 description |
| `upstreamDescriptionChars` | 上者长度 |
| `upstreamInvokes` | `INVOKES:` 段原文（若存在） |
| `upstreamFrontmatter` | 未知 frontmatter 键的原文（§5.2） |
| `descriptionSource` | `'authored'` / `'verbatim'` / `'capped'` |

**`path` 与 `resourceBase` 都不是可选项：**

- `path` 是侧栏 `SKILL.md` 预览的**唯一依据**（无 `path` 的技能「可调用但无预览」）；
- `resourceBase` 为目录形态时，`skill` 工具结果会输出 `Base directory for this skill: <path>`，模型据此解析正文里的相对引用。68 个入库技能里 30 个有 `references/`、4 个有 `scripts/`、1 个有 `extensions/`——缺了这条，这些技能是残缺的。

### 6.4 invocation 映射

宿主策略是两个**独立**布尔：

```ts
interface SkillInvocationPolicy { modelInvocable: boolean; userInvocable: boolean }
```

| 上游 frontmatter | 映射结果 | 实际效果 |
|---|---|---|
| 无 `user-invocable`（65/68） | `{ modelInvocable: true, userInvocable: true }` | 进模型目录；`/name` 可召唤 |
| `user-invocable: false`（3/68） | `{ modelInvocable: true, userInvocable: false }` | **进模型目录**；`/name` 无候选 |

**这条必须写死。** `user-invocable` 只声明**人类可召唤性**，与模型可否路由无关。把它当成「模型不可调用」来映射，会把 3 个本该出现在目录里的技能误删。

上游 v1.0.0 没有 `disable-model-invocation`，因此 v1 不产生 `modelInvocable: false` 的候选。若上游将来引入该键，映射为 `{ modelInvocable: false, userInvocable: true }`（该技能的**唯一**入口是 `/name`），并需要一次规格修订。

### 6.5 `get()`

- 从 `candidate.locator` 取路径，**每次重读** `SKILL.md`。宿主契约要求 definition 从不被缓存，且正文改动应即时生效。
- 返回 `SkillDefinition`：`content` 为 `SKILL.md` 全文；其余 summary 字段与对应候选一致；`metadata` 相同。
- 返回的 `name` **必须与所选候选一致**：不一致会让宿主失效整份目录缓存，下次重新发现。
- 读不到文件（快照缺失、悬空链接）返回 `undefined`，由宿主报「技能未知或已不可用」。
- **不得**缓存正文，**不得**改写正文。

### 6.6 三条不可协商的内容纪律

1. **不得重命名技能。** 技能图靠名字连接，改名会打断上游精心写好的路由（§2.8）。
2. **不得改写 `SKILL.md` 正文。** 正文用相对路径引用 `references/*.md`、`scripts/*.ps1`、`extensions/*.md`。
3. **不得改写上游快照文件。** `vendor/upstream/**` 必须与上游**逐字节一致**，可被 diff 审阅。本项目对所有文本的改动只允许出现在 `data/descriptions.json`（§7.3）。

---

## 7. 描述授权层

### 7.1 定位

描述文本在 v1 里是**随插件发布的授权数据**，不是运行期算出来的结果。

| 收益 | 说明 |
|---|---|
| 确定性由构造保证 | 不存在「算法可能产出空串或切断指针」这一类 bug 面 |
| 可逐条审阅 | 53 条文本在 PR diff 里可见，路由质量是**读得出来的**，不是从算法行为反推的 |
| 运行期极简 | 一次 Map 查表：零字符串处理、零时钟、零网络 |
| 注入内容受控 | 进入 `<system-reminder>` 信封的文本是经审阅的内容，而不是机械复制的上游文本 |

代价见 §14 风险表（首两条）。

### 7.2 覆盖判据与清单

**覆盖判据**：`折叠并规范化后的长度 > 500` **或** `含 "INVOKES:"`。

| 分类 | 条数 |
|---|---|
| 需授权覆盖 | **53** |
| 原样透传（≤500 且无 `INVOKES:`） | 15 |

53 条中 51 条因超长，另 2 条**纯因 `INVOKES:` 噪音**：

| plugin/skill | 字符数 |
|---|---|
| `dotnet/nuget-trusted-publishing` | 421 |
| `dotnet-upgrade/dotnet-aot-compat` | 491 |

需重写的原文合计 **40,551 字符**。

15 条原样透传清单：

| plugin/skill | 字符数 |
|---|---|
| `dotnet/csharp-scripts` | 214 |
| `dotnet-aspnet/configuring-opentelemetry-dotnet` | 254 |
| `dotnet-aspnet/minimal-api-file-upload` | 55 |
| `dotnet-data/optimizing-ef-core-queries` | 250 |
| `dotnet-diag/analyzing-dotnet-performance` | 287 |
| `dotnet-diag/clr-activation-debugging` | 428 |
| `dotnet-diag/dotnet-trace-collect` | 321 |
| `dotnet-diag/dump-collect` | 432 |
| `dotnet-msbuild/msbuild-server` | 418 |
| `dotnet-msbuild/resolve-project-references` | 491 |
| `dotnet-test/crap-score` | 479 |
| `dotnet-test/dotnet-test-frameworks` | 405 |
| `dotnet-test/filter-syntax` | 312 |
| `dotnet-test/migrate-xunit-to-xunit-v3` | 260 |
| `dotnet-test/platform-detection` | 271 |

### 7.3 文件结构

`data/descriptions.json`（**不在 `vendor/` 下**，`vendor/**` 保持逐字节一致）：

```json
{
  "upstream": { "tag": "v1.0.0", "commit": "cb7c10bd32b250459632df9e6fa1350cdaf00b18" },
  "license": "Derived from dotnet/skills (MIT). See vendor/upstream/LICENSE.",
  "budget": 320,
  "entries": {
    "dotnet/dotnet-pinvoke": {
      "text": "...",
      "sourceChars": 538,
      "sourceSha256": "<hex>",
      "authoredRevision": 1
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| 键 | **`<plugin>/<skill>`**。技能名在同一层内是全局唯一的键，但跨 plugin 的同名技能会让裸技能名产生歧义，复合键无歧义 |
| `upstream` | 授权时依据的上游基线。与 `UPSTREAM.json` 不一致即为漂移（§7.7） |
| `budget` | 授权时的预算。与 `Config.catalogSummaryBudget` 不一致会触发覆盖复核告警 |
| `sourceChars` | 上游 description 折叠规范化后的原始长度 |
| `sourceSha256` | 上者的 SHA-256。用途见 §7.7 |
| `authoredRevision` | 每次重写 +1，便于在 CHANGELOG 与状态工具里追踪 |

### 7.4 授权文本的写作规则

**语言：英文。** 与 15 条透传文本及上游语料一致；目录是模型可见的路由文本，语种混用会改变路由语感。

| 允许 | 禁止 |
|---|---|
| 重组句子、合并重复、删除套话与礼貌语 | **增删任何能力声明**（原文说能做才能说；原文没说不能补） |
| 压缩 `USE FOR:` / `DO NOT USE FOR:` 两段 | 丢弃任何指向**入库**技能的指针 |
| 调整语序使路由信号前置 | 改写技能名、凭空造技能名、引入新指针 |
| 删除 `INVOKES:` 段 | 在目录文本里保留 `INVOKES:` |
| 去掉分段标题（如 `When to Use`） | 出现尖括号 `<` `>`、换行、制表符 |
| 上游两个标签都没有时，保持散文形态并保住其中的路由信号 | **给上游没有标签的条目补上 `USE FOR:` / `DO NOT USE FOR:`** |

### 7.5 授权文本的十项不变量

`tools/descriptions.mjs verify` 机械校验全部十项；provider 加载时复验形式项（①–⑤）。

| # | 不变量 |
|---|---|
| ① | 非空，且 `length <= Config.catalogSummaryBudget`（默认 320） |
| ② | 单行：无 `\n` / `\r` / `\t`；首尾无空白；`text === text.replace(/\s+/g,' ').trim()` |
| ③ | **不含尖括号 `<` `>`**——保护宿主的 `<available_skills>` 信封。这是复制式压缩关不掉的注入面 |
| ④ | 含字面 `USE FOR:` **当且仅当**上游原文含它 |
| ⑤ | 含字面 `DO NOT USE FOR:` **当且仅当**上游原文含它 |
| ⑥ | 不含 `INVOKES:` |
| ⑦ | 指针守恒：上游指针目标中属于入库集合的那部分必须全部出现（§7.6） |
| ⑧ | 覆盖完备：每个落入覆盖判据的入库技能都有条目 |
| ⑨ | 无孤儿：每个条目键都存在于快照**且**属于覆盖集 |
| ⑩ | `upstream.tag` / `upstream.commit` 等于 `UPSTREAM.json` 的对应字段 |

**④⑤ 为何是双向的「当且仅当」。** 上游两个标签严格绑定：50 条同时有，18 条同时没有，不存在只有其一的情况（§2.4）。双向约束同时挡住两类破坏：把上游的 `DO NOT USE FOR:` 段丢掉（缩小适用范围、路由变粗），以及给上游没有标签的条目补一个（凭空造结构，而结构一造就容易顺带造能力声明）。

**6 条无标签条目是本项目唯一无法机械保障路由信号的情形。** 它们（§2.4 列出）的路由信号以散文形式存在，重写时必须保住该信号——这一项**没有机械校验**，只能靠人工审。计划里为此单列了审查项。

### 7.6 指针守恒的精确定义

指针识别分**两步**：宽松抽取（只求不漏），再按名字查表判定（精度来自查表，不来自正则）。

**第一步：抽取候选 token**（作用于折叠并规范化后的上游 description）

```
/\(use ([^)]*)\)/g                 → 取出括号内容，再取其中所有 kebab 候选 token
/(?<![a-z0-9.])([a-z0-9]+(?:-[a-z0-9]+)*) instead\b/g   → instead 之前的那个 token
```

`(?<![a-z0-9.])` 这个前置断言是必需的：没有它会把 `Microsoft.Maui.Controls.Maps`、`PyTorch` 这类点分名字切成半截 token。

**正则必须宽松。** 收紧成「名字后紧跟 `)`」会漏掉真指针，实测存在的带尾词变体至少有：`(use run-tests for all of these)`、`(use migrate-mstest-v1v2-to-v3 first)`、`(use build-perf-diagnostics after baselining)`、`(use migrate-dotnet8-to-dotnet9 first)`、`(use build-perf-baseline first)`。

**第二步：按名字全集分类**

| 集合 | 来源 |
|---|---|
| `U`（名字全集，76） | `UPSTREAM.json` 的 `includedPlugins[].skills` ∪ `excludedPlugins[].skills`；等价于 `upstreamInventory.skills` |
| `V`（入库技能名，68） | `UPSTREAM.json` 的 `includedPlugins[].skills` |

| token 归属 | 判定 | 规则 |
|---|---|---|
| `∈ V` | **真指针** | 必须出现在授权文本里（集合包含，逐个核对） |
| `∈ U \ V` | **悬空指针** | **允许丢弃，但必须上报**：`verify` 输出该清单，`dotnet_skills_status` 列出，测试断言清单与预期一致 |
| `∉ U` | **英文散文，不是指针** | 忽略 |

**为什么必须查表。** 宽松抽取会把普通英文误当指针，实测存在：`(use Grid or StackLayout)`、`(use Grid and StackLayout)`、`(use Python with PyTorch/TensorFlow, then export to ONNX for .NET inference)`、`(use standard xUnit and NSubstitute patterns)`、`(use conditional compilation and partial classes)`、`(use Microsoft.Maui.Controls.Maps)`、`(use .NET MAUI animation APIs)`、`(use migrate-mstest-* skills)`（glob，非名字）、`(use dotnet-msbuild plugin)` 与 `(use crap-score skill)`（名字后带限定词）。这些 token 全部不在 `U` 里，因此查表即可全部分离，无需任何自然语言处理。

注意 `dotnet-msbuild` 是 **plugin 名**而不是技能名，实测不属于 `U`——这正是「按技能名查表」而不是「按 plugin 名查表」的原因。

**指针生效范围**：出现在 description 的任何段落都算，**包括 `DO NOT USE FOR:` 段内**（那里常有定向改指，§2.8）。

**禁止**：授权文本不得引入 `U` 之外的新指针，也不得引入 `P` 中原本没有的 `U` 内指针（§7.4）。

这样「技能指向了一个目录里不存在的名字」是**显式事实**，不是静默缺陷。v1.0.0 的 `U \ V` 恰好是 8 个 `exp-*` 名字，其中 4 个被指针指向：`exp-assertion-quality`、`exp-mock-usage-analysis`、`exp-test-maintainability`、`exp-test-smell-detection`。

### 7.7 上游漂移：同步硬失败

`tools/descriptions.mjs verify` 是**同步流程的必经关卡**（§3.2 第 5 步）。任一条件不满足即**非零退出**，同步中止，直到重新授权：

| 触发条件 | 处理 |
|---|---|
| 某条目的 `sourceSha256` 与当前快照折叠后原文不一致 | 报错并列出该条目，要求重写 |
| 快照新增技能落入覆盖判据却无条目（覆盖缺口） | 报错并列出缺口 |
| 条目键指向的技能已不存在，或不再属于覆盖集（孤儿） | 报错并列出孤儿 |
| `upstream.tag` / `commit` 与 `UPSTREAM.json` 不一致 | 报错 |
| ①–⑦ 任一项不满足 | 报错并逐条列出违规 |

**意图**：上游描述一变，路由正确性就不再被任何数据保证。把它变成**显式摩擦**，而不是静默腐烂。

### 7.8 运行期行为

`Config.descriptionMode`：

| 值 | 行为 |
|---|---|
| `'authored'`（默认） | 覆盖集用授权文本，其余用上游原文 |
| `'verbatim'` | 全部用上游原文。**安全阀**；后果 = 51 条会被下游按 §7.9 截断 |

**加载器永不因配置拒绝。** 若某条授权文本超过有效上限（用户调低了 `catalogDescriptionMaxLength`，或调低了 `catalogSummaryBudget`），做一次确定性兜底截断：

```
cap(text, max) = max >= 3 ? (text.length <= max ? text : text.slice(0, max - 3) + '...')
                          : text.slice(0, 1)
```

| 性质 | 说明 |
|---|---|
| 只在用户把上限压到授权预算之下时生效 | 默认配置下 53 条授权文本全部 ≤320，不触发 |
| **保证永不产出空串** | `max < 3` 时取首字符；`max >= 3` 时公式必然非空 |
| 必须可观测 | 被 `cap()` 截断的条数由 `dotnet_skills_status` 报出并给告警 |

### 7.9 下游截断的精确行为（授权预算的由来）

宿主渲染目录时对 description 做：

```
normalized = value.replaceAll(/\s+/g, " ").trim()
rendered   = normalized.length <= max ? normalized : normalized.slice(0, max - 3) + "..."
```

| 事实 | 含义 |
|---|---|
| `max` = `catalogDescriptionMaxLength`，默认 **500**，最小 3 | 属于 `dsh-tool-skill`，不归我们管，无权假设用户会调大 |
| **省略号占预算** | `max = 500` 时可用正文只有 497 字符 |
| 截断发生在词中间 | 会把 `DO NOT USE FOR:` 整段切掉——这正是超长描述必须覆盖的原因 |
| `\s+` 折叠 | 授权文本必须已经是单行规范化形态（§7.5 ②） |

**授权预算取 320**：

- 为下游默认 500 留 180 字符余量；
- 用户把上限降到 400 时仍不被二次截断；
- 与 15 条透传文本中较长者（491、479）的上游原文不冲突（那些低于 500，由下游直接放行）。

### 7.10 metadata 保留

上游原文永不丢失，全部进 `metadata`（§6.3）：

| 字段 | 内容 |
|---|---|
| `upstreamDescription` | 折叠规范化后的完整上游 description |
| `upstreamDescriptionChars` | 上者长度 |
| `upstreamInvokes` | `INVOKES:` 段原文（若存在）。13 条有此项 |
| `upstreamFrontmatter` | 未知 frontmatter 键原文（§5.2） |
| `descriptionSource` | `'authored'` / `'verbatim'` / `'capped'` |

---

## 8. Skill 选择中间件

### 8.1 契约

```js
// selector: (context) => patch | undefined     返回 undefined 表示弃权
// patch:   { include?: string[], exclude?: string[], priority?: number, reason?: string }
// context: { cwd, signals, config, plugins, current }
```

折叠规则：

| 规则 | 说明 |
|---|---|
| `include` | 求**并集** |
| `exclude` | 在 include 结果上做**减法** |
| `priority` | **仅**用于确定 `reason` 的归属与冲突日志，**不改变集合结果** |
| 顺序 | 整体确定性，**与注册顺序无关** |

`reason` 归属规则：同一技能被多条选择器选中时，`priority` 最大者拥有 `reason`；`priority` 相同则按选择器名的码点序，保证确定性。

### 8.2 依赖注入

以一个 Cordis **service** 暴露挂载点，名为 `dotnetSkills`：

```js
ctx.provide('dotnetSkills', {
  selectors: { register, list, unregister },
  fold,        // 给定 context 折叠出最终技能集合
  version,     // 契约版本，供第三方选择器做兼容判断
})
```

第三方插件通过 `ctx.inject(['dotnetSkills'], ...)` 注册自己的选择器，**无需修改本插件**。这正是「可依赖注入的 skill selection 中间件」的落地方式，也让组织内部的自定义裁剪策略能以独立 bundle 存在。

### 8.3 内置选择器

| 选择器 | 状态 | 行为 |
|---|---|---|
| `config-baseline` | 恒开 | 读取 `Config.enabledPlugins` / `enabledSkills` / `disabledSkills`；构成默认核心集 |
| `core-set` | 预设 | 探测无果时的兜底，`dotnet` 必含 |
| `project-detection` | 预设，默认开 | 见 §9 |
| `budget` | 预设，**默认关** | 目录估算 token 超 `catalogTokenBudget` 时，按优先级从最不相关 plugin 起丢弃；`pinnedSkills` **永不丢** |
| `analytics-lru` | 未实现，占位 | 依据本地用量把长期零激活的技能降级 |

### 8.4 默认核心集

**只含 `dotnet` 一个 plugin，v1.0.0 下是 3 个技能：**

| 技能 | 上游描述字符数 | 授权文本 |
|---|---|---|
| `csharp-scripts` | 214 | 透传 |
| `dotnet-pinvoke` | 538 | 授权 |
| `nuget-trusted-publishing` | 421 | 授权（含 `INVOKES:`） |

描述原文成本 1,173 字符；授权后约 900 字符。`pinnedSkills` 默认 **空**。

三层成本模型：

| 层 | 内容 | 成本 |
|---|---|---|
| **默认核心集** | `dotnet` 的 3 个技能 | 最小固定成本，P0 的全部内容 |
| **探测增补** | 命中即加对应 plugin（MsBuild 项目加 `dotnet-msbuild`，有测试加 `dotnet-test`……） | 按项目实况付费 |
| **显式启用** | 其余 plugin 靠配置开 | 零默认成本 |

### 8.5 一处必须如实记录的落差

v1.0.0 的 `dotnet` plugin 里 3 个技能都是**专门场景**（跑单文件 C# 脚本、P/Invoke 原生互操作、NuGet OIDC 发布），**没有一个是「日常 C# 编码」的收敛入口**。

对日常编码真正有用的是 `dotnet-msbuild`(14) 与 `dotnet-test`(17)——它们覆盖「构建 + 测试」这条日常主线。

两条路线留给 P1 的数据裁决：

| 路线 | 内容 | 技能数 | 描述原文成本 | 授权后估算 |
|---|---|---|---|---|
| **选项一**（忠于最小子集） | 只开 `dotnet`，靠 `project-detection` 拉入 msbuild/test | 3 | 1,173 | 约 900 字符 |
| **选项二**（实用优先） | 默认开 `dotnet` + `dotnet-msbuild` + `dotnet-test` | 34 | 23,753 | 约 10,700 字符（≈2.7k est tokens） |

**P0 只做选项一**（`dotnet` 3 技能），因为最小子集的目录成本数据必须先拿到，才能判断选项二是否付得起。这个选择不阻塞 P0。

「探测全命中时的上界」= 68 个技能，保留在预算测试里（`budget` 选择器的压测场景）：描述原文 45,428 字符，授权后约 20,800 字符（≈5.2k est tokens）。以上估算不含目录每条目的 `` - `<name>`: `` 外壳（68 条约 +1.4k 字符），以 P1 实测的 `catalogChars` 为准。

---

## 9. 项目探测

### 9.1 约束

| 约束 | 说明 |
|---|---|
| 有界 | 最大文件数 `Config.probe.maxFiles`（默认 20000）、最大深度 `Config.probe.maxDepth`（默认 8） |
| 纯函数 | 无副作用、无时钟依赖 |
| 记忆化 | 按 `(cwd, mtime-bucket)` |
| 跨平台 | 不依赖平台路径语义 |
| **只增不减** | 会话内目录变更打断 KV cache（§6.2 硬规则二） |
| 不 shell out | 纯文件系统信号 |

### 9.2 信号表

只映射到 11 个入库 plugin。

| 信号 | 启用 plugin |
|---|---|
| `*.sln` / `*.slnx` / `*.csproj` / `Directory.Build.props` / `Directory.Packages.props` / `global.json` / `nuget.config` | （不增补；见 §9.3 规则一） |
| `*.binlog` 或 `-bl` 相关产物、`Directory.Build.targets`、深层 `*.props` 层级 | `dotnet-msbuild` |
| `Microsoft.NET.Test.Sdk` / MSTest / xUnit / NUnit / TUnit / `UseMicrosoftTestingPlatformRunner` | `dotnet-test` |
| 检测到 VSTest 且存在 MTP 迁移痕迹 | `dotnet-test` |
| `<UseMaui>` / `MauiProgram.cs` | `dotnet-maui` |
| `Microsoft.NET.Sdk.Web` / 顶层 `app.MapGet` | `dotnet-aspnet` |
| `Microsoft.EntityFrameworkCore` | `dotnet-data` |
| `net8.0` / `net9.0` / `net10.0` 且存在相邻更高目标 | `dotnet-upgrade`（含 `migrate-dotnet8-to-dotnet9`、`9-to-10`、`10-to-11`） |
| `Microsoft.ML` / `Microsoft.SemanticKernel` / MCP server 项目 | `dotnet-ai` |
| `.template.config` | `dotnet-template-engine` |
| `*.dmp` / `*.nettrace` / 符号化崩溃栈 / tombstone | `dotnet-diag` |

### 9.3 三条必须写死的规则

**规则一：`dotnet` 不做探测增补。** 它**恒在**（`core-set` 的兜底）。v1.0.0 的 `dotnet` plugin 只有 3 个专门场景技能，任何 `.csproj` 都命中它意义不大。探测只负责**往上加** plugin。

**规则二：无对应 plugin 的信号不设。** 下列信号在 v1.0.0 都没有对应内容可启用，加了只是噪声：

| 信号 | 原因 |
|---|---|
| `System.Windows.Forms` | 无 `dotnet-winforms` plugin |
| `*.razor` / `Components/` | 无独立 Blazor plugin |
| `net11.0` | 无 `dotnet11` plugin |
| `*.fsproj` / `*.fsx` | 上游无 F# 内容（§1.5） |

**规则三：`dotnet-aspnet` 只有 2 个技能**（`configuring-opentelemetry-dotnet`、`minimal-api-file-upload`），命中它的收益有限。Blazor 内容在 v1.0.0 **没有独立 plugin**。

---

## 10. 部署

### 10.1 定位

**provider 永远直读 `vendor/upstream/**`，部署不在数据通路上。** 部署是同一条内容的**第二条入口**，服务两件事：

1. 用户偏好用宿主自带的 `dsh-skill-filesystem` provider（把部署根配进 `customSkillDirs`，rank 300）而不启用本插件；
2. 人肉与外部工具浏览 `SKILL.md`、`references/`、`scripts/`。

这一定位使 P0 的代码量与平台数无关：内核一份，平台管线壳子在需要时才长出来。

### 10.2 具现化

`tools/deploy.mjs` 把**选中的子集**具现化到平台惯用根：

```
<deployRoot>/<skillName>/  →  快照 skillDir
```

| 规则 | 说明 |
|---|---|
| 每技能一个目录条目 | 宿主自带的单层扫描（`<root>/<name>/SKILL.md`）即可发现 |
| **deploy manifest** | 记录本次具现化了哪些路径，供**精确回收**。复制模式下不靠「清空目录重写」来清理，避免误删用户手动放进该目录的内容 |
| 不做自动部署 | 部署是被显式调用的动作，插件激活时不自动具现化 |

### 10.3 symlink 探测与降级

**首选 symlink。** 理由**不是省空间**（快照仅 1.43 MiB，§2.11），而是：

| 理由 | 说明 |
|---|---|
| 快照更新即时生效 | 改快照不必重跑部署（对开发期反复调授权文本很省事） |
| 单一事实源 | 不存在「仓库里的快照」与「部署点的副本」两份内容，也就没有副本过期的可能 |

**探测在前，复制兜底。** 在**目标目录内**真实创建一次链接再删掉，不做理论判断。Windows 上是否可用取决于开发者模式、`SeCreateSymbolicLinkPrivilege`、以及目录是否被 OneDrive 之类接管——**同一台机器上不同目录结果都可能不同**。

失败分级：

| 错误 | 处理 |
|---|---|
| `EPERM`（权限不足） | 整批退化为复制 |
| `UNKNOWN` / `ENOSYS`（文件系统不支持） | 整批退化为复制 |
| 其它错误 | **上报**，不吞掉 |

**Linux 走同一份探测代码**，不写 `if (linux) use symlink`。Linux 通常直接成功，但同样存在目标在 FAT/exFAT/网络挂载上的情况。

**降级必须同时进日志与 `dotnet_skills_status`。** 用户以为改动即时生效、实际读的是旧副本，是排查成本最高的故障形态。状态工具必须报出当前用的是哪条路径。

### 10.4 平台适配点

全部平台判断只允许出现在 `lib/platform/`：

| 模块 | 内容 |
|---|---|
| `lib/platform/win32.js` | 部署根约定、路径规则 |
| `lib/platform/linux.js` | 同上 |
| `lib/platform/macos.js` | **空实现 + `throw new Error('macOS adapter not implemented')`** |

**任何 `if (process.platform === ...)` 出现在 `lib/platform/` 之外即为违规。** 这样将来补 macOS 是在已知位置填空，不是全仓库找分支。

### 10.5 WSL 验证约定

WSL 里的 Node 是 Linux 原生 Node，路径与权限语义都是 Linux 的，足够验证内核与 Linux 管线。但：

**约定只用 `$HOME` 下的 ext4 路径做 symlink 类验证，不用 `/mnt/c`。** 9p 驱动的权限位与 symlink 行为与真实 Linux 不同；跨文件系统的 symlink 本来就不可靠。

---

## 11. 配置面

### 11.1 声明方式

`Config` 用 `@deepseek-ai/schemastery` 声明；**包不声明任何依赖**（宿主自带包从 dsh 安装解析）。

若该前提不成立（P0 前置冒烟会证实），退化为不导出 `Config`、在 `apply()` 内手写校验——**本节所有字段名、默认值、`ui` 档位不变**。

### 11.2 字段表

| 字段 | 默认 | `ui` | 含义 |
|---|---|---|---|
| `rank` | `700` | `advanced` | provider rank。可配，**不进配置 UI**；这是给高级用户的逃生阀 |
| `descriptionMode` | `'authored'` | `exposed` | `'authored'` / `'verbatim'`（§7.8） |
| `catalogSummaryBudget` | `320` | `advanced` | 授权文本预算。改动会使既有授权覆盖需要复核 |
| `catalogTokenBudget` | `0`（不限） | `advanced` | `budget` 选择器的触发阈值 |
| `enabledPlugins` | `[]` | `exposed` | 追加启用的 plugin（在核心集与探测之上） |
| `enabledSkills` | `[]` | `exposed` | 追加启用的技能名 |
| `disabledSkills` | `[]` | `exposed` | 排除的技能名 |
| `pinnedSkills` | `[]` | `exposed` | `budget` 选择器永不丢弃的技能 |
| `analytics.enabled` | `true` | `exposed` | 是否落盘用量 JSONL |
| `analytics.includePaths` | `false` | `advanced` | 是否存 `cwd` 明文（默认只存指纹哈希） |
| `analytics.retentionDays` | `90` | `advanced` | 保留天数 |
| `probe.enabled` | `true` | `exposed` | 是否启用项目探测 |
| `probe.maxFiles` | `20000` | `advanced` | 探测文件数上界 |
| `probe.maxDepth` | `8` | `advanced` | 探测深度上界 |
| `log.level` | `'warn'` | `advanced` | 结构化日志级别 |
| `log.bufferSize` | `500` | `advanced` | 内存环形缓冲条数 |

### 11.3 通用原则

**「配置文件有、UI 没有」是一等公民状态。**

每个 `Config` 字段在**定义时**就必须标注 `ui: 'exposed' | 'advanced' | 'hidden'`，让将来做 UI 时照着标注生成，而不是反查一遍全部字段。每个字段的默认值、取值范围、校验规则写在同一处定义里。

### 11.4 UI 现状与诊断面

A 阶段**不做专用 UI**。只有 Plugin Manager 卡片（`icon.svg` + `locale/en.json` + `locale/zh.json`）与 `dotnet_skills_status` 状态工具（§13）。

状态工具**必须**报出的诊断项：

| # | 诊断项 |
|---|---|
| 1 | 生效的 plugin 与已选技能，以及每个技能的选择原因（`selectionReason`） |
| 2 | 目录文本字符数与估算 token（`catalogChars` / `catalogEstTokens`） |
| 3 | 快照溯源：`tag` / `commit` / `fetchedAt` / `snapshotSha256` / 快照年龄 |
| 4 | **生效的 `catalogDescriptionMaxLength` 实际值**，以及被 `cap()` 截断的条数 |
| 5 | **被更高 rank 遮蔽的技能名**（宿主没有 API 可列，须由本插件自查） |
| 6 | 当前部署模式（`symlink` / `copy` / 未部署）与降级原因 |
| 7 | 指向未入库技能的指针清单（§7.6），以及被丢弃的授权指针 |
| 8 | PowerShell 依赖：哪些已选技能带 `scripts/*.ps1`，当前环境是否有 `pwsh` |
| 9 | frontmatter 非法而被跳过的技能清单（§5.4） |
| 10 | 授权覆盖状态：条目数、覆盖缺口、孤儿、`sourceSha256` 校验结果 |

### 11.5 `rank` 不进 UI

`rank` 暴露为配置项，默认 700，但**不进配置 UI**。以后做 UI 时需要显式处理「这一项是给高级用户的逃生阀」——由 §11.3 的 `ui: 'advanced'` 标注承载。

---

## 12. 日志与用量采集

### 12.1 数据模型

每条技能装载记录（JSONL 一行）：

| 字段 | 说明 |
|---|---|
| `ts` | ISO 8601 |
| `sessionId` | 取自 Cordis `tools/result` 的 `exec.agent.id` |
| `turnIndex` / `stepIndex` | 取自 projection 折叠的 `tool/call` / `tool/result` 事件 |
| `skill` / `plugin` | 被装载的技能与所属 plugin |
| `listed` | 该会话目录里是否出现过 |
| `catalogRevision` | 目录版本，用于对齐「当时可选项是什么」 |
| `catalogChars` / `catalogEstTokens` | 当次目录成本 |
| `selectionReason` | 哪条选择器选中了它 |
| `followthrough` | 装载后同一 turn 内后续工具调用的类型分布 |
| `model` | 取自 `ctx.sessions.get(id).requestContext().model` |
| `cwdFingerprint` | `cwd` 的哈希；`analytics.includePaths: true` 时另存明文 |

### 12.2 采集路径与边界

**不新增 session 事件类型。** 宿主拒绝携带未知 `type` 的存储事件（重开会话会失败），且 `Session.append()` 无法设置 `ignorable`。因此：

| 用途 | 机制 |
|---|---|
| 会话内派生状态 | `ctx.sessionProjections`，`apply(state, event)` 纯同步折叠，读到无关事件**返回同一引用** |
| 耐久落盘 | append-only JSONL，落在 `<dshHome>/dotnet-skills/usage/`（**不放包目录**，避免重装即丢） |

观测点：

| 来源 | 类型 | 用途 |
|---|---|---|
| `tools/result` | **Cordis 事件**，签名 `(exec, result)`，按 `exec.agent` 作用域分发 | 过滤 `exec.name === 'skill'` 得到一次装载 |
| `skills/change` | **Cordis 事件**，无参 | 目录版本变化 |
| `turn/start` / `step/start` / `tool/call` / `tool/result` / `turn/end` | **session 事件**，由 projection 折叠 | `turnIndex` / `stepIndex` / `followthrough` |

**`turn/end` 是 session 事件，不是 Cordis 事件。** 它不能被 `ctx.on` 监听，只能由 projection 的 `apply` 折叠。

projection 单元规格：

| 项 | 取值 |
|---|---|
| key | `dotnet-skills-usage` |
| 类型 | **host-only**（不声明 `wire.view`） |
| `init(header, inheritedEventCount)` | 从空状态开始：`{ turn, step, pending: {}, loads: [], toolHistogram: {} }` |
| `apply(state, event)` | 只处理 `turn/start` / `step/start` / `tool/call` / `tool/result` / `turn/end`；其余**返回同一引用** |
| `stateVersion` | 非负安全整数；字段或折叠语义变更时 +1 |

两条已核实的宿主约束，必须写死：

1. **`onChanged` 只对带 `wire.view` 的单位触发。** host-only 单位永不通知。因此 JSONL 落盘**不得依赖** `onChanged`；落盘由 `tools/result` 监听器直接完成。
2. **`stateSchema.parse()` 在 checkpoint 恢复与 `viewCheckpoint` 时会真被调用。** 所以 schema 必须是**真对象**，不能用手写 stub 敷衍。`stateVersion` 必须是非负安全整数；同一 key 以不同 `stateVersion` 重复注册会抛错。

其余边界：

| 项 | 规则 |
|---|---|
| 轮询 | **不轮询 `agent/status`**，等耐久事件 |
| 隐私默认 | 不采集提示词正文、文件内容、工作区外路径。`cwd` 默认只存指纹哈希 |
| 上传 | 默认**纯本地**，无 endpoint、不上传。若未来加 `analytics.endpoint`，上传必须是显式 opt-in |
| 日志系统 | 结构化 logger，内存环形缓冲 + 级别配置（`log.level` / `log.bufferSize`），配一个自诊断工具暴露状态 |

### 12.3 指标定义

| 指标 | 定义 | 用途 |
|---|---|---|
| `catalogChars` / `catalogEstTokens` | 目录规模 | 预算控制 |
| `activationRate` | 该技能被装载的会话数 / 它出现在目录里的会话数 | 核心健康度 |
| `loadsPerSession` | 平均装载次数 | 是否被滥用 |
| `deadWeight` | 全程列出、从未装载的技能 | 裁剪候选 |
| `routingPrecision` | 抽样人工判定「装载的技能是否匹配意图」 | 授权文本效果的直接验证 |
| `firstLoadStep` | 首次装载发生在第几步 | 路由是否及时 |
| `baselineDelta` | 无插件臂 vs 有插件臂 | 双臂设计 |
| `catalogRevisionChurn` | 会话内目录版本变化次数 | KV cache 压力代理 |

`baselineDelta` 无法自动跑，采用人工 A/B 或 `dsh` 自身遥测做代理指标。**这是本设计的已知弱点，须显式标注。**

报告生成器为 `tools/report.mjs`，输出 markdown 表格——本质是「个人版 Skill Value dashboard」。报告类能力放 CLI 脚本而非工具，省下 schema 预算。

---

## 13. 工具面

A 阶段刻意只有两个工具。每个工具都付 schema token。

| 工具 | 作用 | 备注 |
|---|---|---|
| `dotnet_skills_status` | 报告 §11.4 的全部诊断项 | Build/Measure 的主要抓手；`deferLoading: true` |
| `dotnet_skills_refresh` | 手动 `control.invalidate()`，项目文件变化后免重启 | 低成本高收益 |

注册方式：`ctx.tools.register(definition)`，`definition` 是**纯对象**：

| 约束 | 说明 |
|---|---|
| 必须声明 `output: { schema, render }` | 宿主校验 `output.render` 是函数，并对 `output.schema` 做 JSON Schema 支持性校验 |
| `parameters` 直接收 JSON Schema | 宿主不在注册时校验它 |
| 名字不得为 `run_code` | PTC 模式的保留名字 |
| `deferLoading: true` | 支持，用于把 `dotnet_skills_status` 的 schema 移出常态请求 |

---

## 14. 风险与未知

| 风险 | 影响 | 缓解 |
|---|---|---|
| **授权文本引入原文没有的能力声明** | 模型可能被引导去做上游不支持的事 | 规则见 §7.4，形式校验见 §7.5，但**这是本设计唯一无法机械校验的残余风险**，靠人工审 PR 兜底。如实标注，不假装有自动保障 |
| **6 条无 `USE FOR:` / `DO NOT USE FOR:` 标签的条目**（§2.4 列出） | 它们的路由信号以散文形式存在，压缩时可能被吃掉，而 ④⑤ 两条不变量对它们不产生任何约束 | 单列人工审查项（P1 W9），逐条核对散文里的路由信号。**同样没有机械校验** |
| **授权面 53 条，每次升 tag 都可能要重写一部分** | 真实维护成本 | §7.7 的硬失败把静默腐烂改成显式摩擦。这是刻意的取舍 |
| 上游升 tag 后描述变化 | 路由正确性失去数据保证 | `sourceSha256` 不匹配 → 同步报错直到重写 |
| 上游新增超长技能 | 覆盖缺口 | §7.5 ⑧ 覆盖完备检查 → 同步报错 |
| 用户调低 `catalogDescriptionMaxLength` | 授权文本被二次截断 | 授权预算 320 留余量；`cap()` 兜底；状态工具报出有效值与截断条数（§7.8、§11.4） |
| 技能重名（`run-tests` / `filter-syntax` 等泛用名） | 静默被其它 provider 胜出 | 状态工具列出被遮蔽的技能；`rank` 可配 |
| 探测误判导致目录抖动 | KV cache 反复失效，成本上升 | 只增不减；`catalogRevisionChurn` 进指标 |
| 快照与上游漂移 | 用户拿到过时技能 | `UPSTREAM.json` 溯源 + 状态工具显示快照年龄 |
| 上游改名/删除技能 | 用户配置里的技能名失效 | 未知名字降级为警告，不抛错 |
| 分析数据落在 `node_modules` 内 | 重装即丢 | 落盘到 `<dshHome>/dotnet-skills/` |
| symlink 静默降级为复制 | 用户以为改动即时生效，实际读旧副本；排查成本极高 | 降级必须**同时**进日志与状态工具；复制模式用 deploy manifest 精确回收 |
| symlink 目标被移动/删除 | 目录里出现悬空链接 | 部署时校验；`list()` 遇到不可读路径返回 `complete: false` |
| 4 个技能依赖 `scripts/*.ps1` | Linux/WSL 上无 `pwsh` 时技能残缺，模型按正文去跑脚本会失败 | 状态工具报出「本技能依赖 PowerShell，当前环境是否有」；**不假装可用** |
| WSL 下用 `/mnt/c` 验证 symlink | 9p 驱动的权限/链接行为与真实 Linux 不同，测出假结论 | 约定只用 `$HOME` 下的 ext4 路径（§10.5） |
| 沙箱写入限制阻断 `dnx roslyn-language-server` | LSP 首次运行直接失败（需联网下载并在 `~/.nuget` 落盘） | C 阶段前置验证项。A/B 阶段无 MCP、不构成阻断 |
| release-please 不合用 | 换工具要动发布流程 | 只允许它出现在 `release.yml` 与 `.release-please-manifest.json`（§3.4） |
| CHANGELOG 与快照不对帐 | 用户查到错误的「对应哪个上游版本」，审计失效 | `tools/version.mjs` 机械校验；CI 拦截 |

---

## 15. 仓库布局

```
package.json                      dsh.bundle.patch + icon + meta + files
cordis.patch.yml                  insert 一行：dotnet-agent-skills
index.js                          apply()：注册 provider + 选择器 service + 工具
lib/source-snapshot.js            SkillContentSource 的内置快照实现
lib/frontmatter.js                受限 frontmatter 解析（含 > 与 >- 块标量）
lib/descriptions.js               授权文本加载、不变量复验、cap() 兜底
lib/provider.js                   provider 实现与候选自校验
lib/selection.js                  中间件链与折叠规则
lib/detect.js                     项目信号探测
lib/analytics.js                  投影单元 + JSONL sink
lib/log.js                        结构化日志
lib/deploy/                       部署内核：具现化 + symlink 探测
lib/platform/                     平台适配点（win32/linux 实现，macos 留空抛错）
locale/en.json, locale/zh.json    插件卡片文案
icon.svg                          Plugin Manager 图标
data/descriptions.json            授权描述（53 条），本项目唯一的文本改动出口
vendor/upstream/**                上游快照，逐字节原样落盘
vendor/upstream/LICENSE           上游 MIT，保留
vendor/UPSTREAM.json              { repo, tag, commit, fetchedAt, includedPlugins[].skills,
                                    excludedPlugins[].skills, upstreamInventory, skillCount,
                                    snapshotSha256 } ← 唯一事实源
tools/sync-snapshot.mjs           同步脚本（Node ESM，无构建步骤；必须显式 --ref tag）
tools/descriptions.mjs            prepare（吐待写输入包）/ verify（十项不变量 + 漂移）
tools/deploy.mjs                  部署驱动（跨平台，只调 lib/deploy）
tools/report.mjs                  用量报告
tools/version.mjs                 校验 UPSTREAM.json 与 CHANGELOG 的对应关系
.github/workflows/release.yml     release-please（可替换）
.release-please-manifest.json     release-please 状态（可替换）
CHANGELOG.md                      每条 release 记录对应上游 tag / commit / skillCount
test/**                           单测：frontmatter、授权不变量、选择折叠、探测、symlink 降级
.gitattributes                    vendor/** -text  ← 防 CRLF 污染快照
```
