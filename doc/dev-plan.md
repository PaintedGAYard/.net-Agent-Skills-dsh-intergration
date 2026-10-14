# `dsh-dotnet-skills` 开发计划

| 项 | 值 |
|---|---|
| 契约依据 | [`doc/spec.md`](spec.md) |
| 方法 | Build → Measure → Learn，每阶段以指标裁决 |
| 平台 | P0 在 Windows 上开发，用 WSL 验证 Linux 侧内核行为 |
| 阶段 | P0 骨架与基线 → P1 全量快照与选择中间件 → P2 观测与平台管线 → P3 向 Copilot 对齐 → P4 macOS（无排期） |

图例：**Build** = 实现；**Measure** = 采集指标；**Learn** = 依据指标做的判断；**Exit** = 阶段完成判据。

---

## 0. 交付物与依赖顺序

```
P0 ── 骨架 + 授权机制 + provider（dotnet 3 技能）
 │
 ├─→ P1 ── 全量 68 技能 + 53 条授权 + 选择中间件 + 部署管线 + release-please
 │        │
 │        └─→ P2 ── 观测投影 + JSONL + 报告 + 两平台安装/卸载入口
 │                 │
 │                 └─→ P3 ── agents 映射 → LSP（另立项目）
 │
 └─→ P4 ── macOS（无排期，需真机验证）
```

P0 与 P1 的边界是**内容规模**，不是架构：P0 用 `dotnet` 单 plugin 验证**全部**机制（含授权层与同步硬失败），P1 只是把同一套机制放大到 68 技能并加上选择中间件与部署。

P0 的产物必须**在 P1 中零改动复用**。若 P1 需要改 P0 的接口，视为 P0 未完成。

---

## 1. P0 — 骨架、授权机制、provider（Build）

### 1.1 P0 前置冒烟（必须先做，10 分钟）

| # | 动作 | 判据 |
|---|---|---|
| S1 | 造一个最小 workspace bundle，在 profile 中安装，`index.js` 里 `import { z } from '@deepseek-ai/schemastery'` | 激活成功且无模块解析错误 → `Config` 按 spec §11.1 用 schemastery 声明 |
| S2 | 同上，若 S1 失败 | 退化为不导出 `Config`、在 `apply()` 内手写校验。**spec §11.2 的字段名、默认值、`ui` 档位不变**，契约不受影响 |
| S3 | 造一个只注册 `ctx.provide('dotnetSkills', {...})` 的探针插件，用另一个插件 `ctx.inject(['dotnetSkills'], ...)` 访问 | 能取到 → DI 机制按 spec §8.2 落地 |

S1/S2 的结论写进 `lib/config.js` 顶部注释，注明依据与日期。**S1–S3 是 P0 的第一个工作包，不得后置**——它们决定三个文件怎么写，后置会返工。

### 1.2 工作包

#### W1 — bundle 骨架

| 文件 | 内容 |
|---|---|
| `package.json` | `type: module`、`exports`、`files`（含 `vendor/**`、`data/**`、`locale/*.json`、`icon.svg`）、`dsh.bundle.patch: './cordis.patch.yml'`、`icon`、`meta` |
| `cordis.patch.yml` | `- insert: [{ id: dotnet-agent-skills, name: '@.../dsh-dotnet-skills', config: {} }]` |
| `index.js` | `export function apply(ctx, config)`；`export const inject = ['skills', 'tools']`；`export const Config`（或按 S2 退化） |
| `icon.svg` | Plugin Manager 图标，用主题 token，无字面色 |
| `locale/en.json` / `locale/zh.json` | 卡片标题与描述 |
| `.gitattributes` | `vendor/** -text` |
| `vendor/upstream/LICENSE` | 上游 MIT 原文 |

`apply()` 内的注册全部通过 `ctx.effect` / `ctx.on`，返回清理函数。注册顺序：日志 → 内容源 → 配置校验 → provider → 选择器 service → 工具。

**验收**：`plugin_manager install_bundle` 返回 `application: applied`；`cordis_inspect_query` 能查到新行；Plugin Manager 卡片显示图标与两种语言的文案。

#### W2 — 同步管线

`tools/sync-snapshot.mjs`（Node ESM，无构建步骤，无第三方依赖）：

| 要求 | 说明 |
|---|---|
| `--ref <tag\|commit>` **必需** | 未指定即**非零退出**，不得默认取 `main`。默认值从 `vendor/UPSTREAM.json` 的 `tag` 读，不写死在代码里 |
| 复制源 | 本地 `submodule/dotnet-skills/` 检出（P0 不依赖网络访问 GitHub） |
| 复制目标 | `vendor/upstream/<plugin>/**`，逐字节 |
| 校验一 | 技能名匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` |
| 校验二 | `description` 非空 |
| 校验三 | 行尾为 LF：发现 `\r\n` **报错**，不静默修复 |
| 校验四 | **快照内技能名全局唯一**（重名会在宿主里静默互相遮蔽） |
| 校验五 | 入库 plugin 集合 == `.claude-plugin/marketplace.json` 列出的集合；不一致即报错 |
| 产物 | `vendor/UPSTREAM.json`（含 `includedPlugins[].skills`、`excludedPlugins[].skills`、`upstreamInventory`（**该 ref 的完整 76 名清单**，与入库范围无关）、`snapshotSha256`） |

| 要求（续） | 说明 |
|---|---|
| `--plugins <list>` | 控制**复制哪些 plugin 的文件**（P0 `dotnet`，P1 起 marketplace 的 11 个）。默认值 = marketplace 列出的集合 |
| 清单总是完整的 | 无论 `--plugins` 收窄到几个，`upstreamInventory.skills` 都写出该 ref 的全部技能名。作用：spec §7.6 的名字全集 `U` 在 P0/P1 两阶段都不依赖 submodule 检出 |

**P0 的入库范围是 `plugins/dotnet/**`（3 技能）**。校验五（入库集合 == marketplace）在 P0 记为「范围受限」告警，P1 转为硬校验。

**验收**：
- `node tools/sync-snapshot.mjs`（无 `--ref`）→ 非零退出，输出明确说明必须指定 ref。
- `node tools/sync-snapshot.mjs --ref v1.0.0 --plugins dotnet` → 退出码 0；`commit == cb7c10bd32b250459632df9e6fa1350cdaf00b18`；`skillCount == 3`；`includedPlugins == [{dotnet}]`；`excludedPlugins[0].skills` 含 8 个 `exp-*`；`upstreamInventory.skillCount == 76`；`snapshotSha256` 非空。
- 人为把某文件的 LF 改成 CRLF 再跑 → 校验三报错。
- 人为复制一个技能目录造成重名再跑 → 校验四报错。

#### W3 — frontmatter 解析

`lib/frontmatter.js`：按 spec §5 实现受限语法。

**测试清单**：

| # | 用例 | 判据 |
|---|---|---|
| 1 | 全部 **40 个**块标量真样本（31 个 `>`、9 个 `>-`） | 解析结果与「续行 trim 后单空格连接」逐字一致 |
| 2 | 全部 **21 条**双引号单行标量真样本 | 引号被剥除，长度比带引号时少 2（这是 `sourceSha256` 不飘的前提） |
| 3 | 全部 **7 条**裸 plain 标量真样本 | 原样取值 |
| 4 | `>-` 与 `>` 的差异 | 前者无尾部换行 |
| 5 | 单引号标量（合成用例，实测 0 条） | 引号被剥除 |
| 6 | 块内空行 | 产出单个 `\n` |
| 7 | 未知键 | 原样保留在 `metadata.upstreamFrontmatter`，不抛错 |
| 8 | `description: \|` | **报错**（实测 0 条，遇到即是上游形态变化） |
| 9 | 嵌套映射 / 序列 / 锚点 | 报错 |
| 10 | 缺 `name` 或 `description` | 该技能被跳过并记入诊断，不抛到 `list()` 外 |
| 11 | CRLF 输入 | 能正确解析，且**不改写文件** |
| 12 | `name` 非法（大写、下划线、连续连字符） | 被跳过并记入诊断 |
| 13 | 对全部 68 条**同时**计算折叠+剥引号+规范化的文本，与 `data/descriptions.json` 的 `sourceChars` 逐条比对 | 全部相等（这一条同时守住解析器与 `verify` 两处的一致性） |

**验收**：`node --test test/frontmatter.test.js` 全绿（13 条）。

#### W4 — 描述授权层

三件产物：

| 产物 | 内容 |
|---|---|
| `data/descriptions.json` | 结构见 spec §7.3；P0 只含 **2 条**：`dotnet/dotnet-pinvoke`(538)、`dotnet/nuget-trusted-publishing`(421) |
| `tools/descriptions.mjs prepare` | 吐待写输入包：每个落入覆盖判据的技能，附折叠规范化后的上游原文、字符数、`sourceSha256`、所需的 `USE FOR:` / `DO NOT USE FOR:` 标签要求、**指针清单**（按 spec §7.6 的两步规则抽取并分成「必须保留」与「悬空可丢」两栏）、预算、写作规则摘要、名字全集 `U`。默认输出 `.authoring/descriptions-input.json`（gitignore） |
| `tools/descriptions.mjs verify` | 机械校验 spec §7.5 的十项不变量 + §7.7 的五类漂移条件；任一不满足即非零退出并**逐条列出违规** |
| 共用的指针识别模块 | `prepare` 与 `verify` 必须调用**同一个** `extractPointers()` 实现，不得各写一份正则。否则「prepare 报的待保留清单」与「verify 的核对」可能不一致，而这是最难发现的缺陷 |

`lib/descriptions.js`：

| 职责 | 说明 |
|---|---|
| 加载 | 激活时读一次 `data/descriptions.json`，构建 `Map<"<plugin>/<skill>", entry>` |
| 复验 | 复验形式项 ①–⑤（非空、≤预算、单行规范化、无尖括号、`USE FOR:` 存在、`DO NOT USE FOR:` 一致性、无 `INVOKES:`）。违规条目**降级为上游原文**并记入诊断，**不抛错** |
| 兜底 | 导出 `cap(text, max)`，按 spec §7.8；保证永不产出空串 |
| 上报 | 导出覆盖缺口、孤儿、`cap()` 截断条数，供状态工具读取 |

**P0 的 2 条授权文本**（照 spec §7.4 的规则写）：

| 键 | 上游字符数 | 要求 |
|---|---|---|
| `dotnet/dotnet-pinvoke` | 538 | ≤320；保留 `USE FOR:` 与 `DO NOT USE FOR:` 两段；上游两段都无指针，无指针保留义务 |
| `dotnet/nuget-trusted-publishing` | 421 | ≤320；保留 `USE FOR:` 与 `DO NOT USE FOR:`；**删除 `INVOKES:` 段**并把原文进 `metadata.upstreamInvokes`；无指针保留义务 |

`dotnet/csharp-scripts`(214) 不授权，走透传。

**测试清单**：

| # | 用例 | 判据 |
|---|---|---|
| 1 | `verify` 对当前仓库状态 | 退出码 0 |
| 2 | 把某条 `text` 加长到 321 | `verify` 非零退出，指出条目与不变量编号 |
| 3 | 把某条 `text` 改成含 `\n` | 同上（不变量 ②） |
| 4 | 把某条 `text` 改成含 `<` | 同上（不变量 ③） |
| 5 | 删掉某条的 `USE FOR:`（上游原文有） | 同上（不变量 ④） |
| 6 | 给上游**无**标签的技能（如 `dotnet-test/test-anti-patterns`）补上 `USE FOR:` | 同上（不变量 ④ 的反向） |
| 7 | 给上游无 `DO NOT USE FOR:` 的技能加上该段 | 同上（不变量 ⑤） |
| 8 | 在 `text` 里留 `INVOKES:` | 同上（不变量 ⑥） |
| 9 | 改掉某条的 `sourceSha256` 之一字节 | 同上（§7.7 漂移） |
| 10 | 删掉一条应当存在的覆盖 | 同上（覆盖缺口） |
| 11 | 加一条指向不存在技能的覆盖 | 同上（孤儿） |
| 12 | 改 `upstream.tag` | 同上（不变量 ⑩） |
| 13 | 指针守恒：构造一条上游含 `(use X)` 且 `X ∈ V` 的假条目，授权文本丢掉该指针 | 同上（不变量 ⑦） |
| 14 | `U \ V` 指针被丢弃 | **`verify` 通过**，但列出该指针（允许丢弃 + 必须上报） |
| 15 | `(use run-tests for all of these)` 形态 | 抽出 `run-tests` 并被要求保留（**带尾词的宽松抽取**） |
| 16 | `(use migrate-mstest-* skills)` 形态 | 抽出 `migrate-mstest`，因不属 `U` 而**判为散文**，不产生保留义务 |
| 17 | `(use Grid or StackLayout)`、`(use Python with PyTorch/TensorFlow, then export to ONNX for .NET inference)`、`(use Microsoft.Maui.Controls.Maps)` | 全部 tokens 不属 `U` → 判为散文，**不产生任何保留义务**（证明不需要 NLP） |
| 18 | `(use dotnet-msbuild plugin)`（plugin 名，非技能名） | `dotnet-msbuild ∉ U` → 判为散文 |
| 19 | `DO NOT USE FOR:` 段内的指针 | 与正文段内的指针**同等待遇**（抽取不分段） |
| 20 | `extractPointers()`：同一输入在 `prepare` 与 `verify` 两条路径下结果完全相同 | 深比较相等（防两份正则漂移） |
| 21 | `cap('abcdefgh', 5)` | 返回 `'ab...'` |
| 22 | `cap('abc', 3)` | 返回 `'abc'` |
| 23 | `cap('abc', 1)` | 返回 `'a'`（永不空串） |
| 24 | 加载时某条超预算 | 条目降级为上游原文 + 记入诊断，**不抛错** |

**验收**：`node tools/descriptions.mjs verify` 退出码 0；`node --test test/descriptions.test.js` 全绿（24 条）。

#### W5 — 内容源与 provider

| 文件 | 内容 |
|---|---|
| `lib/source-snapshot.js` | `SkillContentSource` 的内置快照实现：`resolve(pluginId)`、`listPlugins()`（spec §4） |
| `lib/provider.js` | `ctx.skills.registerProvider(control => ({ name, list, get }))`（spec §6） |

**`list()` 的实现要求**：

1. 按选择中间件的折叠结果取技能集合（P0 只有 `config-baseline` + `core-set`）。
2. 每个候选构造完后**立即自校验**（spec §6.2 硬规则一）。校验失败 → 丢弃该候选、记入诊断、置 `complete = false`。
3. 整体包 `try/catch`：任何异常 → 返回已构建的候选 + `complete: false`，**绝不外抛**。
4. `get(candidate)` 每次重读 `SKILL.md`；读不到返回 `undefined`；返回的 `name` 必须等于候选 `name`。

**测试清单**：

| # | 用例 | 判据 |
|---|---|---|
| 1 | 正常路径 | 3 个候选，`complete: true`，字段齐全（`path`、`resourceBase`、`provider`、`source`、`rank`、`locator`、`metadata`） |
| 2 | `provider` 字段与 provider.name 不一致 | 自校验拦下，不进入候选集，`complete: false` |
| 3 | `rank` 为 `NaN` / 字符串 | 同上 |
| 4 | `invocation` 缺一个布尔 | 同上 |
| 5 | 快照目录被删除 | `list()` **不抛错**，返回 `complete: false` |
| 6 | `SKILL.md` 内容非法 frontmatter | 该技能被跳过，其余仍返回，`complete: false` |
| 7 | `get()` 在两次调用之间改文件 | 第二次返回新内容（证明不缓存） |
| 8 | `get()` 删除文件后再调 | 返回 `undefined` |
| 9 | `user-invocable: false` 的假技能 | 候选 `invocation == { modelInvocable: true, userInvocable: false }`，**仍在候选集里** |
| 10 | `descriptionMode: 'verbatim'` | 全部用上游原文 |

**验收**：`node --test test/provider.test.js` 全绿（10 条）。

#### W6 — 工具

| 工具 | 实现要点 |
|---|---|
| `dotnet_skills_status` | 纯对象定义：`parameters` 为 JSON Schema（可无参）；`output: { schema, render }`；`deferLoading: true`；输出覆盖 spec §11.4 的全部 10 项诊断 |
| `dotnet_skills_refresh` | 调 `control.invalidate()`，返回是否发生了目录变更 |

**测试清单**：两个工具各一条「输出包含全部必需诊断键」的用例。

#### W7 — 版本与对帐

| 产物 | 内容 |
|---|---|
| `CHANGELOG.md` | 首条 unreleased 记录，含 `Upstream: dotnet/skills v1.0.0 (cb7c10bd), 1 plugins / 3 skills`（P0 范围） |
| `tools/version.mjs` | 校验 `UPSTREAM.json` 的 `tag`/`commit`/`skillCount` 与 CHANGELOG 最新记录一致；不一致非零退出 |

**验收**：`node tools/version.mjs` 退出码 0；改 `UPSTREAM.json` 的 `commit` 后非零退出。

### 1.3 P0 实测项（Measure）

| # | 实测项 | 方法 | 记录位置 |
|---|---|---|---|
| M1 | 目录文本字符数与估算 token | `dotnet_skills_status` 的 `catalogChars` / `catalogEstTokens` | P0 报告 |
| M2 | `resourceBase` 是否真的让模型读到 `references/` | 装载一个带 `references/` 的技能，让模型读其中一个相对路径文件 | P0 报告（P0 的 3 技能都不带 `references/`，故**用一个假快照夹具**测；真实信号在 P1） |
| M3 | `scripts/*.ps1` 在 Windows 与 WSL 下的真实可用性 | 在 WSL 里跑 `pwsh -v`；若不存在，记录该环境下 4 个技能不可用 | P0 报告 + 状态工具文案 |
| M4 | 侧栏 `SKILL.md` 预览 | `/csharp-scripts` 后点击 token，右侧栏打开预览 | P0 报告 |
| M5 | `/name` 手势 | `/csharp-scripts` 注入正文，且模型不重复调用 `skill` 工具 | P0 报告 |
| M6 | `paths` 解析 | Windows 与 WSL 下 `path` / `resourceBase` 都是该平台可读的绝对路径 | P0 报告 |
| M7 | 有效 `catalogDescriptionMaxLength` | 状态工具报出的值与 `dsh-tool-skill` 配置一致 | P0 报告 |

### 1.4 P0 的 Learn

| 问题 | 判据 |
|---|---|
| provider 契约在真实宿主里是否如 spec §6 所述 | M1–M7 全部拿到，无「文档说 A、实际 B」的项 |
| `resourceBase` 的目录形态是否真的够用 | M2 通过 |
| 授权文本是否被下游原样放行 | 3 条描述在目录里的渲染长度 == 状态工具报出的长度 |
| 默认核心集的实际成本 | M1 的数字 |

### 1.5 P0 Exit

- `dotnet` 3 个技能稳定可用（装载成功、侧栏可开、`/name` 可触发）。
- 单测覆盖：frontmatter（13 条，含 68 条真样本全覆盖）、授权不变量（24 条）、provider（10 条）。
- `tools/sync-snapshot.mjs`、`tools/descriptions.mjs verify`、`tools/version.mjs` 三条命令可重复跑通。
- P1 无需改动 P0 的任何接口。

---

## 2. P1 — 全量快照、53 条授权、选择中间件、部署（Build + Measure）

### 2.1 工作包

#### W8 — 全量快照

`tools/sync-snapshot.mjs --ref v1.0.0`（不传 `--plugins`，取默认的 11 个），入库 11 plugin / 68 技能。

**验收**：
- `UPSTREAM.json` 的 `includedPlugins` 等于 `.claude-plugin/marketplace.json` 的 11 个；`skillCount == 68`；`upstreamInventory.skillCount == 76`。
- 校验五从 P0 的「范围受限告警」转为**硬校验**。
- `vendor/upstream/**` 与 submodule 检出 diff 为空（逐字节一致）。

#### W9 — 53 条授权

流程：`node tools/descriptions.mjs prepare` → 按 spec §7.4 逐条重写 → `node tools/descriptions.mjs verify` → 全绿。

| 工作量 | 值 |
|---|---|
| 覆盖条数 | 53（P0 已做 2 条，本轮 **51 条**） |
| 需重写原文合计 | 40,551 字符 |
| 授权后估算 | 约 20,800 字符（≈5.2k est tokens） |

分工建议：按 plugin 分批（`dotnet-msbuild` 12 条、`dotnet-test` 12 条、`dotnet-maui` 8 条、`dotnet-ai` 5 条、`dotnet-upgrade` 5 条、`dotnet-template-engine` 4 条、`dotnet-diag` 3 条、`dotnet-nuget` 1 条、`dotnet` 剩 0 条），每批独立走一次 `verify`。

**必做的机械检查**（`verify` 已覆盖，但仍需人工过一遍）：
- 指针：32 个被指向的入库技能必须全部保留其指针。指针最密的是 `writing-mstest-tests`(5)、`build-perf-diagnostics`(5)、`test-anti-patterns`(5)，以及 `maui-*`、`mcp-csharp-*`、`template-*` 三组各 3 次的技能（spec §2.8 有全表）。
- 带尾词的指针（`(use X first)` / `(use X for all of these)` / `(use X after baselining)` / `(use X and Y)`）是否都保住了——这类是最容易在重写时丢的。
- 13 条含 `INVOKES:` 的条目是否都清掉了该段。
- 47 条带 `USE FOR:` / `DO NOT USE FOR:` 的条目是否两段都在，且**没有给另外 6 条补标签**。
- **6 条无标签条目单列人工审查**（`test-anti-patterns`、`technology-selection`、`apple-crash-symbolication`、`writing-mstest-tests`、`android-tombstone-symbolication`、`microbenchmarking`）：逐条核对散文里的路由信号没有被压缩动作吃掉。**这一项没有任何机械校验**，是本阶段唯一纯人工的检查。

**验收**：`tools/descriptions.mjs verify` 退出码 0；覆盖缺口 0、孤儿 0、`sourceSha256` 不匹配 0；悬空指针清单恰好为 4 个名字（`exp-assertion-quality`、`exp-mock-usage-analysis`、`exp-test-maintainability`、`exp-test-smell-detection`）并被人工确认；6 条无标签条目的人工审查有记录。

#### W10 — 选择中间件

`lib/selection.js` + `ctx.provide('dotnetSkills', ...)`（spec §8）。

内置选择器排期：

| 选择器 | P1 状态 |
|---|---|
| `config-baseline` | 从 P0 保留，补齐 `enabledPlugins` / `enabledSkills` / `disabledSkills` |
| `core-set` | 保留 |
| `project-detection` | 新增（依赖 W11） |
| `budget` | 新增，默认关 |
| `analytics-lru` | 占位，不实现 |

**测试清单**：

| # | 用例 | 判据 |
|---|---|---|
| 1 | 三条选择器各自返回 patch，`include` 求并集 | 集合 == 并集 |
| 2 | `exclude` 减去一条被 include 的技能 | 该技能不在结果里 |
| 3 | 一条选择器 `include` 且另一条 `exclude` 同一技能 | 结果不含它（减法在后） |
| 4 | 选择器返回 `undefined` | 弃权，不影响结果 |
| 5 | 选择器返回空 patch | 同上 |
| 6 | 打乱注册顺序重跑 | 结果集合完全相同（**与顺序无关**） |
| 7 | 两条选择器选中同一技能，`priority` 不同 | `reason` 归 `priority` 大者 |
| 8 | `priority` 相同 | `reason` 归选择器名码点序小者 |
| 9 | 第三方经 `ctx.inject(['dotnetSkills'], ...)` 注册 | 它的选择器参与折叠 |
| 10 | 第三方注册后又卸载 | 它的选择器被摘除，结果回到原状 |
| 11 | `budget` 打开，`catalogTokenBudget` 设为极小值 | 按优先级丢弃；`pinnedSkills` 里的技能**仍在** |
| 12 | 会话内二次折叠 | 集合**只增不减** |

**验收**：`node --test test/selection.test.js` 全绿（12 条）。

#### W11 — 项目探测

`lib/detect.js`，按 spec §9。

**测试清单**：

| # | 用例 | 判据 |
|---|---|---|
| 1 | 信号表逐行 | 每条信号在夹具里命中对应 plugin |
| 2 | `dotnet` 恒在 | 任何夹具下 `dotnet` 都在结果里（不由探测产生） |
| 3 | 无对应 plugin 的信号 | `System.Windows.Forms` / `*.razor` / `net11.0` / `*.fsproj` **不产生任何 plugin** |
| 4 | 有界 | 超过 `probe.maxFiles` / `probe.maxDepth` 时提前返回，不超时 |
| 5 | 记忆化 | 同一 `(cwd, mtime-bucket)` 二次调用不重扫 |
| 6 | **只增不减** | 连续两次折叠结果满足 `first ⊆ second` |
| 7 | 纯函数 | 同一夹具两次调用结果完全一致 |
| 8 | `probe.enabled: false` | 探测不运行，只留核心集 |

**验收**：`node --test test/detect.test.js` 全绿（8 条）。

#### W12 — 部署管线

`lib/deploy/`（具现化 + symlink 探测）+ `lib/platform/{win32,linux,macos}.js` + `tools/deploy.mjs`，按 spec §10。

**测试清单**：

| # | 用例 | 判据 |
|---|---|---|
| 1 | 目标目录支持 symlink | 具现化结果为链接；manifest 记录路径正确 |
| 2 | 目标目录不支持（注入 `EPERM`） | 整批退化为复制；**同时**写日志与状态；manifest 仍正确 |
| 3 | 注入 `ENOSYS` | 退化为复制 |
| 4 | 注入其它错误（如 `EIO`） | **上报**，不吞掉，不静默降级 |
| 5 | 复制模式下二次发布（技能集合变化） | 按 manifest 精确回收：被删除的技能目录消失，**用户手动放入的文件不受影响** |
| 6 | 部署后快照更新 | symlink 模式下读到新内容（无需重跑部署） |
| 7 | symlink 目标被删除 | 状态工具报出悬空；`list()` 返回 `complete: false` |
| 8 | `lib/platform/` 之外的平台分支 | 静态检查：`lib/**` 与 `tools/**` 中除 `lib/platform/` 外无 `process.platform` |
| 9 | `macos.js` | 调用即抛 `macOS adapter not implemented` |

**平台实测（Measure）**：

| # | 环境 | 记录 |
|---|---|---|
| P1-1 | Windows，开发者模式**开** | symlink 探测成功/失败、失败码、降级与否 |
| P1-2 | Windows，开发者模式**关** | 同上 |
| P1-3 | WSL，`$HOME` 下的 ext4 路径 | 同上。**不得用 `/mnt/c`** |
| P1-4 | WSL，`/mnt/c` 路径（仅作对照，不作判据） | 记录差异，证明为什么取 P1-3 作判据 |

**验收**：`node --test test/deploy.test.js` 全绿（9 条）；P1-1 至 P1-3 三组数据齐全。

#### W13 — release-please

| 文件 | 内容 |
|---|---|
| `.github/workflows/release.yml` | release-please action，目标线 `origin/main` |
| `.release-please-manifest.json` | 初始 `"0.0.0"`，由 release-please 推进到 `0.1.0` |
| release PR 描述 | 注入由 `UPSTREAM.json` 生成的 `Upstream: dotnet/skills v1.0.0 (cb7c10bd), 11 plugins / 68 skills` 区块 |
| CI 校验 | `package.json.version` 未被手改（与 manifest 一致）；`tools/version.mjs` 通过；`tools/descriptions.mjs verify` 通过 |

**验收**：手动触发一次 workflow，release PR 被创建且描述含上游区块；合并后 tag 与 `package.json.version` 一致。

### 2.2 P1 的 Measure

| # | 指标 | 方法 |
|---|---|---|
| M8 | 各 profile 的目录 token 成本 | 三档：核心集 3 技能 / 选项二 34 技能 / 全量 68 技能 |
| M9 | **`authored` vs `verbatim` 双臂对比** | 控制臂 = `verbatim`（51 条超长描述被下游按 `slice(0,497)+'...'` 截断）。两臂各跑同一组真实任务，抽样人工判定 `routingPrecision` |
| M10 | 探测准确率 | 在 N 个真实 .NET 仓库上跑，人工核对命中 plugin 是否合理 |
| M11 | `activationRate` | 需要 P2 的 JSONL；P1 阶段用 `dotnet_skills_status` 的候选集与人工观察代替，标注为不完整 |
| M12 | 指针保留的人工抽样 | 从 53 条里抽 15 条，逐条核对 `USE FOR:` / `DO NOT USE FOR:` / 指针三项 |

### 2.3 P1 的 Learn

| 问题 | 裁决依据 |
|---|---|
| **默认核心集选选项一还是选项二** | M8 的三档实测数字 + M9 的 `routingPrecision`。选项二默认成本约 10,700 字符（≈2.7k est tokens），是否付得起由数据定 |
| 探测信号表哪些是噪声 | M10 的误命中率；误命中率高的信号从表里删（删信号不违反「只增不减」——那是会话内规则） |
| 授权文本相对朴素截断的收益是否成立 | M9 的 `routingPrecision` 差值 |
| `budget` 选择器是否该默认打开 | M8 全量档 + M9 |

### 2.4 P1 Exit

- 默认配置下的目录成本可接受（有 M8 数字支撑的明确判断）。
- `authored` 臂的抽样路由精度**不低于** `verbatim` 臂。
- `descriptions verify` 在 68 技能上全绿。
- symlink 探测在 Windows（开关两种状态）与 WSL（ext4）上都有可复现的数据。
- release PR 能产出且描述含上游溯源区块。

---

## 3. P2 — 观测与平台管线（Measure 基建）

### 3.1 工作包

#### W14 — 投影单元

`lib/analytics.js` 的 projection 单元，按 spec §12.2：

| 项 | 取值 |
|---|---|
| key | `dotnet-skills-usage` |
| 类型 | **host-only**（不声明 `wire.view`） |
| 折叠范围 | `turn/start` / `step/start` / `tool/call` / `tool/result` / `turn/end` |
| `apply` 无关事件 | **返回同一引用** |
| `stateSchema` | 真对象（`@deepseek-ai/schemastery`）；`stateVersion` 非负安全整数 |

**测试清单**：

| # | 用例 | 判据 |
|---|---|---|
| 1 | 无关事件 | `apply` 返回的引用与传入的完全相同（`===`） |
| 2 | `tool/call` + `tool/result` 配对 | `followthrough` 直方图正确 |
| 3 | `turn/end` | 该 turn 的装载记录被结算 |
| 4 | checkpoint 往返 | `checkpoint` → `restore` 后状态一致 |
| 5 | `stateVersion` 变更 | 旧 checkpoint 被丢弃并从头折叠（不报错到调用方） |
| 6 | 同一 key 不同 `stateVersion` 重复注册 | 抛错（宿主行为，确认我们没踩） |
| 7 | `onChanged` 不触发 | **断言 host-only 单位不产生通知**，证明落盘没有依赖它 |

#### W15 — JSONL sink

- 落盘到 `<dshHome>/dotnet-skills/usage/<YYYY-MM>.jsonl`（**不放包目录**）。
- 由 `tools/result` 监听器直接写入（过滤 `exec.name === 'skill'`），**不依赖 `onChanged`**。
- `turnIndex` / `stepIndex` 从 projection 的 `stateOf(session, 'dotnet-skills-usage')` 读；`session` 由 `ctx.sessions.get(exec.agent.id)` 取。
- `model` 从 `session.requestContext().model` 取。
- 隐私默认：不写提示词正文、不写文件内容、不写工作区外路径；`cwd` 默认只写指纹哈希。
- `analytics.retentionDays` 到期清理。

**测试清单**：写入一条记录的字段完整性；隐私默认下无 `cwd` 明文；`analytics.enabled: false` 时不落盘；`ctx.sessions.get` 返回 `undefined`（会话已结束）时不抛错、跳过该条或降级为无 turn/step 的记录（**选降级，不丢数据**）。

#### W16 — 报告与自诊断

| 产物 | 内容 |
|---|---|
| `tools/report.mjs` | 读 JSONL，输出 markdown 表格：`deadWeight` 榜、`loadsPerSession`、`activationRate`、`catalogRevisionChurn`、`firstLoadStep`、`routingPrecision` 抽样表 |
| 自诊断 | `dotnet_skills_status` 加上日志环形缓冲摘要（`log.level` / `log.bufferSize`） |

#### W17 — 平台管线

Windows 与 Linux **各写一份**安装/卸载入口、CI 矩阵与打包格式，**互不迁就**。共享的只有 `lib/` 内核与 `lib/deploy/` 的具现化原子操作。

### 3.2 P2 的 Measure

| # | 指标 | 用途 |
|---|---|---|
| M13 | `deadWeight` 榜单 | 第一次裁剪决策的依据 |
| M14 | `loadsPerSession` | 判断是否被滥用 |
| M15 | `catalogRevisionChurn` | 会话内目录是否真的单调；KV cache 压力代理 |
| M16 | 两平台部署成功率 | 平台管线是否真的稳 |

### 3.3 P2 的 Learn

- 哪些技能是纯负担（`deadWeight` 长期为 1）→ 是否从默认配置移除。
- 会话内目录是否真的单调（M15 应接近 0）。
- **平台管线的真实差异在哪**——避免猜出来的抽象；只把两平台真正不同的部分各自实现。

### 3.4 P2 Exit

- 能产出一份可读的用量报告，并据此做出**第一次裁剪决策**。
- Linux 管线在 WSL 上可复现地跑通。
- 自诊断能回答：当前目录是什么、为什么、成本多少、快照多旧。

---

## 4. P3 — 向 Copilot 对齐（扩张）

按 ROI 排序。**每项都独立开关、独立 bundle**，避免把 A 阶段做成的稳定核心拖进不确定性。

| 顺序 | 项 | 说明 |
|---|---|---|
| 1 | `agents/*.agent.md` 映射 | v1.0.0 有 4 个 plugin 声明 `agents`（`dotnet-diag`、`dotnet-msbuild`、`dotnet-template-engine`、`dotnet-test`）。DSH 有 agent preset 与 subagent，语义不同，需要一个映射层 |
| 2 | LSP（roslyn） | **另立项目**，不是本插件的职责 |

**LSP 的前置验证项（必须先做）**：`dotnet/lsp.json` 用 `dotnet dnx roslyn-language-server --yes --prerelease`，首次运行需联网下载并在 `~/.nuget` 落盘。在 `workspace-write` 沙箱下工作区外写入被拒，受限 token 下 `stdio: 'pipe'` 捕获子进程会 EPERM。因此必须把 `NUGET_PACKAGES` / `DOTNET_CLI_HOME` 指到工作区内，且不得用管道 stdio 抓取。

**MCP 自动注册**：v1.0.0 无此内容，不排期。

- **Measure**：各能力的独立激活率与 `baselineDelta`。
- **Learn**：哪些 Copilot 专属能力在 DSH 的 agent 模型下其实没有价值，可以正当地不做。

---

## 5. P4 — macOS（无排期）

触发条件：拿到 mac 机器，或有人愿意做真机验证。

按 `lib/platform/macos.js` 的适配点填空，且**必须有真机验证才发布**，不做「看着对就发」。

---

## 6. CI 门禁

每次 PR 必须全绿：

| # | 检查 | 命令 |
|---|---|---|
| 1 | 全部单测 | `node --test test/` |
| 2 | 授权不变量 + 漂移 | `node tools/descriptions.mjs verify` |
| 3 | CHANGELOG ↔ UPSTREAM 对帐 | `node tools/version.mjs` |
| 4 | 快照完整性 | `snapshotSha256` 与实际 `vendor/upstream/**` 一致 |
| 5 | 行尾 | `vendor/upstream/**` 无 CRLF |
| 6 | 平台分支纪律 | `lib/**`、`tools/**` 中除 `lib/platform/` 外无 `process.platform` |
| 7 | 版本号未被手改 | `package.json.version` 与 release-please manifest 一致 |
| 8 | 内容纪律 | `vendor/upstream/**` 与上游 ref 逐字节一致（P1 起） |

---

## 7. 阶段风险与门禁

| 风险 | 触发阶段 | 门禁 |
|---|---|---|
| 授权文本引入原文没有的能力声明 | P1（51 条批量） | **无法机械校验**。必须人工逐条审 PR，且按 plugin 分批提交，便于聚焦审查 |
| 上游升 tag 后需重写授权 | 任何升级 | `descriptions verify` 非零退出即阻断同步（刻意摩擦） |
| 选项二默认成本付不起 | P1 | M8 数字出来前不切换默认 |
| symlink 降到复制后用户误判 | P1 | 降级必须同时进日志与状态工具；缺任一项视为 W12 未完成 |
| 投影 `onChanged` 误当通知源 | P2 | W14 用例 7 必须断言 host-only 单位不通知 |
| LSP 在沙箱下直接失败 | P3 | 前置冒烟未通过则 LSP 不开工 |
| `/mnt/c` 下测出假 symlink 结论 | P1 | P1-3 用 `$HOME` 的 ext4；`/mnt/c` 只作对照（P1-4） |

---

## 8. 验收命令清单

每阶段结束时可整段执行：

```powershell
# P0
node --test test/frontmatter.test.js
node --test test/descriptions.test.js
node --test test/provider.test.js
node tools/sync-snapshot.mjs                 # 期望：非零退出（缺 --ref）
node tools/sync-snapshot.mjs --ref v1.0.0
node tools/descriptions.mjs verify
node tools/version.mjs
node tools/descriptions.mjs prepare          # 产出 .authoring/descriptions-input.json

# P1
node --test test/
node tools/sync-snapshot.mjs --ref v1.0.0    # 期望 11 plugin / 68 技能
node tools/deploy.mjs --dry-run              # 报出将具现化的路径与探测结果
```

| 阶段 | 不得进入下一阶段的判据 |
|---|---|
| P0 | 任一单测红、`verify` 非零、`/csharp-scripts` 侧栏打不开 |
| P1 | `verify` 非零、symlink 三组数据缺任一组、默认目录成本无数字 |
| P2 | 报告产不出、`catalogRevisionChurn` 无数据 |
