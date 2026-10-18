<div align="center">
  <img src="docs/images/icon.png" alt="dsh-hermes-bridge" width="116">

# dsh-hermes-bridge

**简体中文** ｜ [English](README_EN.md)

<img alt="许可证 MIT" src="https://img.shields.io/badge/license-MIT-22D3EE?style=flat-square">
<img alt="适配 DSH 0.2.1-rc.2" src="https://img.shields.io/badge/dsh-0.2.1--rc.2-4B6FFF?style=flat-square">
<img alt="运行依赖 1 个（yaml）" src="https://img.shields.io/badge/runtime%20dependency-yaml-A855F7?style=flat-square">
<img alt="离线测试全绿" src="https://img.shields.io/badge/tests-offline%20green-2F6F4F?style=flat-square">
<img alt="设置页 5 个" src="https://img.shields.io/badge/settings-5%20pages-7DA1DE?style=flat-square">
<img alt="安装链路已端到端实测" src="https://img.shields.io/badge/install-end--to--end%20verified-F0A441?style=flat-square">

<br>

> 把 Hermes Agent 的**人设、长期记忆、技能库、MCP 服务器与 OpenViking 知识库**
> 原生接进 DeepSeek Harness，让住在两个 harness 里的 agent 共享同一份人格与记忆。
>
> 每接进来的一块都是**可独立启停的一行**，并配一个可视化设置页收尾首次配置：
> 探测路径、保存路径、填 OpenViking 身份、一键同步 MCP —— 全程不用碰终端。
>
> 它不是「调 Hermes 的工具」，而是把资源按 DSH 自己的接口装进去：
> 人设与记忆走 `ctx.systemPrompt` 段，技能走 `ctx.skills` provider（复用 DSH 自带的 `skill` 工具），
> MCP 走 DSH 自己的 `dsh-mcp-client` 行，OpenViking 走 `ctx.tools`。
> 所以模型看见的是一套工具，不是两层。

</div>

![它接进来什么](docs/images/bridge-flow.png)

---

## 亮点

- **桥接而不是包装**——记忆是 DSH 的原生系统提示词段，技能是 DSH 的 `ctx.skills` provider，工具是 `ctx.tools`，没有中间层。
- **九行装配，逐行开关**——每个能力独立成行，能在插件页或本插件设置页单独关掉，出问题时影响面只有那一行。
- **启动永不抛错**——Hermes 没装、OpenViking 没起、路径写错，都只影响对应那行，并在调用时给出明确错误，不拖垮 profile。
- **五页设置界面**——总览、连接、技能、预览、诊断；开关写回 profile 自己的 `cordis.patch.yml`，注释与手写行一个字节都不动。
- **记忆带来源标记**——`MEMORY.md` / `USER.md` 两边都会写，所以新条目带 `[dsh]` / `[hermes]` 前缀，谁写的能一眼看出来。
- **不回溯打标**——`MEMORY.md` 是硬字符预算，给老条目补前缀会挤爆 Hermes 自己的写入空间，所以只标新写的。
- **启动不写配置**——启动时改自己的配置会让 harness 在启动过程中重载自己，那正是「第一次能跑、第二次就坏」的产地。
- **只读的是刻意的**——cron 与会话历史只读：两套调度器共管一份任务文件，只会得到重复触发或者永不触发。
- **有测试，也有探测脚本**——离线测试任何机器可跑；活体测试读真实 Hermes 数据；另有插件图标像素校验与装配树探针。数字见「开发与测试」。

## 它接进来什么

| 行 | 模块 | 干什么 | 进上下文方式 |
|---|---|---|---|
| `hermes-bridge-host` | `dsh-hermes-bridge` | 承载浏览器半身（设置界面），自己不挂功能 | — |
| `hermes-bridge-persona` | `dsh-hermes-bridge/persona` | Hermes 的 `SOUL.md` → 系统提示词段（order 5） | 常驻 |
| `hermes-bridge-memory` | `dsh-hermes-bridge/memory` | `MEMORY.md` + `USER.md`（order 6，每次组装重读），每条标来源 | 常驻 |
| `hermes-bridge-memory-write` | `dsh-hermes-bridge/memory-write` | `memory` 工具：list / add / patch / remove | 按需调用 |
| `hermes-bridge-skills` | `dsh-hermes-bridge/skills` | 递归发现 Hermes 的 `skills/`，注册成 `ctx.skills` provider | 按需加载 |
| `hermes-bridge-viking` | `dsh-hermes-bridge/viking` | OpenViking 的 4 个工具（search / read / browse / remember），手写 HTTP 客户端 | 按需检索 |
| `hermes-bridge-provider` | `dsh-hermes-bridge/provider` | **通用**：把 Hermes 当前配置的记忆提供方原样接进来（openviking / retaindb / byterover / honcho / mem0 / hindsight / supermemory …） | 按需检索 |
| `hermes-bridge-updater` | `dsh-hermes-bridge/updater` | 定期检查 GitHub 上有没有新版本，可选自动安装，装完尝试热重载 | — |
| `hermes-bridge-mcp` | `dsh-hermes-bridge/mcp` | 对账 Hermes 的 MCP 服务器与已挂载行，提示漂移 | 行级 |
| `hermes-bridge-hermes-data` | `dsh-hermes-bridge/hermes-data` | Hermes 的 cron 清单 + 会话历史检索（**只读**） | 按需调用 |
| `hermes-bridge-settings` | `dsh-hermes-bridge/settings` | 设置页的数据接口（不是功能） | — |

## 安装

前置条件：DSH 桌面版已安装；Hermes Agent 已经初始化过（本插件不装 Hermes，只桥接它）。

在 DSH 里：**侧栏「插件」→ 添加插件 → 安装第三方插件**，填本仓库地址。

也可以走 CLI（这套已实测：装完会自动把包名追加进该 profile 的 `dsh.profile.bundles`，重启 DSH 即生效）：

```bash
dsh plugin --profile <profile> add github:Loki-kiki/dsh-hermes-bridge
# 或本地开发用绝对路径
dsh plugin --profile <profile> add <本仓库绝对路径>
```

装完重启 DSH。

> 如果 pnpm 报 `ERR_PNPM_NO_MATCHING_VERSION`，先看清是哪个包报的 —— 那通常是 profile 里**别的**插件的版本声明问题，与本包无关。这种情况可以改用链接安装：在 profile 的 `package.json` 里加 `"dsh-hermes-bridge": "link:<本仓库绝对路径>"` 并把包名追加进 `dsh.profile.bundles`，然后在 `<profile>/node_modules` 下建一个指向本目录的 junction（或符号链接）。
>
> `node_modules/yaml` 是运行依赖，链接安装时从本目录解析，别删。
>
> 若 pnpm 解析 git 依赖时报 `schannel: ... CRYPT_E_REVOCATION_OFFLINE`，那是本机 git 走 Windows schannel 拿不到吊销列表，与本包无关 —— 给 git 换 OpenSSL 后端即可（`git config --global http.sslBackend openssl`）。

## 首次配置

装好后在 DSH 里 **设置 → Hermes 桥接**，第一页「**连接**」就是给第一次装的人准备的：

1. 插件会自己探测 Hermes 主目录：`$HERMES_HOME` → Windows `%LOCALAPPDATA%\hermes` → `~/.hermes`。
   探测不到时页面顶部会出红色引导卡 —— 填路径，点「测试」，再点「保存」。**保存会先验证目录存在**，路径打错不会被写进去。
2. 要用 OpenViking 就填端点与身份：`account` / `user` / `agent`。`user` 是你的 OpenViking 租户名，必须和 Hermes 侧 `memory.openviking.user` 一致。留空等于「未配置」，这时 `viking_*` 工具会直接告诉你缺哪一项，而不是把记忆读写到别人的目录里。
3. Hermes 里配了 MCP 服务器的话，点「**立即同步**」生成 DSH 原生行（改完重启 DSH 生效）。同步写的是受管区块，你手写的其他行一个字节都不动，重复跑幂等。

所有写入都进本 profile 的 `cordis.patch.yml` 覆盖层（用 `yaml` Document 保留注释、原子改名），行开关由 `dsh-hmr` 热重载，不用重启。

## 设置界面

五个页签：

| 页签 | 内容 |
|---|---|
| 总览 | 九个功能行的开关、记忆来源分布、桥接实际读取的每个文件（真实大小 + 修改时间）、Hermes 侧记忆设置、OpenViking 实时健康 |
| 连接 | 首次安装引导：Hermes 探测、路径输入/测试/保存、OpenViking 端点与身份、**插件更新面板**、**记忆提供方面板**（当前后端 / agent 树 / 解释器 / 一键探测工具清单）、一键 MCP 同步 |
| 技能 | 技能清单逐个开关 + 搜索 + 分类筛选 + 批量全开全关，下一次对话生效 |
| 预览 | 人设段和记忆段**实际注入**的原文（直接读文件渲染，不是从配置反推） |
| 诊断 | profile、Hermes 主目录、DSH 主目录、覆盖层路径、技能状态文件，每项可一键复制 |

总览页那条**记忆来源**分布条会写明 `MEMORY.md` / `USER.md` 各有多少条、谁写的、预算用到哪（如 `34 条 · 3492/3500`）。数字每次从磁盘重读，不是缓存。

**行开关**写回 profile 自己的 `cordis.patch.yml`。**技能开关**不是行开关：写进 `<profile>/hermes-bridge-skills.json`，skill provider 每次 `list()` 重读清单并调注册句柄的 `invalidate()` 丢掉目录缓存。

## 记忆的来源标记

`memory` 行只读，`memory-write` 行才写。两边写同一份文件，所以「这条是谁写的」必须能看出来：

```
[hermes] 打标之后 Hermes 自己写的
[dsh]    由 DSH 这边写的
（无前缀）打标之前写的，读回来显示成 [hermes?] —— 推断，不是记录在文件里的事实
```

**不回溯打标**：`MEMORY.md` 是硬字符预算，给历史条目补前缀会把对方写入的空间挤爆。老条目保持原样，只有新写的带前缀。

写入来源默认锁死为 `dsh`。模型不能自己要求写成 `hermes` —— 那等于允许它把自己的话伪装成另一个 agent 说的。要放开得显式设 `allowOriginOverride: true`。

## 配置参考

所有行都支持 `hermesHome` 覆盖，默认按 Hermes 自己的规则解析（`$HERMES_HOME` → Windows `%LOCALAPPDATA%\hermes` → `~/.hermes`）。写错键名会响亮报错并列出可接受的键，不会静默忽略。

```yaml
- id: hermes-bridge-persona
  config:
    file: SOUL.md          # 相对 hermesHome
    extraFiles: []         # 额外要拼进人设段的文件
    order: 5               # 系统提示词段顺序
    maxBytes: 32768
    header:                # 自定义段首说明

- id: hermes-bridge-memory
  config:
    dir: memories
    files: [MEMORY.md, USER.md]
    order: 6
    maxBytes: 32768
    withLabels: true       # 每段带「Agent notes / About the user」标签
    watch: true            # 文件变动后重读

- id: hermes-bridge-memory-write
  config:
    origin: dsh            # 新条目的来源标记
    allowOriginOverride: false
    readOnly: false

- id: hermes-bridge-skills
  config:
    dir: skills
    providerName: hermes   # 不能叫 runtime（注册表保留名）
    rank: 350              # 与 DSH 自带 provider 的优先级
    maxDepth: 4
    includePrefix: []      # 只收这些分类前缀，例如 [devops, productivity]
    excludePrefix: ['.', '_']
    maxSkills: 1000
    descriptionMaxChars: 900
    stateFile:             # 留空则按 profile 推导

- id: hermes-bridge-viking
  config:
    endpoint: http://127.0.0.1:1933
    account: default
    user: ''               # 你的租户名；留空 = 未配置，工具会提示
    agent: hermes
    apiKey:                # 服务器开了鉴权才需要
    timeoutMs: 30000
    recallLimit: 10
    scoreThreshold: 0.3
    enableRead: true       # viking_read
    enableBrowse: true     # viking_browse
    enableRemember: true   # viking_remember

- id: hermes-bridge-mcp
  config:
    warnOnDrift: true
    toolCallTimeoutMs: 180000
    # profile 一般不用写：运行时以 profileContext 为准

- id: hermes-bridge-hermes-data
  config: {}               # 只有 hermesHome
```

## CLI

```bash
# 体检：Hermes 文件、人设/记忆字节数、skills 发现结果、MCP 清单
dsh-hermes-bridge doctor [--json] [--profile desktop]

# 从 Hermes 的 config.yaml 生成 MCP 行，写进 profile 的 cordis.patch.yml
dsh-hermes-bridge mcp sync --profile <name> [--dry-run] [--timeout <ms>]

# 回退（移除受管区块，其余内容逐字不动）
dsh-hermes-bridge mcp clear --profile <name> [--dry-run]

# 列 skills
dsh-hermes-bridge skills [list] [--json] [--limit 200]

# 打印将被注入的记忆文本长度与文件状态
dsh-hermes-bridge memory

# 探测 Hermes 的记忆提供方：哪个后端、可用吗、暴露哪些工具
dsh-hermes-bridge provider [--provider <name>] [--json]
```

全局选项 `--hermes-home <path>`；环境变量 `HERMES_HOME`、`DSH_HOME`。

## 关掉某一行

三种办法，任选其一：

1. 设置页 / 插件页里该行旁边的开关
2. 在 profile 的 `cordis.patch.yml` 里加：
   ```yaml
   - id: hermes-bridge-skills
     disabled: true
   ```
3. 改本包 `cordis.patch.yml` 里的默认值（升级会被覆盖，只适合临时试）

注意 `hermes-bridge-host` 不要关也不要往里搬功能：DSH 把浏览器半身绑在 **specifier 是裸包名** 的那一行上（`exactPackageSpecifier()` 对子路径返回 `undefined`），没有它设置界面会静默消失；而一旦往那行挂功能，那个功能就再也关不掉了。

## 自动更新（`updater` 行）

这一份插件会定期问 GitHub 上有没有新版本，并在你点一下之后把它装进当前 profile。

### 它怎么判断「有没有新版」

读仓库里那份 `package.json` 的 `version`，和**正在跑的那份**比：

- 「正在跑的那份」不是从配置里读的，而是从模块自己的位置往上找 `package.json` ——
  插件可能被 `link:` 到工作副本、也可能被 pnpm 装进虚拟 store，只有模块自己知道
  现在执行的是哪一份代码。
- 版本比较是自己实现的（`<major>.<minor>.<patch>` + 预发布段），没有为了这个引
  semver 依赖。多一个运行依赖就多一份装不上的可能。
- 用 `raw.githubusercontent.com` 而不是 GitHub API：API 匿名调用 60 次/小时/IP，
  6 小时一次的检查迟早会撞上；raw 没有这个限制，拿到的就是仓库里的真实文件。
  带 `ETag`，命中 304 时连传输都省了。

### 先说一个坑：npm 上有同名的别人的包

`dsh-hermes-bridge` 这个名字在 npm 上属于另一个人（`xiaoyu7044` 的
`dual-agent-integration`，2026-10 还在发版）。本包只发布在 GitHub，**从没发布到
registry**。

这件事的直接后果：「按版本号从 registry 更新」会装进别人的代码，而且会成功、
版本号还比我们大，看起来完全像一次正常更新。所以更新只认「你现在是怎么装的」：

| 依赖写法 | 能更新吗 |
|---|---|
| `github:Loki-kiki/dsh-hermes-bridge` | ✅ 按同源重装，拉到最新提交 |
| `link:...` | ❌ 提示用 git 更新那个目录 |
| `file:...` | ❌ 提示直接改那个目录 |
| `^0.4.1`（semver，来自 registry） | ❌ **拒绝**，并说明那个包不是我们 |

界面会把「安装来源」单独列出来。如果这份不是从仓库装的，即使 GitHub 上版本更大
也只显示一行说明，不给更新按钮 —— 宁可不更新，也不能装错东西。

### 它怎么装

走 pnpm，和你在插件页点「安装」用的是同一个包管理器 —— 不是自己下载文件覆盖，
所以「更新」和「首次安装」的结果形态完全一致，不会出现两种安装方式产物不同的局面。

**但「同一个 pnpm」得自己找对。** 桌面版 DSH 的 pnpm 不在 `PATH` 上：它用
Electron 自己当 node 去跑自带的 `resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`。
插件里直接 `spawn('pnpm')` 会得到「不是内部或外部命令」—— 这不是环境没装好，
是找错了入口。所以先解析再调用，顺序是：

1. 行配置里的 `pnpm:`（你明确指定时）
2. DSH 自带的那份（从 `process.execPath` 反推安装目录）← 桌面版的常规情况
3. `PATH` 上的 `pnpm`（自建 `dsh web` / 装了全局版）

每一步都真的跑一次 `--version` 确认能用，而不是看文件存不存在 —— 见到文件但跑不
起来（权限、半截下载）比找不到更常见，那种报错会指向 pnpm 内部，看不出是入口错了。
解析结果会写进安装记录，失败时你能直接看到它用的是哪一份。

装什么，取决于**你这份是怎么装的**：

| 你现在这份 | 更新行为 |
|---|---|
| `^0.2.0`（从 npm / registry） | `pnpm add <name>@<新版>` |
| `github:...` / `git+...` | 按同一来源重装，拉到最新提交 |
| `link:E:/...`（指向工作副本） | **不动它**，并明确告诉你「用 git 更新那个目录」 |

最后一条是刻意的：对 `link:` 依赖跑 `pnpm add name@version` 会把链接替换成 registry
里的一份副本 —— 那等于悄悄毁掉开发者的工作回路，而它看起来还「更新成功」了。

### 「装好了」和「生效了」是两件事

装完会尝试用 DSH 自带的 HMR 现场重载模块。三种结果是分开报的：

```
已热重载，新的代码正在跑。                              ← 最好
已装好，但这次需要重启 DSH 才生效：<原因>                 ← 常见
安装失败：<pnpm 的真实报错>                              ← 有时
```

**为什么必须分开报**：HMR 依赖 ESM 模块缓存，打包过的 worker 里没有这个缓存，
这时它只能返回 `restart-required`。把这种情况说成「已更新」，用户就会以为新代码
在跑，实际还在跑旧的 —— 之后所有基于「我已经是最新版」的判断都会是错的。

### 检查失败不是错误

GitHub 在国内经常慢或不通。检查有超时、有缓存、失败只记成「现在不知道」，页面
照常工作，不会因此变成一个红框或者转不出来的加载态。

### 配置

```yaml
- id: hermes-bridge-updater
  name: dsh-hermes-bridge/updater
  config:
    repo: Loki-kiki/dsh-hermes-bridge   # 换成自己的 fork 就填 owner/name
    branch: main
    intervalHours: 6                    # 多久检查一次；最小 1 分钟
    autoCheck: true                     # 只读一个 JSON
    autoInstall: false                  # 装新代码 = 换掉正在跑的模块，默认交给人
    timeoutMs: 20000
    # pnpm: ''        # 留空 = 自动探测（DSH 自带的那份优先）
```

`autoInstall: true` 是给无人值守环境准备的。日常用建议留 `false`：一次自动安装
恰好赶上你正在等一个长回答，就会在中途换掉正在跑的代码。

### 手动验

```bash
# 只检查，不装
node -e "import('./lib/updater.js').then(async m => console.log(await m.fetchRemoteVersion(m.resolveConfig({}))))"
```

设置页「连接」页签的「插件更新」面板做同样的事，另外多一个安装按钮。

## 通用记忆提供方（`provider` 行）

`viking` 行是手写的 OpenViking 客户端——只覆盖 OpenViking 一家。Hermes 的记忆后端远不止它：内置的还有 `retaindb`、`byterover`，插件目录里还有 honcho、mem0、hindsight、supermemory、lancedb、cognee 等几十个，而且还在增加。

在 JS 里逐个重写它们的 REST / CLI 客户端是条死路：每家新后端、每个端点变更、每次 schema 调整都要跟着改一份 JS，一旦漏改，表现是**工具静默返回错东西**而不是报错。

所以 `provider` 行走的是反方向：**让 Hermes 自己的加载器当适配器**。

```
DSH  ──工具调用──▶  lib/py/provider_bridge.py  ──▶  Hermes 的 MemoryProvider
      ◀──JSON────                         （plugins.memory.load_memory_provider）
```

worker 做的事只有三件：读 Hermes 的 `memory.provider`、取那个 provider 的 `get_tool_schemas()`、把调用转发给 `handle_tool_call()`。于是：

- **零漂移**：后端换了端点，只在 Hermes 里改，桥接自动跟上；
- **零适配工作**：在 Hermes 里装了 honcho，这里就自动出现 honcho 的工具；
- **工具名一致**：模型看到的工具名就是 Hermes 用的那套，习惯可以迁移。

### 两行会不会打架

会重叠：`provider` 是 `openviking` 时，两边都想注册 `viking_*`。DSH 里**工具名重复是硬错误不是合并**（`tool "x" is already registered`），所以：

- `viking` 行先占住名字（patch 顺序在前）；
- `provider` 行跳过已被占用的名字，并在日志里报出跳过了几个；
- 想用 provider 自己的 schema（比如 `viking_search` 多了 `mode` 参数）就把 `viking` 行关掉。

`provider` 行**默认关闭**：它要起一个 Python 进程（Hermes 的 venv + agent 树），开着等于让所有人多付这份启动开销，而 OpenViking 用户已经有手写版了。用别的后端、或者想统一走 Hermes 官方实现时再打开。

### 用哪个 Python、哪个 agent 树

默认从 `hermesHome` 推导：`<hermesHome>/hermes-agent` 与它下面的 `venv`。Hermes 装在别处、或者用的不是自带 venv，就在行配置里指：

```yaml
- id: hermes-bridge-provider
  name: dsh-hermes-bridge/provider
  config:
    agentRoot: D:/tools/hermes/hermes-agent
    python: D:/tools/hermes/hermes-agent/venv/Scripts/python.exe
    provider: ''      # 留空 = 跟随 Hermes 的 memory.provider
```

不写也能跑，这是刻意的：**陌生人装完不该先编辑配置文件**。

### 怎么自己验

```bash
dsh-hermes-bridge provider            # 人读：哪个后端、可用吗、暴露哪些工具
dsh-hermes-bridge provider --json     # 脚本读
dsh-hermes-bridge provider --provider retaindb   # 试一个 Hermes 没在用的后端
```

退出码 `0` 只在「后端可用」时给；`ok` 只表示 worker 答话了，`available` 才表示后端能服务调用——这两个别混。

## 两套记忆不是一回事

| | 内置记忆（`memory` 行） | OpenViking（`viking` 行） |
|---|---|---|
| 存储 | `MEMORY.md` / `USER.md` 纯文本 | 向量库 + 分层上下文（L0/L1/L2） |
| 进上下文方式 | 每次请求整段注入 | 模型主动 `viking_search` 才看得到 |
| 谁写 | memory 工具 | 自动抽取 + `viking_remember` |
| 空转成本 | 固定 token | 零 |

OpenViking 只有在 Hermes 侧 `memory.provider: openviking` 且对应 provider 插件没被 `plugins.disabled` 挡住时才真正参与。改完用 `test/viking-probe.mjs` 验，别靠感觉。

## 设计说明

- **为什么自动安装默认关**：更新会替换正在运行的模块。默认开着意味着「某个我正在等回答的时刻，代码被换掉了」。检查是只读的，所以默认开。
- **为什么更新走 pnpm 而不是下载覆盖**：两种安装方式会得到两种产物。更新和首次安装必须是同一条路径，否则「更新过的人」和「刚装的人」跑的其实是两种东西，而出现问题时无法互相复现。
- **为什么热重载失败必须明说**：HMR 依赖 ESM 模块缓存；打包 worker 里没有这个缓存，只能返回 `restart-required`。把这种情况说成已更新，之后所有「我已经是最新版」的判断都是错的，而且无从发现。
- **为什么记忆提供方不逐个重写**：Hermes 的 provider 是同一套 Python 契约（`get_tool_schemas()` + `handle_tool_call()`），内置 3 个、插件目录里还有几十个，并且还在增加。逐个写 JS 客户端等于永远追不上，端点一变就静默返回错东西。改成「让 Hermes 自己的加载器当适配器」后，新后端零改动可用。代价是一个 Python 子进程，懒启动、超时即杀、行卸载时关掉。
- **worker 的 stdout 就是协议**：`provider_bridge.py` 先把 fd 1 dup 走，再把 fd 1 指向 fd 2。否则 provider 里任何 `print`（或它加载的原生库）都会污染协议，表现是「偶尔一次调用失败、重试又好了」。
- **为什么 cron / 会话历史只读**：往 Hermes 的 cron 写必须过它的 gateway，两套调度器共管一个 `jobs.json`，结果只会是重复触发或者永不触发。只读能让「我那些定时任务还活着吗」不必切回 Hermes。
- **为什么 MCP 不在这里自己连**：DSH 每个 MCP 服务器一条 `dsh-mcp-client` 行，行住在 profile patch 里才能逐台开关、在插件页可见。插件只负责对账与生成行。
- **为什么 skills 要自己写 provider**：DSH 自带的 `dsh-skill-filesystem` 只认 `<root>/<name>/SKILL.md` 一层，Hermes 的 skill 是按分类嵌套的，直接把根指过去一个都发现不了。
- **启动永不抛错**：Hermes 没装、OpenViking 没起、路径配错，都只影响对应行，并在调用时给出明确错误，不拖垮 profile。
- **启动不写配置**：启动时改自己的配置文件会让 harness 在启动过程中重载自己，那正是「第一次能跑、第二次就坏」这类 bug 的产地。

## 给插件作者的一个坑

`ctx.tools.register()` 收的是**已经转好的 JSON Schema**。DSL 简写（`{ type: 'string', required: true }`）只会被 `defineTool()` 展开，而 bundle 插件不能 import `@deepseek-ai/*` 的值（loader 才提供那些名字）。所以 `lib/schema.js` 自带一份同样的转换：

```js
import { defineTool } from './schema.js'

tools.push(defineTool({
  name, description,
  parameters: { q: { type: 'string', required: true, description: '查询词' } },
  execute,
}))
```

漏掉这一步的报错长这样：

```
INVALID_REQUEST: Invalid schema for function 'xxx':
schema must be a JSON Schema of 'type: "object"', got 'type: null'
```

另外 patch 里出现的每个 `name: '<pkg>/<subpath>'` 都必须在 `package.json` 的 `exports` 里声明，否则那一行静默不激活（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。

## 开发与测试

先在克隆目录装依赖（`yaml` 是运行依赖，不装 `settings`/`splice` 会直接 `ERR_MODULE_NOT_FOUND`）：

```bash
npm install
npm test    # 离线测试，任何机器都能跑
```

也可以单独跑：

```bash
node test/splice.mjs         # 受管区块拼接
node test/memory-store.mjs   # 记忆文件读写（CRLF / 并发 / 来源标记 / 预算）
node test/schema.mjs         # DSL → JSON Schema 转换
node test/settings.mjs       # 设置页后端：配置写入、探测、行开关、技能清单
node test/provider.mjs       # 通用 provider 行（离线 9 条；--live 再跑 11 条真后端）
node test/updater.mjs        # 更新器（版本比较 / 配置 / 网络失败 / 编码 / link: 保护）
node test/client-render.mjs  # 把 client.js 按宿主的方式加载并渲染每个页签

# 下面这些要读真实 Hermes 数据，默认跳过：
npm run test:live   # cron 与 session 库、memory 工具端到端、真 provider 的 11 条

# OpenViking 探针（打真服务器，必须给租户名）：
VIKING_USER=<你的租户名> node test/viking-probe.mjs --endpoint http://127.0.0.1:1933

# 装配树探针：确认某行真的进了 DSH 的 compose 结果
DSH_ASAR_ROOT="<app>/resources/app.asar/dsh/node_modules/@deepseek-ai" \
  ELECTRON_RUN_AS_NODE=1 "<app>/<exe>" test/probe-compose.cjs <profileDir> [rowId]
```

README 里的图标与示意图都是生成的，改了样式请重新生成（脚本自带像素级自校验）：

```bash
python docs/images/build-diagrams.py
```

`build-diagrams.py` 同时生成包根的 `icon.svg`（插件页图标）。它和 README 图标共用一套几何，但去掉了深色底板、加粗了笔画——DSH 用 30px 渲染行内图标、36px 渲染卡片图标，带底板的 tile 在那个尺寸下会糊成一坨。生成后跑一次像素级验证：

```bash
npm run test:icon    # 需要 sharp（devDependency）：对称性 / 连通 / 轴心 / 出血
npm run test:meta    # 按 DSH 自己的 iconOf() 规则验一遍：相对路径 / 包内 / 格式 / 256 KiB / 导出
```

## 插件页的标题、描述与图标

DSH 的插件管理器在不激活插件的前提下读取展示元信息（依据其自带 `cordis-plugin-development` skill 的 `references/host-plugin.md`）：

| 文件 | 作用 |
|---|---|
| `icon.svg`（包根） | 插件页图标，`package.json` 的 `icon` 字段指向它；SVG/PNG/JPEG/WebP，≤256 KiB，必须在包内 |
| `locale/zh.json` · `locale/en.json` | `meta.title` / `meta.description`，按界面语言显示 |

两者都要出现在 `package.json` 的 `exports` 与 `files` 里（`./icon`、`./locale/*.json`），否则打包时会丢。缺图时插件页显示默认占位图，缺 locale 时回退包名与 `description`。

> 图标用的是透明底的 36×36 字形，不是 README 里那张带深色底板的 256px 图 —— 后者在 30px 的行内位置会变成一块黑方砖。

本地开发安装：把本目录 junction 到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-hermes-bridge`，或在 profile 的 `package.json` 里用 `link:` 依赖。

## 许可

MIT
