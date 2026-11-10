# 多端 AI 私人助手（Telegram / 飞书 / 安卓 + OpenCode & Agent CLI）

把 Telegram、飞书与安卓 App 接到本地 `opencode serve` 和主流 Agent CLI 上的私人 AI 助手。三个控制端共用同一套命令、会话队列、提醒、定时任务和运维能力。Git 部署的安装、运行、更新和卸载统一由 `npm run bot -- <command>` 管理。

## 控制端与架构

| 控制端 | 接入方式 | 网络要求 | 能力概览 |
| --- | --- | --- | --- |
| Telegram | Bot API 长轮询 | 无需公网地址 | 命令、内联按钮、附件、提醒、定时任务与运维 |
| 飞书 | 自建应用长连接；卡片按钮另需回调 | 文字命令无需公网；面板按钮需公网 HTTPS | 命令、附件、提醒、定时任务与运维和 Telegram 一致；按钮依赖回调 |
| 安卓 App | `/api/v1` + SSE | API 必须从手机可达 | 原生聊天、附件、任务队列、模型与运维界面 |

```text
Telegram  ── Bot API 长轮询 ────┐
飞书      ── 开放平台长连接 ────┼── Agent Bot ──┬── opencode serve ── 模型 / 工具
安卓 App  ── HTTP API /api/v1 ──┘               └── Agent CLI ─────── Claude Code / Codex / Gemini / Qwen / Qoder …
```

> 安卓 App 的构建与连接见 [`android/README.md`](android/README.md)。版本变更见 [`CHANGELOG.md`](CHANGELOG.md)，持续迭代的台账见 [`ITERATIONS.md`](ITERATIONS.md)，深度审查记录见 [`DEEP-100.md`](DEEP-100.md)，分层与模块边界见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

**快速导航**：[一键安装](#一键安装推荐) · [快速开始](#快速开始) · [功能](#功能) · [命令](#命令) · [安卓 App](#第-4-步安卓-app可选) · [Instabox 云电脑教程](#instabox-云电脑部署安卓连接示例) · [HTTP API](#http-apiapiv1) · [配置](#配置) · [运行](#运行) · [更新与迁移](#更新与迁移) · [聊天运维](#聊天运维中心) · [故障排查](#超时与错误) · [安全](#安全说明)

## 一键安装（推荐）

`install.sh` 会完成「检查环境 → 获取代码 → 安装依赖 → 构建 → 准备 `.env` → 配置控制端 → 检测/安装可选工具」，适合新服务器首次部署，也适合本地已经克隆仓库后直接安装。交互式终端中可以选择 Telegram、安卓 App、飞书中的一个或多个，随后按编号安装 Agent CLI、magpie 和 cc-switch；安装完成后也可随时运行 `npm run clients` 增补其他控制端。

安装过程中还会自动检测 Claude Code、Codex、Gemini、Qwen 等 Agent CLI，以及 magpie 和 cc-switch。交互终端会列出未安装项，可按编号多选安装；非交互安装只做检测，不会在无人值守时下载第三方二进制。之后可随时运行 `npm run setup:tools` 重新检测或安装。

### 前置条件

- Linux / macOS
- **Node.js ≥ 20.18.1**、`npm`、`git`
- **至少配置一个控制端**（三选一，可同时启用）：
  - Telegram：一个 Bot Token（在 [@BotFather](https://t.me/BotFather) 发送 `/newbot` 获取）
  - 飞书：企业自建应用的 `App ID`、`App Secret` 与至少一个 `open_id` 白名单
  - 安卓 App：手机可达的 API 地址（局域网 IP、反向代理域名、SSH 隧道或 VPN），以及一个 API Token
- 可选：`opencode` CLI。脚本默认会尝试 `npm install -g opencode-ai`，失败时只提示，不阻断安装
- 可选：Agent CLI、magpie、cc-switch。安装时会检测并询问；工具安装失败只提示，不阻断 Bot 部署

### 方式一：新机器一键克隆安装

```bash
curl -fsSL https://raw.githubusercontent.com/longtimex/agent-bot/main/install.sh | sh
```

默认安装到 `~/.agent-bot`，使用 `main` 分支。安装完成后执行：

```bash
cd ~/.agent-bot
npm run setup      # 选择控制端，然后选择要安装的 Agent CLI / magpie / cc-switch
npm run bot -- start   # 启动 Bot（默认同时启动本机 opencode），日志见 data/bot.log
```

生命周期统一由 `npm run bot -- <command>` 管理。旧命令 `npm run restart`、`scripts/restart.sh` 与 `scripts/apply-release.sh` 仍然可用，但都委托到同一个实现。

> `curl | sh` 的 stdin 不是终端，脚本不会自动进入配置向导；安装后执行一次 `npm run setup` 即可。已有某个控制端时，`npm run clients` 可继续添加其他控制端，不会覆盖已有配置，也不会进入工具安装。

### 方式二：已经克隆仓库

```bash
git clone https://github.com/longtimex/agent-bot.git
cd agent-bot
./install.sh
```

脚本会自动识别当前 checkout，不会重复克隆。交互式终端下会打开控制端配置向导；即使已经配置了某个控制端，也会打开带 `[已配置]` / `[未配置]` 状态的菜单，可继续添加、修改，或直接回车退出。只使用容器、CI 等非交互环境时，可先用 `--no-setup` 跳过，再手动编辑 `.env`。

### 方式三：指定目录并安装后启动

```bash
./install.sh --dir /opt/agent-bot --start
```

`--start` 会在安装成功后执行 `npm run bot -- start`。如果还没有配置任何可用的控制端，脚本会拒绝启动，并提示先运行 `npm run setup`。

### 常用参数

```text
--dir DIR          安装目录（默认：当前 checkout 或 ~/.agent-bot）
--repo URL         git 仓库地址（默认：https://github.com/longtimex/agent-bot.git）
--branch NAME      安装分支（默认：main）
--local            强制使用当前 checkout
--no-opencode      不安装 opencode CLI
--setup            即使已有控制端，也打开配置向导（增补/修改）
--no-setup         不运行控制端配置向导
--tools            检测并询问安装 Agent CLI / magpie / cc-switch
--check-tools      只检测 Agent CLI / magpie / cc-switch，不安装
--no-tools         跳过工具检测与安装
--start            安装完成后启动 Bot
--systemd          生成并启用 systemd 系统服务（Bot + 本机 OpenCode）
--user-systemd     生成并启用当前用户的 systemd 服务
--skip-deps        复用已安装的 node_modules
--skip-build       复用已有 dist/ 构建产物
--uninstall        停止服务并删除 launcher/unit，保留 data 与 .env
--purge-data       与 --uninstall 一起使用：同时删除 data/ 与 .env
--yes              卸载时跳过确认
--dry-run          只打印将执行的步骤，不修改文件
-h, --help         查看帮助
```

对应环境变量：

```text
AGENT_BOT_DIR
AGENT_BOT_REPO
AGENT_BOT_BRANCH
AGENT_BOT_OPENCODE=0
AGENT_BOT_SETUP=0     # 跳过控制端向导；设为 1 可强制打开
AGENT_BOT_TOOLS=auto  # auto / check / 1 / 0；非交互环境默认 check
AGENT_BOT_SYSTEMD=0    # 0 / 1 / user；等价于 --systemd 或 --user-systemd
AGENT_BOT_START=0      # 设为 1 等价于 --start
AGENT_BOT_SKIP_DEPS=0  # 设为 1 等价于 --skip-deps
AGENT_BOT_SKIP_BUILD=0 # 设为 1 等价于 --skip-build
```

例如安装到自定义目录并跳过 opencode：

```bash
./install.sh --dir /opt/agent-bot --no-opencode
```

或者：

```bash
AGENT_BOT_DIR=/opt/agent-bot AGENT_BOT_OPENCODE=0 ./install.sh
```

### 脚本会做什么

1. 检查 `git`、`node`、`npm`，并校验 Node.js ≥ 20.18.1
2. 使用当前 checkout，或按 `--repo` / `--branch` 克隆到安装目录
3. 执行 `npm ci`（没有 lockfile 时执行 `npm install`）
4. 执行 `npm run build`
5. 创建 `data/`、`data/inbox/`、`data/outbox/`
6. 缺少 `.env` 时从 `.env.example` 生成，并设置为 `600` 权限
7. 可选安装 `opencode-ai`
8. 使用 `--systemd` / `--user-systemd` 时生成并启用 Bot 与 OpenCode unit
9. 使用 `--uninstall` 时进入安全卸载流程
10. 自动检测 Agent CLI、magpie、cc-switch；交互终端按编号选择安装，非交互环境只检测
11. 交互式终端下执行 `npm run setup`，配置 Telegram / 安卓 App / 飞书，然后选择安装 Agent CLI / magpie / cc-switch；已有控制端时可继续添加
12. 可选执行 `npm run bot -- start`

### 安全与幂等说明

- 向导不会在配置文件外保存 Token / API Key；除安卓配对所需的新 `API_TOKEN` 会完整显示一次外，其余凭据只显示掩码
- 已存在的 `.env` 不会被覆盖
- 已有 git 工作区存在未提交改动时，不会强制更新或重置
- 重复执行安装脚本是安全的：依赖会重新安装、构建会重新执行，但 `.env` 与 `data/` 会保留
- 安装目录需要写权限；脚本不会自动使用 `sudo`

安装完成后，在 Telegram 或飞书里给 Bot 发送 `/start`，安卓 App 用向导输出的地址与令牌配对即可开始使用。长期运行建议参考「systemd 常驻（可选）」，后续升级见「更新与迁移」。

## 功能

- **Telegram 官方 Bot**：长轮询，无需公网地址，无需扫码。
- **飞书自建应用 Bot**：通过长连接接收私聊消息，无需公网地址；命令、面板、附件、提醒、定时任务、运维与访问控制与 Telegram 端完全共用。面板按钮需要可选的公网 HTTP 卡片回调（飞书 SDK 长连接不分发卡片回调），不启用时文字命令仍可用。飞书单聊中 @ 机器人或直接发命令均可；群聊默认忽略。
- **安卓 App**：Grok 风格的原生客户端（聊天与可选中复制的 Markdown、代码块/整条回复复制、全屏看图、会话内搜索、输入框 `/` 快捷命令、拍照与相册/视频/文件附件、语音消息、单条消息临时换引擎、图片/视频/语音回复查看、附件回显、系统分享导入、实时进度与失败重试、后台通知、任务队列、引擎/模型切换、工作目录、时区、历史、提醒、定时任务、状态统计），通过内置 HTTP API 控制同一台 bot；详见 `android/README.md`。
- **HTTP API**：`/api/v1` 提供 Bearer Token 鉴权的任务提交、引擎/模型切换、工作目录/时区调整、提醒/定时任务管理、运维诊断与日志查看，供 App 或任意脚本调用；Telegram 或飞书聊天里发 `/api` 查看配对信息。
- **多引擎切换**：`/agent opencode`（多模型、工具调用）与 Claude Code、Codex、Gemini、Qwen、Qoder、Cursor、Copilot、Aider、Goose、Amp、Droid 等 14 种主流 Linux Agent CLI；可用 `data/agents.json` 接入任意私有 CLI。
- **自动检测与安装**：首次启动扫描 `PATH`，`/start`、`/agent`、`/agents` 都会展示本机已安装的 CLI；可在聊天中通过 `/agents install <id>` 用 npm/pip 安装新 CLI，`/agents update <id>` 原地升级、`/agents uninstall <id>` 卸载由 Bot 安装的版本。默认推荐使用 OpenCode。
- **多模型切换**：Claude Sonnet/Opus、Gemini 3.8/4、Grok 4.7、GPT OSS、DeepSeek、GLM、MiMo、Nemotron 等。
- **cc-switch 集成**：`/cc` 面板与 `/cc <分组>` / `/cc run` 覆盖 Provider、MCP、提示词、技能、配置、代理、故障转移、会话、认证、守护进程等全部非交互命令；危险操作先确认，输出自动脱敏。
- **magpie 集成**：`/magpie` 面板与 `/magpie <命令>` 管理 magpie 模型网关（Provider、各 Agent 的模型、路由组、配额、用量、守护进程），`/magpie run` 透传非交互命令；危险操作先确认，密钥与 Token 自动打码，并提供 `/api/v1/magpie/*` 给脚本与后续 App 面板使用。
- **模型管理**：`/cc model` 或 `npm run models` 为 Bot 与其他 agent 添加/删除模型、同步 `opencode.json`、指定 agent 模型，改动无需重启。
- **聊天运维中心**：`/ops` 提供系统诊断、日志查看、项目更新、Bot 重启、OpenCode 服务启停、cc-switch 安装/更新与非密钥配置修改，Telegram 与飞书均可使用；首次部署之外几乎无需再登录服务器。面板上的「🔍 检查更新」会拉取远端并列出落后提交（干跑，不改动本地代码），确认无误再点「⬆️ 更新项目」。
- **交互面板**：`/start`、`/agent`、`/model`、`/dir`、`/access`、`/reminders`、`/schedule`、`/proxy`、`/usage`、`/ops` 均带内联按钮，可直接点选切换引擎/模型、设置工作目录、增删访问白名单、暂停任务、取消提醒或操作代理。
- **实时进度**：处理时间超过 2 秒后显示进度卡片（带「停止任务」按钮），Telegram 还会持续发送 typing 状态。卡片被限流时会自动退避而不是每 2 秒重试，状态没有变化时也最多每 30 秒刷新一次，避免长任务耗尽渠道的编辑额度。
- **重试与队列**：失败消息附带的「重试」按钮只重发**它那一条**任务（不会被之后的新消息顶掉）；`/retry` 重发上一条任务，但若中途发过 `/stop`，排队的 `/retry` 会一起作废，不会把已取消的活儿再跑一遍；`/queue` 可逐条取消或一键清空排队消息。
- **命令自动补全**：启动时注册 Telegram 的 `/` 菜单（`src/help.ts` 的 `BOT_MENU_COMMANDS`，与等价写法 `BOT_COMMAND_ALIASES` 一起通过 `GET /help` 下发给安卓 App），输入 `/` 即可看到全部命令与说明；测试会校验菜单与 `/help full` 保持一致，并校验 App 的命令表覆盖同样的命令。
- **网络代理**：聊天内添加 HTTP/HTTPS/SOCKS4/SOCKS5 代理，自动测试连通性，可启用、停用、删除；远程媒体、Agent CLI 子进程与 Agent 网络命令自动使用。
- **附件接收**：可直接发送图片、视频、文件、语音；文本/代码文件会读取内容，图片/视频/PDF/音频按当前模型能力附加，MIME 缺失时按扩展名识别。
- **原生附件**：模型通过 `[[image:...]]` 等指令发送图片、视频、语音、文档。
- **白名单**：Telegram 数字用户 ID 与飞书 `open_id` 各自独立；任一控制端启用时必须配置对应白名单（或显式 allow-all），日常增删用 `/access`，立即生效且不会把自己移出。
- **仅私聊**：只响应私聊消息，群组/频道消息直接忽略，避免误触发。
- **提醒稍后提醒**：一次性提醒触发时附带「10分钟 / 1小时 / 明天」按钮，一键延后
- **定时提醒**：`/remind 30m 喝水` 即可设置；支持重复提醒（`every 30m`、`每5分钟`、`每天 08:30`）与中文口语时间（`5分钟后`、`下午3点`、`今晚8点半`、`后天 09:00`）；保存在 `data/reminders.json`，重启后仍然有效。
- **时区可在线切换**：`/timezone` 或 `/timezone Asia/Tokyo` 立即改变提醒、定时任务与每日统计所用的时区，并写入 `.env`（`REMINDER_TIMEZONE`），无需重启。
- **定时 AI 任务**：`/schedule add 每天 09:00 检查服务器` 到点自动调用 AI 执行提示词并回传结果；支持一次性与重复任务、指定引擎/模型、暂停/恢复/删除、立即运行一次，保存在 `data/schedules.json`。
- **使用统计**：`/usage` 查看任务量、成功率、平均耗时、今日任务、近 7 天趋势与引擎分布，持久化到 `data/usage.json`；面板上的「📩 每日报告」可随时生成汇总，开启 `USAGE_DAILY_REPORT` 后每天到点自动向白名单第一位用户推送一份。
- **任务历史**：`/history` 查看最近任务（提示词摘要、引擎/模型、耗时、结果、是否定时），每聊天保留 50 条，可一键清空，持久化到 `data/history.json`。
- **任务取消**：`/stop` 可立即终止正在执行的 OpenCode / Agent CLI 任务，并清空排队中的提示。
- **单实例**：`data/bot.lock` 防止重复启动；异常退出后残留的锁会被自动回收。
- **会话持久化**：`data/sessions.json` 保存会话 ID、引擎与模型偏好，重启后自动恢复。
- **启动通知**：每次成功上线（含 `/restart`、服务器重启后）自动向白名单第一位用户发送一条「✅ Bot 已上线」通知，附版本号与 OpenCode 服务可达性，`STARTUP_NOTICE=0` 关闭。
- **Docker 部署**：提供 Dockerfile 与 docker-compose.yml，一条 `docker compose up -d` 即可同时拉起 opencode 服务与 Bot，`data/` 与 `.env` 挂载持久化。

## 快速开始

新用户按以下 5 步即可从零跑通。首次部署优先使用上方的一键安装；已经克隆仓库时，从第 2 步开始即可。

### 第 1 步：准备

- 一台 Linux / macOS 机器（本机或云服务器均可），已安装 **Node.js ≥ 20.18.1**（`node -v` 查看）。
- 安装 OpenCode CLI：`npm install -g opencode-ai`；其余 Agent CLI 之后可在聊天里一键安装。
- 选择控制端：Telegram 在 [@BotFather](https://t.me/BotFather) 发送 `/newbot` 创建 Bot；飞书按「[飞书接入](#飞书接入)」创建企业自建应用；安卓 App 按「[第 4 步](#第-4-步安卓-app可选)」准备手机可达的 API 地址。至少配置一个，也可以同时启用。
- 可选：准备好模型 API Key（如 `GROK_API_KEY`），稍后填入 `.env`。

### 第 2 步：安装与启动

```bash
./install.sh --start   # 已克隆仓库；新机器用上方 curl 方式获取代码
npm run bot -- status  # 查看配置状态、PID、release 与日志路径
```

首次启动且 `.env` 缺少任何控制端配置时，终端会自动进入控制端选择菜单；也可以随时运行 `npm run setup`。向导支持 Telegram、安卓 App、飞书，多选时按顺序完成各项配置，并在每项完成后立即写入 `.env`；未选中的控制端、其他配置与注释保持不变。详见「[运行](#运行)」与「[首次连接引导](#首次连接引导)」。

需要手动安装依赖或修改源码时，再使用 `npm ci && npm run build`；安装完成后用 `npm run bot -- start` 启动。完整参数见「[一键安装（推荐）](#一键安装推荐)」。

> 更喜欢容器部署？见「运行 → Docker 部署（可选）」，`docker compose up -d --build` 一条命令拉起全部服务。

### 第 3 步：在 Telegram 或飞书里开始使用

在 Telegram 或飞书找到你的 Bot，发送 `/start` 即可看到当前引擎 / 模型与功能菜单。飞书未启用卡片回调时，文字命令仍完整可用。日常最常用的操作：

| 想做什么 | 怎么做 |
| --- | --- |
| 和 AI 对话、派任务 | 直接发文字；超过 2 秒的任务会出现进度卡片，可点「停止任务」 |
| 发图片 / 视频 / 文件 / 语音 | 直接作为附件发送，可附一句说明当作提示词 |
| 让 AI 产出图片 / 视频 / 文件 | 直接提要求，结果以原生消息回传（图片直接显示，语音/视频可在 App 内播放，文件可下载） |
| 切换引擎 / 模型 | `/agent`、`/model`，都有按钮面板 |
| 换个项目目录 | `/dir /path/to/project` |
| 定时提醒 | `/remind 30m 喝水`、`/remind 每天 08:30 打卡` |
| 定时让 AI 干活 | `/schedule add 每天 09:00 生成日报` |
| 看用量 / 生成报告 | `/usage`、`/report` |
| 新开会话 / 停止任务 | `/new`、`/stop` |
| 忘了命令 | 输入 `/` 看自动补全菜单，或 `/help` 分类速览 |

完整命令表见「[命令](#命令)」。

### 第 4 步：安卓 App（可选）

#### 直接下载

从 [GitHub Releases](https://github.com/longtimex/agent-bot/releases) 下载最新的 `android-v*` 版本：`agent-bot-vX.Y.Z.apk` 与同名 `.sha256`。下载后先校验再安装（示例为当前版本 `1.1.1`）：

```bash
tag=android-v1.1.1                  # 换成实际版本
base="https://github.com/longtimex/agent-bot/releases/download/$tag"
curl -L -O "$base/agent-bot-v1.1.1.apk"
curl -L -O "$base/agent-bot-v1.1.1.apk.sha256"
sha256sum -c agent-bot-v1.1.1.apk.sha256
```

- 请使用 Release 中带版本号的最新 APK；不要使用未在 Releases 页面发布的早期内部构建。当前 `android-v1.1.1` 已修复明文 HTTP、代理重连、附件内存、加密切换与时间显示等问题。
- `android-v1.1.0` 起由 CI 使用稳定的正式 release keystore 签名；同一签名身份的后续版本可覆盖升级，已保存的地址、令牌与配对密钥会保留。首次安装需允许「安装未知来源应用」。
- 早期 debug 签名包与正式签名包不是同一签名身份，Android 不允许直接覆盖。从 debug 包切换到正式包必须先卸载旧版，App 本地聊天记录、草稿、设置和配对信息会一并清除，之后重新扫码配对；之后同一正式 keystore 的升级不再需要卸载。
- 完整发版说明、构建检查与历史问题见 [`android/README.md`](android/README.md)、[`CHANGELOG.md`](CHANGELOG.md) 与对应的 GitHub Release。

#### 从源码构建

要求 JDK 17 与 Android Studio（或 Gradle 8.9+）。正式可安装包必须使用 release keystore 签名；没有签名配置时 `assembleRelease` 会产出未签名包，不能作为在线更新包发布：

```bash
cd android
export ANDROID_KEYSTORE_PATH=/absolute/path/to/release.jks
export ANDROID_KEYSTORE_PASSWORD='...'
export ANDROID_KEY_ALIAS='...'
export ANDROID_KEY_PASSWORD='...'
./gradlew assembleRelease               # 产物：app/build/outputs/apk/release/app-release.apk
```

> 仓库未提交 `gradlew` 包装器：用 Android Studio 打开会自动生成，或先执行 `gradle wrapper --gradle-version 8.9`。

也可在 `android/keystore.properties` 写 `storeFile`、`storePassword`、`keyAlias`、`keyPassword`（相对路径以 `android/` 为基准），该文件不得提交。构建后必须用 `apksigner verify --print-certs` 校验；完整参数、CI Secrets 与 `debug → release` 迁移见 [`android/README.md`](android/README.md)。

#### 配对手机

在 Telegram 或飞书向 Bot 发送 `/api`，在 App「设置」页扫码（或手动填地址与令牌）即可配对，手机与聊天端可同时使用。API 默认只监听 `127.0.0.1:3080`：先在 `.env` 设置 `API_PUBLIC_URL`（手机真能访问的地址，如 `http://192.168.1.10:3080` 或反向代理的 `https://bot.example.com`）并重启，`/api` 的二维码才可扫码直连；公网暴露请按 [`android/README.md`](android/README.md) 配置反向代理 / SSH 隧道 / VPN。

装 APK 之前先用 `npm run smoke:app -- --base http://<服务器地址>:3080 --token <API_TOKEN>`（启用了消息级加密就再加 `--enc <二维码里的 enc 字段>`）把手机会走的顺序跑一遍：连接与版本、十个只读端点、提交对话、附件、SSE 推送、停止自己的任务，逐项打印 ✅/❌ 与失败原因。它只读、只提交自己的任务、只停自己的任务，不会改引擎、工作目录或别人的队列；引擎本身不可用会记为 ⚠️ 提醒而不是失败，因为这一步查的是链路而不是 Agent。这套顺序也已经进了 `npm run check`：测试用桩引擎在随机端口起一个真的 Bot，再把脚本当外部进程跑一遍（16 步、SSE 收到终态、停止命中还在跑的任务都要断言），所以脚本一旦与接口走样，CI 立刻红，不用等到手机上才暴露。

#### Instabox 云电脑部署安卓连接示例

下面以 Instabox 的 Linux 云电脑为例，从空机器一直走到手机上能聊天。核心原则只有一条：**云电脑上的 `127.0.0.1:3080` 只属于云电脑本身，手机必须通过一个手机可达的 HTTPS 地址才能访问它。** 先在 Instabox 的终端执行 `cat ~/MACHINE.md`，确认机器没有公网入站端口，并查看它是否提供端口发布能力。

##### 1. 在 Instabox 上安装 Bot

```bash
cd /data/workspace/project/agent-bot   # 换成你的实际目录
npm ci
npm run build
```

先不要启动只配置了安卓端的 Bot：此时还没有手机可达的 `API_PUBLIC_URL`，Bot 会拒绝启动。先做第 2 步拿到入口地址，再写配置并首次启动。

##### 2. 选一种手机可达的入口

先拿到手机能访问的地址，再把地址交给 Bot；否则 Bot 没有可发布的配对地址。

| 方案 | 适合场景 | 地址形式 | 注意 |
| --- | --- | --- | --- |
| **Instabox 端口发布（首选）** | 当前这台 Instabox 支持 `instabox-port` | `https://<端口>-<机器ID>.instabox.tech` | 最简单；公开端口对互联网开放，必须保留 Bearer Token，建议开启消息加密 |
| **Cloudflare 临时隧道** | Instabox 没有端口发布，或需要自定义域名 | `https://<随机名>.trycloudflare.com` | 无需公网 IP；临时隧道重启后域名会变化 |
| **Tailscale** | 长期使用、只让自己手机访问 | `http://100.x.y.z:3080` | 手机与云电脑登录同一 tailnet；不会把 API 暴露给公网 |
| **反向代理 / 自有域名** | 已有域名和证书 | `https://bot.example.com` | 需要自己维护 Nginx/Caddy、证书和 DNS |

> 手机上的 `127.0.0.1` 永远指向手机自己，不是 Instabox。只有通过 USB 调试执行 `adb reverse tcp:3080 tcp:3080` 时，这个回环地址才成立；Wi-Fi 或移动网络下必须使用上表中的隧道/VPN 地址。

##### 3. 方案 A：用 Instabox 原生端口发布（推荐）

先发布 3080 端口，再把本地 API 启动到这个端口上：

```bash
instabox-port publish 3080 --name agent-bot
```

终端会打印一个 `https://3080-<机器ID>.instabox.tech` 形式的地址。把它写进 `.env`：

```dotenv
API_ENABLED=1
API_BIND=127.0.0.1
API_PORT=3080
API_PUBLIC_URL=https://3080-<机器ID>.instabox.tech
API_TOKEN=
API_ENCRYPTION=1
```

`API_TOKEN` 留空时，首次启动会自动生成并保存到 `data/api-token.json`。现在启动 Bot：

```bash
npm run bot -- start
npm run bot -- status
npm run bot -- doctor
```

如果之前已经启动过 Bot，改成 `npm run bot -- restart`。也可以等拿到公网 URL 后运行 `npm run setup` 选择安卓 App，让向导生成 Token 并写入同样的四项配置；随后再把 `API_ENCRYPTION=1` 写入 `.env` 并重启。

**安全提醒**：`instabox-port publish` 默认是公开端口，任何拿到 URL 的人都能访问 API。Bot 自身仍会校验 Bearer Token，但请同时开启 `API_ENCRYPTION=1`，不要把地址和令牌贴到公开聊天。不要用 `--private`：它的 `_token` 查询参数只适合浏览器打开根页面，无法可靠附加到 App 的所有 `/api/v1` 请求上。

端口发布的 URL 只在云电脑运行期间有效；暂停/停止机器或取消发布后，手机就会连不上。重新发布后如果域名或端口变了，必须同步更新 `API_PUBLIC_URL`、重启 Bot，并在 App 里重新配对。

##### 4. 方案 B：Cloudflare 临时隧道（备选）

云电脑没有 `instabox-port` 时，可以安装 `cloudflared` 后运行：

```bash
cloudflared tunnel --url http://127.0.0.1:3080
```

输出中的 `https://<随机名>.trycloudflare.com` 就是手机要填的地址。把它写入：

```dotenv
API_ENABLED=1
API_BIND=127.0.0.1
API_PORT=3080
API_PUBLIC_URL=https://<随机名>.trycloudflare.com
API_ENCRYPTION=1
```

然后执行 `npm run bot -- restart`（首次则 `npm run bot -- start`）。临时隧道的域名每次重启都会变化，适合验证和临时使用；长期使用应改用 named tunnel 或在手机与云电脑之间建立 Tailscale。

##### 5. 方案 C：Tailscale 内网直连（长期推荐）

在 Instabox 云电脑和安卓手机都安装 Tailscale，并登录同一个 tailnet。云电脑上执行：

```bash
tailscale up
tailscale ip -4
```

假设输出是 `100.101.102.103`，把 API 改为监听所有网卡，并填写 Tailscale 地址：

```dotenv
API_ENABLED=1
API_BIND=0.0.0.0
API_PORT=3080
API_PUBLIC_URL=http://100.101.102.103:3080
API_ENCRYPTION=1
```

重启 Bot 后，手机先打开 Tailscale，再访问 `http://100.101.102.103:3080/api/v1/health`。Tailscale 流量本身已加密，内网 HTTP 可以工作；仍建议开启 `API_ENCRYPTION=1`，让应用层也加密。不要把 `API_BIND=0.0.0.0` 和公网直连混用而不加防火墙。

##### 6. 用手机走一遍真实链路

在装 APK 之前，先在**云电脑**上运行与手机相同的请求顺序：

```bash
API_TOKEN="${API_TOKEN:-$(sed -n 's/^API_TOKEN=//p' .env | tail -n1)}"
API_TOKEN="${API_TOKEN:-$(jq -r .token data/api-token.json)}"
API_ENC_KEY="$(jq -r .key data/api-enc-key.json 2>/dev/null || true)"
test -n "$API_TOKEN" || { echo "找不到 API_TOKEN"; exit 1; }
npm run smoke:app -- --base https://3080-<机器ID>.instabox.tech \
  --token "$API_TOKEN" --enc "$API_ENC_KEY"
```

- 使用 Cloudflare 或 Tailscale 时把 `--base` 换成对应地址，IPv6/端口要原样保留。
- `--enc` 只在 `API_ENCRYPTION=1` 时需要；上面的命令会直接读取 `data/api-enc-key.json`，密钥不会进入 shell 历史。
- 全部步骤显示 ✅ 才去手机安装；如果只有引擎步骤是 ⚠️，说明链路通了，但 Agent CLI 还没装好。

##### 7. 在安卓 App 里配对

1. 从 [GitHub Releases](https://github.com/longtimex/agent-bot/releases) 安装最新的正式签名 APK；首次安装允许「安装未知来源应用」。
2. 打开 App 的「设置」，可以手动填写，也可以点「扫码配对」。
3. 如果 Telegram / 飞书已配置，向 Bot 发送 `/api`，扫描回复里的二维码。扫码后 App 只**导入**地址、令牌和加密密钥，不会立刻保存，先核对页面上显示的 `API：https://.../api/v1` 是否正确。
4. 手动填写时：
   - 服务器地址：`https://3080-<机器ID>.instabox.tech`（或 Tailscale 的 `http://100.x.y.z:3080`）
   - 访问令牌：`API_TOKEN` 的完整值
   - 加密密钥：启用 `API_ENCRYPTION=1` 时填写二维码中的 `enc`，或在设置页扫码自动带入
5. 点「保存并连接」。App 会先对新地址做健康检查，成功后才替换旧配置；失败会留在设置页并给出中文原因，已保存的旧连接不受影响。
6. 设置页会对 `127.0.0.1`、`localhost` 和公网明文 HTTP 显示警告。看到回环地址警告时不要继续，回到第 2 步换成隧道/VPN 地址。

##### 8. Instabox 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 云电脑浏览器能打开 `127.0.0.1:3080`，手机不能 | 正常。回环地址不能跨机器访问；使用 `instabox-port publish`、Cloudflare Tunnel 或 Tailscale，并把该地址写入 `API_PUBLIC_URL` |
| `instabox-port publish` 的地址返回 502/503 | Bot 没启动、端口不对，或发布的是错误端口。先在本机 `curl http://127.0.0.1:3080/api/v1/health`，再确认发布的就是 `3080` |
| 重新发布端口后手机连不上 | 端口 URL 可能已变化。更新 `.env` 的 `API_PUBLIC_URL`，执行 `npm run bot -- restart`，再重新扫码 |
| 二维码仍指向 `127.0.0.1` | 保存 `.env` 后没有重启 Bot；或 `API_PUBLIC_URL` 留空。修正后 `npm run bot -- restart`，再发一次 `/api` |
| 连接返回 401 | 令牌不一致。清空过 `data/`、重装 Bot 或手动改过 `API_TOKEN` 都会让旧令牌失效；重新发 `/api` 并扫码 |
| 连接超时 / DNS 解析失败 | 云电脑可能已停止，端口发布/隧道已断开，或域名过期；重新启动入口并核对地址。App 会直接提示这几种原因 |
| 启动报「尚未配置可用的控制端」 | 只选了安卓时，`API_PUBLIC_URL` 必须是手机可达的地址；先发布端口或建立隧道，写入 `.env` 后再启动 |
| Tailscale 地址能 ping 通但 App 连不上 | 确认 Bot 监听的是 `0.0.0.0`，手机 Tailscale 已开启，且 `API_PORT` 与地址中的端口一致 |
| 公网 HTTP 警告 | 公网明文会暴露令牌与对话。改用 HTTPS 端口发布/反向代理，或至少启用 `API_ENCRYPTION=1`；不要把 `API_BIND=0.0.0.0` 直接暴露到公网 |
| 机器停止后一切失效 | Instabox 没有公网入站端口，停止会结束 Bot、隧道和端口发布。重新启动机器后依次启动 Bot、重建入口、重启 Bot，并重新扫码 |

#### App 在线更新

App「设置 → 应用更新」会读取服务器上的 `GET /android/release?versionCode=<当前版本>`，显示最新版本、大小、更新说明与是否有新版；点击「下载并安装」后流式下载 `GET /android/release/apk` 到缓存 `.part` 文件，校验清单中的大小与 SHA-256，再交给 Android 系统安装器。首次安装需允许「安装未知来源应用」；App 会记住已校验的 APK，授权后返回 App 即自动继续安装，无需再次下载或点击。APK 是原始字节，即使开启 `API_ENCRYPTION=1` 也不会套消息级加密；下载仍需要 Bearer Token。更新清单缺失或未配置时，App 只显示提示，不影响服务器更新与聊天。

发布服务器更新包：

```bash
# 先在 Android Studio / CI 构建并签名，再发布已签名的 APK
npm run release:android -- --apk /path/to/agent-bot-v1.1.1.apk \
  --version 1.1.1 --notes "本次更新说明"
```

脚本会复制 APK 到 `data/android/releases/`，以实际发布字节计算 SHA-256 和大小，并原子写入 `data/android-release.json`。已在运行的 Bot 无需重启即可看到新清单。GitHub Release 同时附带 `android-release.json`，可下载后放到 `data/android-release.json`，再把 APK 放到清单中的 `android/releases/` 相对路径。

### 第 5 步：日常维护

基本不用再登服务器：`/ops` 诊断与快捷操作、`/logs` 看日志、`/update` 构建新版本、`/restart` 应用并重启、`/env` 改非密钥配置、`/access` 管白名单、`/proxy` 管代理。完整升级流程和回滚方式见「[更新与迁移](#更新与迁移)」。

## 命令

> Telegram 与飞书使用同一份命令表；下文涉及的引擎、模型、附件、提醒、定时任务、cc-switch、magpie、运维与访问控制功能两端一致。飞书把面板渲染为交互卡片，按钮回调等价于 Telegram 内联键盘。

| 命令 | 说明 |
| --- | --- |
| `/start` | 欢迎页：当前引擎/模型 + 功能菜单按钮 |
| `/menu` | 功能菜单：引擎、模型、任务、集成与运维的统一入口 |
| `/help` | 分类速览；`/help full` 查看完整说明，`/help cc` 查看 cc-switch 指令 |
| `/agent` | 查看或切换引擎（OpenCode 或任意 Agent CLI），支持按钮 |
| `/agent claude` | 切换到指定 Agent CLI（`claude`、`codex`、`gemini`、`qwen`、`qoder`、`cursor`…） |
| `/agents` | 检测本机 CLI，查看可安装/可更新/可卸载项 |
| `/agents install <id>` | 通过 npm/pip 安装内置 Agent CLI（需确认） |
| `/agents update <id>` | 更新由 Bot 安装的 CLI（需确认） |
| `/agents uninstall <id>` | 卸载由 Bot 安装的 CLI（需确认） |
| `/model` | 查看或切换当前引擎的模型，支持按引擎分组的按钮；`/model default`（或面板上的「↩️ 清除模型选择」）取消本会话选择，之后由对应引擎自身的配置决定模型，并重置上下文 |
| `/model <模型ID>` | 为当前 Agent CLI 指定模型（如 `/model sonnet`；OpenCode 仍走 `/model` 面板） |
| `/dir` | 查看本会话 CLI 引擎的工作目录（默认是 Bot 自身所在目录），面板上有「恢复默认目录」按钮 |
| `/dir <路径>` | 让本会话的 CLI 引擎在另一个项目里执行，支持 `~`、相对路径与引号；目录必须存在，切换会重置该会话的 CLI 上下文。OpenCode 的目录由其服务端决定，不受此设置影响 |
| `/new`、`/reset` | 重置当前会话上下文 |
| `/stop` | 停止当前任务（同时丢弃排队中的提示） |
| `/retry` | 重新发送上一条任务（失败提示上也有「重试」按钮，只重发它自己那一条） |
| `/queue` | 查看排队消息，可逐条取消或一键清空；当前任务不受影响 |
| `/status` | 查看引擎、模型、运行时长、今日任务、代理、队列与提醒数 |
| `/usage` | 查看任务量、成功率、平均耗时、今日与引擎统计 |
| `/report` | 生成跨聊天的每日用量报告（等价 `/usage` 面板的「📩 每日报告」按钮） |
| `/history [条数]` | 查看最近任务历史（提示词摘要、引擎/模型、耗时与结果），可一键清空 |
| `/export [json]` | 把最近任务历史导出为 Markdown（默认）或 JSON 文档发到聊天里，方便存档迁移 |
| `/schedule` | 定时 AI 任务面板：查看、暂停、恢复、删除 |
| `/schedule add 30m 检查服务器` | 到点自动执行 AI 任务；时间写法与 `/remind` 完全一致（见「定时提醒」） |
| `/schedule add --engine qoder --model deepseek 2h 汇总日志` | 指定执行引擎与模型（任意 Agent CLI 均可） |
| `/remind 30m 喝水` | 定时提醒：支持相对时长、中文时长（`5分钟后`、`半小时后`）、`18:30`、`下午3点`、`今晚8点半`、`明天/后天 08:30` |
| `/remind every 30m 喝水` | 重复提醒：也支持 `每30m`、`每5分钟`、`每天 08:30`、`每天8点半` |
| `/reminders` | 查看待触发提醒，可点按钮取消 |
| `/cancel <编号>` | 取消指定提醒 |
| `/timezone` | 查看/切换时区：提醒、定时任务、每日统计**立即生效**，无需重启 |
| `/timezone Asia/Shanghai` | 直接指定 IANA 时区，同时写入 `.env` 的 `REMINDER_TIMEZONE` |
| `/proxy` | 管理网络代理：添加、测试、启用、停用、删除 |
| `/cc` | cc-switch 面板：Provider 切换/测速、MCP、提示词、环境、代理诊断 |
| `/magpie` | magpie 模型网关面板：Provider、各 Agent 模型、路由组、配额、用量、守护进程 |
| `/magpie agent <agent> <provider/model>` | 为某个 Agent 指定模型（等价 `magpie <agent> <model>`） |
| `/magpie provider add <预设> <key>` · `/magpie group add <名称> models=…` | 新建 Provider / 路由组 |
| `/magpie quota` · `/magpie usage 7d` · `/magpie sync` · `/magpie update [check]` | 配额、用量、同步模型目录、检查/升级 |
| `/cc use <id>` / `/cc test [id]` | 切换 Provider / 测试端点速度与连通性 |
| `/cc mcp [sync]` / `/cc prompts` / `/cc env` / `/cc proxy` | 查看 MCP、同步配置、提示词预设、本地工具与代理状态 |
| `/cc model add <简称> <provider>/<modelID> [名称] [参数]` | 添加自定义模型并同步 `opencode.json`（参数：`--attachment`、`--context N`、`--output N`） |
| `/cc model del <简称> [force]` | 删除自定义模型（需在聊天内点按确认；被 agent、`opencode.json` 或某个聊天选用时需 `force`；强制删除会清除这些 agent 的 `model:` 绑定，并清除会话的模型选择，之后由引擎自身配置决定） |
| `/cc model assign <agent\|self> <模型>` | 为 Bot 或其他 agent 指定模型 |
| `/ops` | 运维中心：诊断、日志、更新、重启、服务与配置 |
| `/diag` | 查看 Node、Git、OpenCode、cc-switch、磁盘与日志状态 |
| `/logs [行数]` | 查看 Bot 日志；`/logs opencode [行数]` 查看 OpenCode 日志 |
| `/update` | 备份状态并在独立 release 目录构建新版本，留下 pending（需确认） |
| `/restart` | 激活 pending 并重启 Bot，失败自动回滚（需确认；systemd 部署请用 `npm run bot -- restart`） |
| `/service opencode start\|stop\|restart` | 管理由 Bot 托管的 OpenCode 服务 |
| `/env` / `/env set KEY VALUE` / `/env unset KEY` | 查看或修改非密钥配置，重启后生效 |
| `/access` | 查看当前渠道的访问白名单（含每个 ID 的移除按钮）与「放行所有用户」的状态；在飞书内自动展示飞书 open_id |
| `/access add <ID>` / `/access del <ID>` | 增删当前渠道白名单：Telegram 填数字用户 ID，飞书填 `ou_` 开头的 open_id；写入 `.env` 并**立即生效**，无需重启；会拒绝移除你自己、拒绝留空白名单。ID 可让对方发送 `/start` 后从被拒回复中取得 |
| `/api` | 查看安卓 App 配对信息（HTTP API 地址、令牌与暴露提示），并附带可被 App「扫码配对」直接导入的二维码图片 |
| `/alias` | 自定义快捷指令面板；`/alias add 名称 指令内容` 创建后，发送 `/名称` 即触发（支持 3 层嵌套，重启后保留） |
| `/id` | 查看聊天 ID、用户 ID、时区与会话 ID |

所有功能面板底部都有「⬅️ 主菜单」；在面板之间切换时会原地编辑当前消息，不会不断刷屏。`/start`、`/menu`、`/help` 不经过任务队列，即使正在执行长任务也能立即打开。

## HTTP API（/api/v1）

默认启用并监听 `127.0.0.1:3080`，可用 `API_ENABLED`、`API_PORT`、`API_BIND`、`API_TOKEN`、`API_PUBLIC_URL` 调整。默认回环监听只供本机/隧道使用，不能单独算作已配置的安卓控制端；运行向导会写入手机可达地址并生成固定 Token。

**连接与鉴权**

- 所有请求携带 `Authorization: Bearer <token>`；令牌可在 Telegram 或飞书发送 `/api` 查看，也可在安装向导完成时从终端复制。
- API 独立于聊天渠道：Telegram 或飞书暂时不可达时会保留 API 并在后台重连；只有全部控制端都不可用时进程才会按启动逻辑退出。
- 失败的令牌按来源地址限流（默认 60 秒 10 次，超限后暂停 5 分钟）；服务器先验证令牌，再检查失败预算，避免反向代理后的正确令牌被其他人的失败拖住。
- `API_PUBLIC_URL` 填手机实际可访问的协议、主机与可选子路径，例如 `http://192.168.1.10:3080`、`https://bot.example.com/agent-bot`。设置后 `/api` 才生成可扫码二维码，否则只提供手动填写提示。

**消息级加密**

`API_ENCRYPTION=1` 时，请求/响应体使用 AES-256-GCM 加密。配对密钥保存在 `data/api-enc-key.json`，通过 `/api` 二维码下发；客户端带 `x-enc: v1` 即启用，未带仍走明文。SSE、媒体流与导出/备份附件不加密。轮换密钥后，旧密钥的写请求会收到明文 400，需在 App「设置」重新扫码。

| 端点 | 说明 |
| --- | --- |
| `GET /health` | 存活检查：版本、当前引擎、时区 |
| `GET /info` | 会话与配对信息：引擎/模型、会话 ID、工作目录、当前 owner 聊天 `chatId`、用户 `userId`、API 监听地址；令牌不会回传 |
| `GET /help` | 与聊天端共享的帮助文案：`sections` 含基础菜单、完整说明与 cc-switch 指令（已去除 Markdown 标记）；`commands` 是全部命令词与说明，`aliases` 是等价写法（`tz→timezone`、`reset→new`、`svc→service`、`maintenance→ops`） |
| `GET /session` | 当前引擎/模型/工作目录；OpenCode 额外给出 `modelRef`，CLI 只给模型名。配套 `POST /agent` 切换引擎，`POST /model` 切换模型（复位词与聊天端一致），`POST /new` 重置会话。切换或恢复模型会清空上一个模型的上下文；`POST /model`、`POST /new`、`POST /dir`、`POST /peers/follow` 在任务排队/执行时返回 409；`POST /agent` 不影响当前上下文 |
| `GET /peers` · `POST /peers/follow {scope}` | 列出 App 与当前 owner 聊天（Telegram 或飞书）的引擎/模型/目录及用量；不返回内部会话键或聊天正文，也无法读取聊天端的队列深度。`follow` 只让 App 单向对齐该会话，不会反向修改聊天端设置 |
| `POST /task` | 提交任务 `{text, engine?, model?, attachments?}`；JSON 请求中的附件为 `{name, mime, data(base64)}` 数组，也可用 `multipart/form-data` 的 `text`、`engine?`、`model?` 与 `file0…file3` 字段流式上传，最多 4 个，默认不限制单文件字节数，文本内联、图片/音频/视频/PDF 按模型能力直连；`text` 可为空但需带附件（服务端按类型补默认指令）；`engine`/`model` 只作用于本条任务，不改动会话默认，`model` 在提交时按该引擎解析（OpenCode 走模型注册表、CLI 走引擎模型表），无法识别直接返回 400 而不入队；队列与 Telegram 同深度（最多 4 条待处理，超出返回 409「待处理消息过多…」）；返回 202 与 taskId |
| `GET /task/:id` · `GET /tasks?limit=` | 轮询任务状态（queued/running/done/failed/cancelled）与结果；完成时 `reply` 已剔除媒体指令，`media[]` 给出回复附件元数据（kind/label/name/size/remote）；`GET /tasks` 按时间倒序返回内存里保留的任务记录（默认 50 条、上限 200，含已结束的任务，`limit` 非法时回落到默认而不是空列表），App 的「最近任务」就靠它拿到可重试的旧任务 ID；`POST /stop` 停止全部 |
| `POST /task/:id/stop` · `GET /queue` · `POST /queue/clear` | 停止单个任务（排队中直接丢弃、执行中中止）；查看当前排队/执行中的任务；一键清空排队（仅取消 queued，不影响执行中的任务） |
| `GET /task/:id/events` | SSE 事件流：实时推送任务进度行与终态快照（250ms 节流、15s 心跳、终态自动关闭）；App 优先走流式，断流自动回退 1.5s 轮询 |
| `POST /task/:id/retry` | 重放已结束的任务：服务端用自己的记录复原原始文本、引擎、临时模型与附件，返回 202 与新任务（`retriedFrom` 为旧 ID）。排队/执行中返回 409（请先停止），已被清理或不属于本会话返回 404。App 的「重试」按钮与 Telegram `/retry` 走同一条路径，不再从本地聊天记录拼文本 |
| `GET /task/:id/media/:index` | 下载回复中的第 `index` 个媒体（任务视图 `media[]` 给出 kind/label/name/size/remote）；本地文件限 `data/outbox`，远程链接沿用与 Telegram 相同的 SSRF/代理防护 |
| `GET/POST /dir` | 查看 CLI 工作目录；`{dir:"/path"}` 切换（支持 `~` 与相对路径），`{reset:true}` 恢复默认；切换会重置 CLI 会话。`GET /dir/browse?path=` 列出该层的子目录供 App 的目录选择器使用：只回目录（隐藏项与文件不列，软链接只有指向真实目录才列出，悬空链接丢弃），名称按不区分大小写排序、最多 200 条并标 `truncated`，回 `{path, parent, home, cwd, defaultWorkDir, sessionDir, dirs:[{name,path}], truncated}`；路径走与 `POST /dir` 同一个解析器（`~`、相对路径、控制字符/超长/文件系统根目录的拒绝完全一致），非目录 400、无权限 409、`POST /dir/browse` 405、其它 `/dir/<子路径>` 404。它只读取，绝不改动会话（不会写 `dir`，也不会重置 CLI 上下文） |
| `GET/POST /timezone` | 查看当前时区；`{timezone:"Asia/Shanghai"}` 切换（校验 IANA 名称，写入 `.env` 并立即生效） |
| `GET/POST /proxy` · `POST /proxy/:id/use\|test` · `POST /proxy/off` · `DELETE /proxy/:id` | 网络代理：列表（地址已脱敏）、添加（先测试连通性）、启用/停用、单条测试与删除 |
| `GET/POST /aliases` · `DELETE /aliases/:name` | 快捷指令：与 Telegram `/alias` 共享同一份列表；提交任务时 `/名称 ...` 会先展开（最多 3 层） |
| `GET/POST /access` · `DELETE /access/:id` | 访问白名单：查看/添加/移除，写入 `.env` 并立即生效；与 `/access` 共用防锁死校验（不能移除自己、不能清空） |
| `GET/POST /models/custom` · `DELETE /models/custom/:key?force=1` | 自定义 OpenCode 模型：列表（含 Agent 绑定）、添加（简称 + `provider/modelID` + 可选 `label`/`desc`/`attachment`/`contextWindow`/`outputLimit`，后两项须为 1–1000000000 的整数否则 400；能力写没写进 `opencode.json` 都写在 `message` 里，与 Telegram `/cc model add --attachment/--context/--output` 同一条句式）、删除（仍被引用时返回 409，`force=1` 强制并重置相关会话） |
| `POST /models/assign` | 为 Agent 绑定模型（等同于 `/cc model assign`）：body `{agent, model}`，`agent=self` 且当前引擎为 opencode 时同步切换 App 会话 |
| `GET /cc` | cc-switch 状态：是否安装、版本、应用、Provider 列表与当前项（与 `/cc` 面板一致） |
| `POST /cc/use` · `POST /cc/test` | 切换 Provider（body `{id}`）与测速（省略 `id` 时测当前项）；同一时间只允许一个 cc-switch 变更操作 |
| `GET /cc/providers` · `POST /cc/providers` | 对应 `/cc provider add`：`GET` 下发 cc-switch 允许的模板/API 格式与字段上限，`POST` body `{name, id?, template?, baseUrl?, apiKey?, model?, apiFormat?, config?}` 逐项校验后拼固定参数（非法字段 400）。`apiKey` 只在服务层抹除，任何响应都不会回显；`GET` 还返回 `app`/`fieldMode`——cc-switch 只对 Claude/Codex/Gemini 接受 base/key/model 字段模式，其余应用必须提交 `config` JSON（App 表单据此切换） |
| `GET /cc/proxy` · `GET /cc/mcp` · `POST /cc/mcp/sync` | cc-switch 代理状态、MCP 列表与同步 |
| `GET /cc/prompts` · `POST /cc/prompts/activate` · `POST /cc/prompts/deactivate` | 提示词列表、启用（body `{id}`）与停用 |
| `GET /cc/env?mode=tools\|check` | cc-switch 环境工具与检查输出 |
| `GET /cc/views` · `GET /cc/view?name=&target=` | cc-switch 只读视图清单与实际输出。清单由服务端下发（名称/中文标题/是否需要参数/参数名/可用词组 `tokens`），App 直接渲染，新增视图不需要发版；`tokens` 由参数表推导（含 `provider rm` 这类别名，也含 `skills repos add` 这类三词形状），所以聊天框里输入的 `/cc provider current` 在 App 内也能解析；`target` 走 `assertSafeId`（不得以 `-` 开头），缺参数返回 400 而不是执行半截命令。视图含 `config`、`config-path`、`sessions`、`session-show`、`session-messages`、`provider-current`、`auth`、`auth-list`、`skills`、`skill-info`、`skills-discover`、`skills-updates`、`skills-repos`、`mcp-validate`、`failover`、`failover-list`、`failover-available`、`prompt-current`、`prompt-live`、`prompt-show`、`daemon`、`daemon-logs`、`settings`，网络类视图用 90 秒长超时，输出脱敏；`provider export` 不在此表——不带 `-o` 时它会写出 `{cwd}/.claude/settings.local.json`，属于副作用不是查看 |
| `GET /cc/stream?id=` · `GET /cc/models?id=` · `GET /cc/quota?id=` | 对应 `/cc stream`、`/cc models`、`/cc quota`：流式连通性、Provider 模型列表与配额（只读，不含烧额度的 `--reset`） |
| `POST /cc/mcp/import` · `POST /cc/prompts/create` | 对应 `/cc mcp import`（body `{json}`）与 `/cc prompt new`（body `{name, content}`），上限 20000 字 |
| `GET /cc/hermes` · `POST /cc/hermes` | Hermes 的两份记忆文件（`MEMORY.md` / `USER.md`）：`GET` 一次回 `{limits, memory, user, memoryEnabled, userEnabled}`（limits 是 cc-switch `hermes memory limits` 的原文，两份开关从其中的 `enabled: true/false` 读出，措辞变了就是 `null` 而不是猜）；`POST` body `{kind, action, content?, confirm?}`，`action` 只认 `set/clear/enable/disable`，`kind` 只认 `memory/user`。`set` 与 `clear` 覆盖整份文件，因此与 Telegram 一样要先 `confirm: true`，`clear` 由服务端补 cc-switch 自己要的 `--yes`（不带它时 cc-switch 只打印拒绝并以 0 退出，会「清空成功」但什么都没做）。内容按一个 argv 词交给 CLI，换行与空格原样保留；空内容、超 20000 字、含换行/制表符以外的控制字符都 400 且不落盘；写入后如果字数超过 Hermes 的加载预算，`message` 会给出截断警告（预算不是硬门槛，超了照样写）。每次写操作都回新状态，App 编辑器因此显示服务器内容而不是本地草稿 |
| `GET /cc/exec` · `POST /cc/exec` | cc-switch 危险命令白名单：`GET` 下发可执行项（名称/说明/是否需要参数/参数名/是否需确认/可用词组 `tokens`），含 `prompt-activate|deactivate`（`/cc prompts use|off` 的同一条命令），`POST` body `{name, arg?, confirm?}` 只跑表内固定参数；未知名称、缺 `confirm`、非法目标 ID 一律 400。App 每个命令只弹一次输入框，因此 Telegram 里写成两个词的命令用一个 `arg` 传（`failover move p1 up`、`mcp set-apps fs open-code,codex`、`prompts rename review 新名称`、`proxy config address 127.0.0.1`、`proxy config port 8787`）：服务器按空格拆开，前一段走 `assertSafeId`，后一段按命令各自校验（方向只认 `up/down`，应用列表只认 cc-switch 的 `--apps` 词表，端口须是数字，名称不得以 `-` 开头且 ≤80 字），拆开前不会执行半截命令。表内含 `skill-install`（`owner/name`，90 秒长超时）、`mcp-enable|disable|set-apps`、`provider-duplicate|set-default|import-live|remove-from-config`、`proxy-enable|disable`、`proxy-listen-address|listen-port`、`failover-add|remove|move`、`config-validate`、`sessions-sync-usage`、`skills-sync|update|update-all`、`prompt-activate|deactivate|rename`、`skills-repos-add`、`settings-language`、`daemon-start|stop`、`config-backup`、`auth-default`、`cc-update-check|cc-update`（后者是 cc-switch 自升级二进制，与运维中心的安装脚本是两条不同路径，需确认） |
| `POST /cc/run` | Telegram 的 `/cc run <任意参数>` 在服务端的同一入口：body `{args: ["mcp","enable","fs","--apps","opencode"], confirm?}`，最多 16 段、单段 ≤240 字、总长 ≤2000 字、不得含控制字符。判定与聊天共用一个模块 `src/ccGuards.ts`（交互式/常驻命令一律 400 并给出聊天里能用的替代写法；`-a/--app` 的任何写法都拒绝，`--apps` 不受影响；需要确认的形状先回 400「需要确认」，带 `confirm: true` 重发才真正执行，并按 cc-switch 的要求补上它自己的 `--yes`/`--confirm`）。`provider use\|switch` 走与按钮相同的切换路径（不是裸 argv），`deeplink` 明确指向 `POST /cc/deeplink`。响应 `{ok, code, command, message, text}`，`command` 只回显前三段且已脱敏 |
| `GET /cc/sessions?q=` · `POST /cc/deeplink` | 对应 `/cc sessions search`（关键词上限 128 字、不得以 `-` 开头或含控制字符，90 秒超时）与 `/cc deeplink`：仅接受 `ccswitch://v1/import?...`（上限 8192 字）、需 `confirm: true`，响应不回显链接本身 |
| `GET /config` · `PUT /config/:key` · `DELETE /config/:key` | `.env` 配置项：查看（密钥值不下发）、修改、删除；仅允许规则内的键，两个渠道的白名单键仍须走 `/access`，`REMINDER_TIMEZONE` 立即生效 |
| `GET /agents` · `GET /models` | 引擎列表（含安装状态 / 是否 Bot 托管 / 可安装性，并带 `aliases`、`bin`、`sessionMode`、`supportsModel`、`models`，客户端可用与 Telegram 相同的别名输入命中同一引擎）与模型列表；引擎列表第一项是内置的 `opencode`（`installed: true`，不可安装/更新/卸载），与 `POST /agent` 可接受的取值一致，客户端因此总能切回内置引擎；`GET /models?engine=<id>` 可取其他引擎的模型（供单条临时指定使用），未知引擎返回 400，`models` 里每个条目带 `aliases`，CLI 不列模型时改由 `modelHint` 给出可输入的写法 |
| `POST /agents/:id/install\|update\|uninstall` | 安装、更新或卸载 Bot 托管的 Agent CLI（npm/pip 方式）。已安装不可重复安装、非托管不可更新/卸载、当前引擎不可卸载；同一时间只允许一个操作 |
| `GET /ops/diag` · `GET /ops/logs?source=bot\|opencode&lines=N` | 运维诊断（版本、Git、OpenCode 可达性、磁盘/内存、日志大小）与日志尾部（10–400 行，自动脱敏） |
| `GET /ops/check-update` | 检查更新（干跑）：拉取远端并列出本地落后的提交，不改动工作区 |
| `GET /ops/backup` | 数据备份：把 `data/*.json` 状态打包成 tar.gz 附件返回（不含配对令牌，`data/backups/` 同步留档最近 5 份）；聊天端的 `/ops` 面板也可发送同一份备份 |
| `GET /ops/release` | 轻量版本卡：current/pending/previous release、stable/beta 通道、最近更新与启动自检；App 轮询它而不触发完整诊断探针 |
| `POST /ops/check` · `POST /ops/update` · `POST /ops/restart` · `POST /ops/rollback` · `POST /ops/cancel-pending` | 运行检查（npm run check）、隔离构建并留下 pending release、重启到 current/pending、回滚到上一版、丢弃 pending；更新/重启/回滚在任务运行中返回 `409`，操作串行且输出自动脱敏 |
| `GET /ops/service` · `POST /ops/service/start\|stop\|restart` | OpenCode 服务状态与启停/重启（只管理 Bot 自己启动的进程） |
| `POST /ops/cc` · `POST /ops/cc-update` | 安装 / 更新 cc-switch 二进制（较久，输出脱敏） |
| `GET /android/release` · `GET /android/release/apk` | App 更新清单与经 Bearer 鉴权的 APK 原始字节；清单包含版本、大小、SHA-256 与说明，APK 下载不套消息级加密 |
| `GET /history?limit=` · `DELETE /history` | 任务历史：`limit`（1–50）取最近 N 条，响应同时返回服务端保留的 `total`（最多 50 条），供 App 显示「已显示 N / 共 M 条」 |
| `GET /export?format=markdown\|json` | 下载任务历史文档（markdown/JSON，附件形式返回） |
| `GET /usage` | 用量统计与近 7 天趋势 |
| `GET /usage/report` | 全局每日报告：跨全部聊天聚合的当日汇总（总数/成功/失败/取消/平均耗时）、来源分布（`byChat[].source` 为展示名）、近 7 天趋势与渲染好的推送文本 `text`；与 `USAGE_DAILY_REPORT` 定时推送共用同一份数据 |
| `GET/POST /reminders` · `DELETE /reminders/:id` · `POST /reminders/:id/snooze {minutes}` | 提醒管理（触发时投递到当前 owner 聊天）；`snooze` 延后一次性提醒（1–10080 分钟），返回更新后的记录 |
| `GET/POST /schedules` · `POST /schedules/:id/pause\|resume\|run` · `DELETE /schedules/:id` | 定时任务管理（`POST` 的 `text` 支持 `--engine/--model` 前缀指定执行目标；响应含 `target`「引擎 / 模型」；`run` 立即执行一次，不影响原定时间） |
| `GET /status` | 系统状态：运行时长、今日任务、OpenCode 可达性，以及队列情况（`activeTask` 为正在执行/排队中的任务快照，`tasksActive` 计数排队+执行，`tasksTotal` 是服务器仍保留、可重试的任务条数） |

App 的会话是独立上下文（`api:app`），与 Telegram、飞书聊天互不干扰。`GET /peers` 展示 App 与 owner 聊天的现状，App 可据此显示对端引擎/模型/目录与最近用量，并用 `POST /peers/follow` 单向跟随。

## Agent CLI 适配

除 OpenCode 服务端外，Bot 可直接驱动本机安装的 Agent CLI。默认推荐使用 OpenCode：它的多模型、工具调用、附件收发与定时任务能力最完整；其他 CLI 适合按需切换或做交叉验证。

启动时会扫描 `PATH`，`/start` 欢迎页、`/agent` 面板和 `/agents` 管理面板都会展示检测结果；`/agent` 面板按“已安装优先”排序，并用 ⚠️ 标出未安装的 CLI；`/agent <id>` 会显示安装方式与模型提示。

| id | 名称 | 可执行文件 | 会话 | 常用模型 |
| --- | --- | --- | --- | --- |
| `qoder` | Qoder CLI | `qoder` | 预分配 | `deepseek` / `qwen` |
| `claude` | Claude Code | `claude` | 续接 | `sonnet` / `opus` / `haiku` |
| `codex` | Codex CLI | `codex` | 捕获续接 | `gpt-5-codex` / `gpt-5` / `o3` |
| `gemini` | Gemini CLI | `gemini` | 捕获续接 | 任意 Gemini 模型 ID |
| `qwen` | Qwen Code | `qwen` | 续接 | `qwen3-coder-plus` / `flash` |
| `cursor` | Cursor Agent | `cursor-agent` | 捕获续接 | `composer-1` / `sonnet-4.5` / `gpt-5` |
| `copilot` | GitHub Copilot CLI | `copilot` | 单次 | 任意 |
| `opencode-cli` | OpenCode CLI | `opencode` | 单次 | `provider/model` |
| `aider` | Aider | `aider` | 单次 | 任意 |
| `goose` | Goose | `goose` | 单次 | 任意 |
| `amp` | Amp | `amp` | 单次 | 任意 |
| `droid` | Factory Droid | `droid` | 单次 | 任意 |
| `amazonq` | Amazon Q Developer | `q` | 单次 | 任意（实验性） |
| `kiro` | Kiro CLI | `kiro-cli` | 单次 | 任意（实验性） |

- 每个引擎在同一聊天中拥有独立的会话与模型偏好，切换引擎不会清空其他引擎的上下文；`/new` 只重置当前引擎。
- `预分配`：先写入 UUID 再启动（`--session-id` 类参数）；`捕获续接`：从输出中提取会话 ID；`单次`：每次独立执行。续接失败时会自动清空会话并重试一次。
- 命令以 argv 数组直接执行，不经过 shell；输出会自动去除 ANSI 控制符并对错误信息脱敏。
- `/stop`、无活动超时、任务总上限、排队与进度卡片对所有 CLI 引擎一致生效。

### 检测、安装与卸载

启动日志会输出 `agent CLI detection: n/14 installed (...)`，并列出可在聊天内安装的 id。首次使用发送 `/start` 或 `/agents` 即可看到本机检测结果。

自动安装只支持内置的 npm/pip 包，执行前会展示完整命令并要求点击确认。`/agents` 面板里的 ⬇️ 安装、🔄 更新、🗑 卸载按钮同样先弹出一次性确认（5 分钟有效、点击即失效），确认时还会复查前置条件（是否由 Bot 托管、是否为当前正在使用的引擎）。

| id | 安装命令 |
| --- | --- |
| `claude` | `npm install -g @anthropic-ai/claude-code` |
| `codex` | `npm install -g @openai/codex` |
| `gemini` | `npm install -g @google/gemini-cli` |
| `qwen` | `npm install -g @qwen-code/qwen-code` |
| `copilot` | `npm install -g @github/copilot` |
| `opencode-cli` | `npm install -g opencode-ai` |
| `amp` | `npm install -g @sourcegraph/amp` |
| `aider` | `python3 -m pip install --user aider-chat` |

- Qoder、Cursor、Goose、Factory Droid、Amazon Q、Kiro 使用官方安装器或需要登录，`/agents` 只显示手动安装方式，不会执行远程脚本。
- 卸载只针对 `data/agent-cli-installs.json` 中记录的、由 Bot 安装的 CLI；系统预装或其他方式安装的版本不会被删除。卸载当前正在使用的引擎会被拒绝，请先 `/agent opencode`。
- 安装/卸载最长 10 分钟，会继承当前启用的代理；同一时间只允许一个任务。输出会自动脱敏。
- 检测与调用不依赖登录 shell 的 `PATH`：Bot 会在 `PATH` 之后自动补上常见的用户级全局目录（`~/.npm-global/bin`、`~/.local/bin`、`~/.local/share/pnpm`、`~/.bun/bin`、`~/.deno/bin`、`~/.cargo/bin`、`~/.pyenv/shims`、`~/bin`、`/usr/local/bin`、`/snap/bin`），systemd / cron 启动时同样能找到自己装好的 CLI；系统已有同名可执行文件时仍以 `PATH` 中的为准。这些目录每次检测都会重新扫描，因此在聊天里装完 CLI 立刻就能被识别，无需重启 Bot。
- 全局目录不可写时会自动降级重试，无需 root：npm 报 `EACCES` 时改用 `--prefix=~/.npm-global` 重装一次；pip 遇到 `externally-managed-environment`（Debian 12 / Ubuntu 24.04 常见）时改用 `--break-system-packages` 重装一次。重试成功的标记会记入 `data/agent-cli-installs.json`，`/agents update` 与 `/agents uninstall` 复用同一标记，消息里也会说明发生过降级。
- 只有当包管理器把可执行文件放到上述目录之外时，安装才会在成功后提示未检测到可执行文件，需要手动把对应 bin 目录加入 `PATH`。

### 自定义 / 覆盖档案

编辑 `data/agents.json`（可用 `AGENT_CLI_CONFIG` 指向其他路径）。文件按 mtime 热加载，无需重启；与内置 id 同名时按字段合并覆盖：

```json
{
  "agents": {
    "myagent": {
      "label": "My Agent",
      "bin": "/opt/myagent/bin/myagent",
      "desc": "内部 Agent CLI",
      "sessionMode": "stateless",
      "parse": "json-result",
      "supportsModel": true,
      "modelHint": "fast / deep",
      "installSpec": { "method": "npm", "package": "@scope/myagent" },
      "models": { "fast": "Fast Mode", "deep": "Deep Mode" },
      "args": {
        "base": ["run", "--yes"],
        "cwd": ["--dir", "{workDir}"],
        "model": ["--model", "{model}"],
        "prompt": ["{prompt}"]
      }
    }
  }
}
```

字段说明：

- 项目不设置任何 Agent 的默认模型。`models` 只用于 `/model` 面板与别名解析；没有显式选择时，Bot 不会向 OpenCode 或 CLI 传入模型参数，由该引擎自己的配置决定。旧的 `defaultModel` 字段会被忽略。
- `sessionMode`：`preassign` / `capture` / `stateless`；`parse`：`text` / `json-result` / `jsonl-result` / `claude-json` / `codex-jsonl` / `gemini-stream`。
- `args` 支持 `base`、`resumeBase`（续接时替换 `base`）、`newSession`、`resumeSession`、`cwd`、`model`、`prompt`；占位符为 `{workDir}`、`{sessionId}`、`{model}`、`{prompt}`。消息正文若以 `-` 开头（例如粘贴的 `- 项目符号` 列表），会自动补一个空格，避免它被 CLI 当成命令行开关。
- `models` 可为 `{ "id": "显示名" }` 或 `[{ "id", "label", "aliases" }]`；`strictModels: true` 时只接受列表内模型，否则模型 ID 透传给 CLI——但不接受以 `-` 开头或含控制字符、超过 120 字符的值，这类值会被视为非法模型而拒绝，避免它被 CLI 解析成额外的命令行开关。
- `resumeErrorPattern` 是识别“会话失效”的正则，命中后清空会话并重试一次；`env` 可附加进程环境变量。
- `installSpec` 可选，仅接受 `method: "npm" | "pip"` 与合法包名；Bot 只会执行固定的 `npm install -g` / `python3 -m pip install --user` 命令，不会把包名拼进 shell。
- id 必须匹配 `^[a-z0-9][a-z0-9._-]*$`，`opencode` 保留给服务端引擎；未知占位符、非法正则或缺少 `bin` 的条目会记录警告并被忽略。`amazonq` / `kiro` 的非交互参数可能随版本变化，标为实验性。
- 安装检测只看 `PATH` 中是否存在可执行文件；个别发行版会放置“安装引导 shim”，此时仍需实际安装后才能执行。
- 未安装任何 CLI 时仍可正常使用 OpenCode；`npm run bot -- start` 默认会启动受管 OpenCode，`npm run serve` 只用于手工前台启动。

## 目录

```
bot/
├── src/
│   ├── index.ts      入口：首次连接向导、配置加载、单实例锁、服务健康检查、定时清理
│   ├── setup.ts      多控制端向导：Telegram / 安卓 App / 飞书的选择、校验与 .env 原子写入
│   ├── setup-cli.ts  `npm run setup` / `npm run clients` 命令行入口
│   ├── config.ts     .env 解析、Telegram/飞书凭据、白名单与超时配置
│   ├── lock.ts       PID 锁文件（单实例 + 陈旧锁回收）
│   ├── channelRegistry.ts 渠道类型、会话键（`tg:` / `fs:`）与 owner 解析
│   ├── telegram.ts   共享消息桥：任务队列、命令分发、入站附件与出站发送
│   ├── telegramChannel.ts Telegram/飞书渠道解析、owner 与权限判定
│   ├── telegramReminderDelivery.ts 提醒投递与一次性延后按钮
│   ├── telegramSupport.ts Telegram 顶部通知与时间/ID/格式化辅助
│   ├── telegramStats.ts 使用统计、任务历史、运行状态面板
│   ├── telegramPersonalPanels.ts 代理、队列、快捷指令、提醒、定时任务、白名单、时区面板
│   ├── telegramCorePanels.ts 欢迎页、主菜单、Agent/模型/目录/安装面板
│   ├── telegramPersonalCommands.ts 提醒、快捷指令、定时任务命令
│   ├── telegramModelCommands.ts 模型切换、恢复默认与 CLI 工作目录命令
│   ├── telegramOpsCommands.ts 诊断、日志、检查/更新、备份、OpenCode 服务、配置项与重启
│   ├── telegramAgentCommands.ts Agent 引擎切换、CLI 安装/更新/卸载与确认流
│   ├── telegramProxyCommands.ts 代理添加/启用/测试/删除
│   ├── telegramAdminCommands.ts 白名单、时区命令与访问校验
│   ├── telegramAttachments.ts 入站附件收集、下载与模型输入构建
│   ├── telegramInfoCommands.ts 队列、配对信息、导出、状态与统计
│   ├── telegramMedia.ts 出站媒体、远程媒体下载与大小限制
│   ├── feishu.ts     飞书消息/卡片事件转换为共享更新并分发命令
│   ├── feishuRuntime.ts 飞书客户端、长连接、回调与共享桥的装配
│   ├── feishuApi.ts  飞书消息、卡片、媒体上传与 Bot API 适配
│   ├── feishuCallback.ts 飞书卡片回调 HTTP 服务与验签入口
│   ├── feishuCards.ts Telegram 面板转换为飞书交互卡片
│   ├── feishuAttachments.ts 飞书图片/文件/音频下载与消息适配
│   ├── feishuIdentity.ts 飞书 open_id/chat_id 与内部数字 ID 映射
│   ├── feishuTypes.ts 飞书 API 与资源类型
│   ├── api.ts        HTTP API `/api/v1`：任务、配置、运维与鉴权
│   ├── apiCore.ts    API 基础类型、错误与路径前缀
│   ├── apiTaskTypes.ts 任务视图/附件类型
│   ├── apiTasks.ts   任务队列、SSE、重试、停止与附件校验
│   ├── apiPersonal.ts 个人数据路由：提醒、定时、目录、时区、白名单
│   ├── apiTaskRoutes.ts API 任务/队列/停止路由
│   ├── apiOpsRoutes.ts API 运维诊断/日志/备份/服务路由
│   ├── apiModelRoutes.ts API 自定义模型查看/添加/删除路由
│   ├── apiCc.ts      cc-switch 路由
│   ├── apiCcSpecs.ts cc-switch 只读视图与危险操作白名单
│   ├── apiRateLimit.ts 失败 Bearer 认证的按地址限流（服务器先鉴权再查预算，反向代理后拿对令牌的 App 不会被别人的失败拖住）
│   ├── models.ts     模型表、别名解析与自定义模型热加载
│   ├── modelAdmin.ts 自定义模型注册、opencode.json 同步、agent 模型绑定
│   ├── model-cli.ts  `npm run models` 命令行入口
│   ├── ccswitch.ts   cc-switch CLI 封装：Provider/测速/MCP/提示词/环境/代理
│   ├── progress.ts   进度卡片
│   ├── opencode.ts   opencode HTTP/SSE 客户端
│   ├── agentCli.ts   通用 Agent CLI 适配层：PATH 检测、子进程、会话与输出解析
│   ├── agentProfiles.ts 内置 Agent CLI 档案（Claude/Codex/Gemini/Qwen…）
│   ├── agentInstaller.ts npm/pip 安装、更新、卸载与 Bot 托管清单
│   ├── ops.ts        运维：诊断、日志、重启、OpenCode 服务与 .env 编辑
│   ├── releaseManager.ts 隔离构建、release 存储/state、激活与回滚
│   ├── updateOrchestrator.ts 备份 → 门禁构建 → pending → 取消/回滚
│   ├── updateChecker.ts stable/beta 通道、干跑比较与 release 诊断
│   ├── releaseStatus.ts `/ops/release` 的轻量版本卡
│   ├── release-control.ts 兼容的 release 状态 CLI（生命周期主入口为 bot-cli）
│   ├── bot-cli.ts   统一生命周期入口：install/setup/status/logs/start/stop/restart/update/uninstall
│   ├── runtime.ts   supervisor、PID/锁、release 入口、安装清单与健康检查
│   ├── release-restart.ts systemd 发布切换、健康等待与自动回滚
│   ├── lifecycle-options.ts 生命周期参数解析
│   ├── lifecycle-files.ts 受管文件安全删除与 data root 校验
│   ├── startupSelfCheck.ts 启动自检与失败记录
│   ├── dataMigration.ts 数据 schema 快照与迁移标记
│   ├── androidRelease.ts App 更新清单与 APK 下载路由
│   ├── media.ts      [[image:...]] 指令解析、outbox 校验与清理
│   ├── attachments.ts 入站附件保存、文本内联、inbox 清理
│   ├── reminders.ts  定时提醒：解析、重复调度、持久化、轮询投递
│   ├── scheduler.ts  定时 AI 任务：解析、引擎/模型快照、持久化、执行与重复调度
│   ├── usage.ts      使用统计：任务量、成功率、耗时与每日聚合
│   ├── history.ts    任务历史：每聊天的最近执行记录（提示词摘要与结果）
│   ├── proxy.ts      HTTP(S)/SOCKS 代理：持久化、连通性测试、dispatcher
│   ├── messages.ts   长消息切分
│   ├── store.ts      会话持久化
│   └── logger.ts
├── docs/ARCHITECTURE.md 分层、模块边界与新增能力放置规则
├── tests/            单元测试（node:test）
├── install.sh        安装脚本：检查环境、克隆/更新、安装依赖、构建、准备 .env
├── deploy/           systemd 单元示例与安装器生成的单元（deploy/generated/ 已 gitignore）
├── scripts/          邮件、X、搜图、重启、release 应用/健康检查、cc-switch 安装、安卓发布与源码检查脚本
├── bin/              可选：`npm run cc-switch:install` 下载的 cc-switch 二进制（已 gitignore）
├── .opencode/agent/assistant.md   Bot 的 agent 人设与工具权限
├── opencode.json     Provider 与模型配置
└── data/             状态与日志、outbox/inbox、releases/（受管版本）、snapshots/（迁移快照）、android/（APK 更新包）
```

## 配置

复制 `.env.example` 为 `.env`（权限 `0600`），至少配置一个控制端。交互式配置可直接运行 `npm run setup` 或 `npm run clients`，在同一个向导里选择 Telegram、安卓 App 或飞书；也可以按下文示例手动编辑 `.env`。

```ini
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOW_USERS=你的Telegram用户ID
OPENCODE_SERVER_PASSWORD=与 opencode serve 一致
MY_API_KEY=...
```

飞书（可与 Telegram 同时启用）：

```ini
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=你的应用Secret
FEISHU_ALLOW_OPEN_IDS=ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_ALLOW_ALL_USERS=0
FEISHU_CALLBACK_ENABLED=1
FEISHU_CALLBACK_BIND=127.0.0.1
FEISHU_CALLBACK_PORT=3081
FEISHU_CALLBACK_PATH=/feishu/card
FEISHU_CALLBACK_VERIFICATION_TOKEN=开放平台生成的VerificationToken
```

把上述 `FEISHU_CALLBACK_BIND` 保持为 `127.0.0.1`，由 nginx/Caddy 将 `https://你的域名/feishu/card` 反向代理到 `127.0.0.1:3081/feishu/card`。若不使用面板按钮，设 `FEISHU_CALLBACK_ENABLED=0`；文字命令与附件仍可用。

### 飞书接入

1. 在[飞书开放平台](https://open.feishu.cn/)创建**企业自建应用**，在「凭证与基础信息」复制 App ID 与 App Secret。
2. 在「添加应用能力」启用**机器人**；在「事件与回调 → 事件配置」选择**使用长连接接收事件**，订阅 `im.message.receive_v1`（接收消息）。普通聊天与命令走这条长连接，不需要公网地址。
3. 面板按钮使用 `card.action.trigger` 卡片回调。飞书的 SDK 长连接只分发事件、不分发卡片回调，因此需在「事件与回调 → 回调配置」配置**公网 HTTP 回调地址**（如 `https://bot.example.com/feishu/card`），并填写到 `FEISHU_CALLBACK_*`。若不需要点击面板按钮，可保持 `FEISHU_CALLBACK_ENABLED=0`，文字命令仍完整可用。
4. 回调必须至少配置 `FEISHU_CALLBACK_VERIFICATION_TOKEN` 或 `FEISHU_CALLBACK_ENCRYPT_KEY` 之一；Bot 会校验请求，未通过时返回 403。公网入口应使用 HTTPS；`FEISHU_CALLBACK_BIND=127.0.0.1` 配合反向代理时，请把同一路径转发到 `FEISHU_CALLBACK_PORT`。
5. 在「权限管理」开通机器人收发消息与消息资源读取权限：至少需要 `im:message`、`im:message:send_as_bot`、`im:resource`（以开放平台实际展示名称为准）。修改权限后需发布应用版本并由管理员审核。
6. 将上述配置写入 `.env` 并重启 Bot。首次不知道自己的 `open_id` 时，可暂时设置 `FEISHU_ALLOW_ALL_USERS=1` 启动，私聊 Bot 发 `/start`；随后用 `/access` 查看或添加 open_id，再改回 `0` 并重启。
7. 在飞书搜索应用机器人发起**单聊**，发送 `/start`、`/menu` 或任意任务即可。群聊消息默认忽略。

飞书端与 Telegram 端共享同一个引擎、模型、会话存储和后台服务（提醒、定时任务、每日报告、任务队列、历史与统计），但会话键相互隔离：同一个人的 Telegram 聊天和飞书单聊拥有各自独立的上下文。`/access` 会自动识别当前渠道，只修改对应渠道的白名单。

完整变量见 `.env.example`：

- `TELEGRAM_ALLOW_USERS`：逗号分隔的 Telegram 白名单；启用 Telegram 且为空时必须设置 `TELEGRAM_ALLOW_ALL_USERS=1`。日常修改请用 `/access`（`/env set` 会拒绝这个键，避免文件与运行中的白名单不一致）。
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：飞书企业自建应用凭据，必须同时配置；任一控制端可用即可启动。二者都不会传给 Agent CLI 子进程。
- `FEISHU_ALLOW_OPEN_IDS`：逗号分隔的飞书 open_id；启用飞书且为空时必须设置 `FEISHU_ALLOW_ALL_USERS=1`。格式会在启动时校验，日常修改同样走 `/access`。
- `FEISHU_ALLOW_ALL_USERS`：显式设为 `1` 才允许所有飞书用户使用；生产环境不建议开启。
- `FEISHU_CALLBACK_ENABLED`：设为 `1` 启用飞书卡片回调 HTTP 服务，默认 `0`。不启用时普通消息、命令和附件仍可用，但面板按钮不会响应；启用后需在开放平台配置回调地址。
- `FEISHU_CALLBACK_BIND` / `FEISHU_CALLBACK_PORT` / `FEISHU_CALLBACK_PATH`：回调服务的监听地址、端口与路径，默认 `127.0.0.1:3081/feishu/card`。放在 nginx/Caddy 后时通常保持回环监听，仅暴露反向代理路径。
- `FEISHU_CALLBACK_VERIFICATION_TOKEN` / `FEISHU_CALLBACK_ENCRYPT_KEY`：开放平台回调配置中的验签凭据，至少配置一项；属于密钥，不能经 `/env` 查看。
- `TASK_TIMEOUT_MS` / `TASK_MAX_TIMEOUT_MS`：无活动超时与任务绝对上限，默认均为 10 分钟，所有引擎共用。
- `MAX_MEDIA_MB` / `MAX_INPUT_MB`：前者限制出站媒体下载/发送，默认 20MB；后者是**项目级**入站下载上限，默认 `0` 表示关闭（可设 `0–100000`）。项目不再按 10MB/15MB 或附件总字节数拒绝单视频、图片和普通文件，单条消息只限制最多 4 个附件。实际平台边界仍然存在：Telegram Bot API 的 `getFile` 约 20MB；飞书图片超过约 10MB 会自动改按文件发送，文件超过约 30MB 无法发送；OpenCode 对单个直连附件有约 20MB 限制，超过时文件完整落盘并以绝对路径交给模型。
- `MEDIA_ALLOW_PRIVATE_URLS`：默认 `0`，拒绝远程媒体链接访问本机/内网地址；仅在本地调试时设为 `1`。
- `REMINDER_TIMEZONE`：提醒时间解析所用 IANA 时区，默认 `Asia/Shanghai`；无效时拒绝启动。
- `STT_BASE_URL` / `STT_API_KEY` / `STT_MODEL` / `STT_LANGUAGE`：可选的语音转写服务（OpenAI 兼容 `/audio/transcriptions`，如 OpenAI、Groq 或本地 whisper）。`STT_BASE_URL` 留空关闭；配置后，当前模型不支持音频输入时，发来的语音自动转写为文字交给模型（`STT_API_KEY` 属密钥，只能写 `.env`，不能经 `/env` 查看或修改）。
- `USAGE_DAILY_REPORT` / `USAGE_DAILY_REPORT_TIME`：每日用量报告开关（默认 `0`）与推送时间（默认 `21:00`，24 小时制，按 `REMINDER_TIMEZONE` 解析）；到点向白名单第一位用户推送一次，重启当天会补发、不会重复发。也可用 `/env` 修改。
- `STARTUP_NOTICE`：默认 `1`，每次 Bot 上线后向白名单第一位用户推送一条「Bot 已上线」通知；设为 `0` 关闭。也可用 `/env set STARTUP_NOTICE 0` 修改。
- `OPENCODE_AGENT`：默认 `assistant`，对应 `.opencode/agent/assistant.md`。
- `AGENT_CLI_CONFIG`：自定义 Agent CLI 档案路径，默认 `data/agents.json`；文件不存在时只使用内置档案。
- `CC_SWITCH_APP` / `CC_SWITCH_BIN`：cc-switch 集成的应用类型（默认 `opencode`，会自动映射为 CLI 的 `open-code`；也接受 `openclaw` → `open-claw`）与二进制路径；留空时依次查找 `./bin/cc-switch` 和 `PATH`。
- `MAGPIE_BIN` / `MAGPIE_URL`：magpie 模型的 CLI 路径（留空时查找 `./bin/magpie` 和 `PATH`）与本地网关地址（默认 `http://127.0.0.1:3425`）。
- `UPDATE_CHANNEL` / `UPDATE_BRANCH`：服务端更新通道。`stable`（默认）跟随 `origin/main`，`beta` 跟随 `origin/beta`；`UPDATE_BRANCH` 可覆盖具体远端分支名。release 存在 `data/releases/store/`，current/previous/pending 与最近结果写入 `data/releases/state.json`，默认保留 3 个。
- `RELEASE_HEALTH_TIMEOUT` / `RELEASE_HEALTH_INTERVAL`：启动健康等待的总超时与轮询间隔（秒）。`install --systemd` 生成的 unit 以自身 manifest 决定监督方式；`RELEASE_SUPERVISOR` / `RELEASE_SYSTEMD_UNIT` 仅由旧版 `apply-release.sh` 交接使用。
- `GROK_API_KEY`：Grok provider 的密钥，`opencode.json` 通过 `{env:GROK_API_KEY}` 读取。
- `SNIPER_EMAIL` / `SNIPER_PASSWORD`：仅 `scripts/sniper_free_vps.mjs` 使用。

## 运行

```bash
./install.sh                    # 安装、构建并可进入控制端与工具向导
npm run bot -- start            # 启动 Bot（默认同时管理本机 opencode）
npm run bot -- status           # 查看 supervisor、release、PID 与日志路径
npm run bot -- doctor           # 只读诊断：环境、配置、进程与健康探针
npm run bot -- logs bot 100     # 查看最近 100 行日志
```

已经手动配置好 `.env`、依赖和构建产物时，也可以直接 `npm run bot -- start`。需要单独安装 cc-switch 时再运行 `npm run cc-switch:install`。

`npm run bot -- <command>` 是唯一生命周期入口：`install`、`setup`、`status`、`doctor`、`logs`、`start`、`stop`、`restart`、`update`、`uninstall` 共用同一套进程识别、release 选择与健康检查。`npm run serve` 仍保留为手工启动 opencode 的低层命令，但日常部署不需要单独维护两个终端。

### Docker 部署（可选）

仓库提供 Dockerfile 与 docker-compose.yml：容器内同时运行 opencode serve 与 Bot，`data/` 与 `.env` 挂载到宿主机持久化。

```bash
cp .env.example .env && vim .env   # 先填好至少一个控制端的凭据与白名单（容器内为非交互环境，不会进入连接向导）
docker compose up -d --build
docker compose logs -f
```

- 镜像内置 opencode CLI 与 git；入口脚本按 `OPENCODE_URL` 的端口自动拉起 `opencode serve`（设 `OPENCODE_AUTO_START=0` 关闭，适合把 `OPENCODE_URL` 指向宿主机或其他容器）。
- 安卓 App 访问需容器内监听 `0.0.0.0`，compose 已默认注入 `API_BIND=0.0.0.0`（优先于 `.env`），发布端口仍绑定宿主机 `127.0.0.1:3080`。仅使用安卓端时必须同时设置手机可达的 `API_PUBLIC_URL`（如 `http://192.168.1.10:3080` 或反向代理域名），否则通配监听不会被识别为可用的安卓控制端，Bot 会拒绝启动。
- 飞书按钮回调若要使用，将 `FEISHU_CALLBACK_BIND=0.0.0.0`，并在 compose 增加端口映射（如 `127.0.0.1:3081:3081`），再由宿主机反向代理 HTTPS 域名；仍只用文字命令时保持回调关闭即可。
- 挂载的 `./data` 属主需与容器内 `node` 用户（uid 1000）一致：`chown -R 1000:1000 data`。
- 容器内没有 `.git`，`/update` 和 `data/releases` 的隔离构建不可用；更新方式为宿主机 `git pull && docker compose up -d --build`。容器内的 systemd/启动监督脚本不适用于 Docker；镜像重建后以新镜像启动即为更新。

### 首次连接引导

首次启动且 `.env` 缺少任何可用控制端时，终端会自动进入选择菜单。也可以随时手动运行：

```bash
npm run setup      # 首次配置或重新配置；客户端完成后进入工具安装
npm run clients    # 只管理控制端，适合安装完成后添加其他控制端
```

向导会显示每个控制端的 `[已配置]` / `[未配置]` 状态，支持输入 `1,2,3` 多选、输入 `a` 全选、回车退出。重复运行只更新选中的配置，`.env` 中其他控制端、注释和值都会保留。控制端配置成功后，`npm run setup` 会继续检测 Agent CLI、magpie 与 cc-switch，列出未安装项供按编号多选；工具安装失败不会撤销已经保存的客户端配置。只想检查缺失项时运行 `npm run setup -- --check-tools`，只想配置客户端时运行 `npm run clients` 或 `npm run setup -- --no-tools`。

- **Telegram**：粘贴 `@BotFather` 返回的 Token → 向导调用 `getMe` 验证 → 给 Bot 发消息自动识别用户 ID → 确认写入 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_ALLOW_USERS`。
- **安卓 App**：填写 `API_BIND`、`API_PORT` 和手机可达的 `API_PUBLIC_URL`，向导生成或沿用 `API_TOKEN`。保存后终端会直接打印 `API 地址/api/v1` 与访问令牌；也可在 Telegram / 飞书发送 `/api` 扫二维码配对。仅局域网直连时通常监听 `0.0.0.0`；有反向代理、SSH 隧道或 VPN 时可保持 `127.0.0.1`，只需保证 `API_PUBLIC_URL` 是手机真正能访问的地址。
- **飞书**：粘贴 `App ID` / `App Secret`，向导会请求租户 Token 验证凭据；随后填写 `open_id` 白名单（首次不知道可输入 `a` 临时允许所有人，启动后用 `/access` 收紧）。卡片回调是可选项，启用时必须填写 `Verification Token` 或 `Encrypt Key` 之一。普通文字命令和附件不需要公网地址。

向导输出中，Telegram Bot Token 与飞书 App Secret 只显示掩码；安卓配对所需的新 `API_TOKEN` 会完整显示一次，便于在 App 中填写。输入行仍由终端回显，请留意共享屏幕。`.env` 采用原子写入并保持 `0600` 权限，不会进入日志或聊天消息。非交互环境（systemd、CI、无 TTY）不会阻塞，而是打印手动配置步骤并退出。

> 仅安卓 App 控制端也能启动并使用聊天、附件、引擎/模型、目录、历史与运维功能。但提醒、定时任务和每日用量报告需要一个聊天推送目标，因此仅部署安卓端时这些接口会返回 `409`；如需推送功能，请同时配置 Telegram 或飞书。

启动时会自动扫描 `PATH` 并打印 `agent CLI detection: n/14 installed (...)`；首次在聊天发送 `/start` 或 `/agents` 即可查看检测结果并安装新 CLI。

`npm run bot -- start` / `restart` 会在启动后检查本次启动自检与健康状态。Bot 通过 `BOT_LOG_FILE` 获得日志路径：进程每分钟检查一次，超过 10MB 时复制并清空（copytruncate），长期运行也不会无限增长；轮转文件只保留最近 7 个。
重复启动会被 `data/bot.lock` 拒绝，提示已有实例的 PID；锁文件同时记录进程启动时间，PID 被系统复用后不会误判为仍在运行。

开发模式：`npm run dev`；完整检查：`npm run check`（安卓源码静态检查 + lint + 文件体积门禁 + 无用文件/依赖检查 + 类型检查 + 测试 + 构建）。其中 `npm run check:android` 在没有 Android SDK 的环境里替编译器兜底：确认构建应用所必需的 Kotlin 源文件仍在仓库里、没有被 `.gitignore` 规则吞掉，并逐个检查括号与字符串/注释是否闭合。

### systemd 常驻（可选）

推荐由安装器生成 unit，而不是手工修改示例文件：

```bash
npm run bot -- install --systemd          # 系统级（需要 sudo 权限）
npm run bot -- install --user-systemd     # 当前用户级
npm run bot -- start
npm run bot -- status
```

安装器会生成 `agent-bot.service` 和（本机 OpenCode 时）`agent-bot-opencode.service`，并在 `data/install.json` 记录真实路径。`npm run bot -- restart` 在 systemd 模式下会先激活 pending release，再重启服务并检查健康；失败时自动回滚并重启旧版本。不要在 systemd 服务运行期间直接执行 `npm run bot -- start`，也不要运行旧的 `scripts/restart.sh` 抢进程。

如果 unit 还是旧版，先在维护窗口停止并禁用旧 unit，再执行 `npm run bot -- install --systemd`（或 `--user-systemd`）让安装器生成受管 unit；它会把 pending 激活、健康检查和自动回滚接进 `npm run bot -- restart`。`scripts/run-current.sh` 只作为 `ExecStart` 的兼容入口，`deploy/telegram-bot.service` 仅保留为手工部署示例。

> `opencode serve` 不会自动读取 `.env`，修改 `opencode.json` 或 agent 文件后需要带环境变量重启：
> `set -a; . ./.env; set +a; opencode serve --port 4096 --hostname 127.0.0.1`

### 卸载

```bash
npm run bot -- uninstall            # 停止服务并删除 launcher / systemd unit，保留 data/ 与 .env
npm run bot -- uninstall --dry-run  # 只打印将执行的动作
npm run bot -- uninstall --purge-data  # 同时删除 data/ 与 .env（不可恢复）
npm run bot -- uninstall --yes      # 非交互环境跳过确认
```

默认卸载不会删除仓库目录、`data/` 或 `.env`，因此之后重新安装仍可继续使用已有会话、提醒与配对密钥。只有显式传入 `--purge-data` 才会删除 `data/` 与 `.env`；删除前会校验 `DATA_DIR` 不是项目根目录、`/` 或项目目录的上级目录。只删除带 `managed by agent-bot` 标记的 launcher 与 systemd unit，手工创建或已被覆盖的文件会拒绝删除并保留。Docker 部署不使用上述 unit 流程，请在宿主机执行 `docker compose down`；是否删除挂载的 `data/` 由你自行决定。

## 更新与迁移

### 服务器更新

通过 `install.sh` 或 `npm run bot -- install` 管理的 Git checkout，使用隔离 release 更新；不要让正在运行的进程直接改写 checkout。以下命令都要在安装目录执行：

```bash
cd /path/to/agent-bot
npm run bot -- status          # 先确认 supervisor、current release 与健康状态
npm run bot -- update          # 备份状态、独立构建、发布门禁，留下 pending
npm run bot -- restart         # 激活 pending，重启并做启动自检

# 构建与重启一次完成；启动失败会回滚到上一版
npm run bot -- update --apply
```

`update` 要求当前 checkout 有可用的 `git` 远端和上游分支，且工作区没有未提交改动；它会先备份状态，再在 `data/releases/store/` 生成新 release，不会修改正在运行的 `dist/`。`restart` 只在启动自检通过后保留新版本；超时或启动失败会切回 previous 并重新启动。更新记录在 `data/releases/state.json`，默认保留 current、previous 与 pending。也可以在 Telegram / 飞书发送 `/update`，完成后再发送 `/restart`；App 抽屉中的「运维中心」提供同样的操作和二次确认。

- **systemd 部署**：使用 `npm run bot -- install --systemd` 或 `--user-systemd` 生成的 unit 时，`npm run bot -- update --apply` 会先激活 release，再重启 unit 并检查健康；不要直接 `systemctl restart` 一个旧的手工 unit 来替代这一步。
- **旧 unit / 手工进程**：如果 unit 仍执行 `scripts/run-current.sh` 或直接执行 checkout 里的 `dist/index.js`，它不会自动激活 pending。先用新安装器迁移 unit，之后统一用 `npm run bot -- restart`；旧的 `scripts/restart.sh`、`scripts/apply-release.sh` 只保留兼容入口。
- **Docker 部署**：容器内没有 `.git` 和 systemd，`/update`、隔离 release 与自动回滚不可用。请在宿主机拉取代码后执行 `docker compose up -d --build`，用新镜像重启；`data/` 与 `.env` 仍由挂载卷保留。
- **更新前备份**：`update` 会先备份可解析的 `data/*.json` 状态；涉及自定义脚本、`opencode.json`、`.opencode/agent/` 或 `bin/` 的改动仍需单独备份。`.env` 与 `data/` 不进入新 release 的 Git 工作区，但复制或修改它们的自定义脚本仍应事前留档。

### 从旧版手动部署迁移

没有 `.git`、没有 `src/bot-cli.ts`、没有 `data/install.json` 或仍在运行旧的 `dist/index.js` 的部署，不能直接运行 `npm run bot -- update`。先在**独立目录**准备新 checkout，完成一次性迁移，再切换服务；同一时间只运行一个旧版或新版实例，否则 Telegram 长轮询与 API 端口会冲突。

```bash
OLD=/data/workspace/bot                 # 换成旧安装目录
NEW=/opt/agent-bot                      # 换成新安装目录
git clone https://github.com/longtimex/agent-bot.git "$NEW"
cd "$NEW"

backup="$HOME/agent-bot-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
cp -a "$OLD/.env" "$OLD/data" "$backup/"

# 先把旧状态放到新目录，再清掉运行态锁和旧安装清单
mkdir -p data
cp "$OLD/.env" .env
chmod 600 .env
cp -a "$OLD/data/." data/
rm -f data/install.json data/bot.lock data/bot.pid data/opencode.pid data/startup-check.json
# 按需复制自定义配置，不要复制 node_modules/、dist/ 或旧 .git
test -f "$OLD/opencode.json" && cp "$OLD/opencode.json" opencode.json
test -d "$OLD/.opencode" && cp -a "$OLD/.opencode/." .opencode/

npm ci
npm run build
npm run bot -- doctor                   # 只读检查环境、配置和进程
```

如果旧实例保留着自己的 systemd unit（例如 `telegram-bot.service`），先不要覆盖或删除它。确认新目录的诊断通过后，在维护窗口内停止旧 unit，再启动新版：

```bash
sudo systemctl stop <旧-unit名>         # 换成实际 unit，例如 telegram-bot.service
npm run bot -- start                    # 先用脚本模式验证
npm run bot -- status
curl -fsS http://127.0.0.1:3080/api/v1/health   # 仅启用 API 且使用默认端口时

# 验证通过并准备长期常驻时，停止脚本实例后再切换 systemd
npm run bot -- stop
npm run bot -- install --systemd
npm run bot -- start
```

验证 Telegram / 飞书 `/start`、App 配对和一条真实任务后，再 `sudo systemctl disable <旧-unit名>`。若新版本无法启动，停止新实例、用 `$backup` 里的副本恢复 `.env` 与 `data/`，重新启动旧 unit 即可回退。迁移完成后，后续更新改用 `npm run bot -- update --apply`，不要再使用旧目录里的 `git pull` 或手工覆盖 `dist/`。

## 聊天运维中心

完成安装与启动后，Telegram 与飞书都可以在聊天内完成日常运维：

```text
/ops                               # 运维面板：诊断 + 快捷按钮
/diag                              # Node、Git、OpenCode、cc-switch、磁盘、内存与日志大小
/logs 100                          # 最近 100 行 Bot 日志（自动去除 ANSI 与密钥）
/logs opencode 200                 # 最近 200 行 OpenCode 日志
/update                            # 确认后隔离构建新 release，留下 pending
/restart                           # 确认后激活 pending release 并重启
/service opencode start|stop|restart
/env                               # 查看可修改的非密钥配置
/env set LOG_LEVEL debug
/env set TASK_TIMEOUT_MS 1200000
/env unset PROXY_TEST_URL
```

**项目更新**：`/update` 在隔离目录执行发布门禁与构建，完成后留下 pending；`/restart` 才会切换 current 并做启动自检，失败自动回滚。更新通道、systemd/Docker 差异和迁移步骤见「[更新与迁移](#更新与迁移)」。`/ops` 还可丢弃 pending 或回滚到上一版；任务运行中会要求先停止任务。

**重启 Bot**：脚本模式与 systemd 模式都统一使用 `npm run bot -- restart`；它会激活 pending、等待本次启动自检，并在失败时回滚。不要用旧 unit 的 `systemctl restart` 或 `scripts/restart.sh` 替代。

**OpenCode 服务**：`/service opencode start` 使用当前 `OPENCODE_URL` 的端口与 `--hostname 127.0.0.1` 启动 `opencode serve`，PID 写入 `data/opencode.pid`，日志追加到 `data/opencode.log`（超过 10MB 自动轮转）。Bot 只会停止自己启动的实例；手动启动的 OpenCode 会被识别为“未托管”并拒绝停止/重启。`OPENCODE_URL` 指向非本机地址时也不提供启停管理。

**cc-switch 安装/更新**：`/ops` 中的「cc-switch 安装/更新」会确认后执行 `scripts/install-cc-switch.sh`，下载对应平台二进制到 `./bin/cc-switch`；已安装时使用 `--force` 覆盖更新。下载自动继承 `/proxy` 中启用的代理。

**配置项**：完整可改键与当前值请直接在聊天中发送 `/env` 查看。它允许修改逻辑、超时、代理、模型、cc-switch、Agent CLI 与飞书回调等非密钥配置，写入时保持注释与顺序、原子替换并将 `.env` 权限设为 `0600`。其中：

- `REMINDER_TIMEZONE` 立即生效；其余键通常需要 `/restart`，OpenCode 相关变量还需要重启 OpenCode 服务。
- `TELEGRAM_ALLOW_USERS` 与 `FEISHU_ALLOW_OPEN_IDS` 只能通过 `/access` 修改：它会同步运行中的白名单，并阻止清空白名单或把当前操作者移出去。
- `FEISHU_CALLBACK_VERIFICATION_TOKEN`、`FEISHU_CALLBACK_ENCRYPT_KEY` 属于密钥，不能在 `/env` 查看或修改。

Telegram/飞书凭据、API Key、密码与账号凭据等永远不会在 `/env`、`/logs`、`/diag` 中显示，也不能通过聊天修改。

**运行检查**：`/ops` 中的「运行检查」执行 `npm run check`（android 静态检查 + lint + knip + 类型检查 + 单元测试 + 构建），适合在修改自定义 agent 档案或模型配置后验证。所有运维操作均为固定命令，不接受任意 shell 输入，并有并发锁避免同时执行多个重任务。

**一次性确认**：更新项目、重启 Bot、停止/重启 OpenCode、cc-switch 安装/更新、`/agents` 安装/更新/卸载的确认按钮使用随机一次性令牌，点击「✅ 确认」后立即失效；「取消」按钮同样携带该令牌，点击即**撤销**这次请求（不会留下一个 5 分钟内仍可按下的确认按钮），再点确认会提示「已过期或已被使用」。超过 5 分钟未点击也会自动过期。执行前还会重新检查前置条件（是否 systemd 托管、是否有任务正在跑），因此确认时的状态比弹出提示时更新。

## 发送图片 / 视频 / 语音 / 文件

模型在回复末尾输出指令，桥接会转换成对应渠道的原生消息（Telegram 媒体，或飞书图片、文件、视频与语音等）：

```
[[image:outbox/a.png]]
[[image:https://example.com/a.png]]
[[video:outbox/a.mp4]]
[[voice:outbox/a.mp3]]
[[file:outbox/report.pdf]]
```

- 本地文件只能位于 `data/outbox/` 下，引用写 `outbox/文件名`。
- 写在代码块（```` ``` ````）或行内代码里的指令会被当作示例原样发送，不会触发附件；因此文档、教程里的样例输出是安全的。
- 校验会解析符号链接，防止通过 outbox 内的链接读取目录外文件。
- 单条回复最多 5 个附件；默认单文件上限 20MB（`MAX_MEDIA_MB`）。飞书图片超过约 10MB 会自动改按文件发送，文件超过约 30MB 会被拒绝。
- 远程链接默认拒绝回环/私网/链路本地地址（含重定向后的每一跳），并把已通过校验的域名钉死在解析到的地址上（防止 DNS 重绑定），同时限制下载体积；调试内网地址需显式设置 `MEDIA_ALLOW_PRIVATE_URLS=1`（此时不做地址校验，也不钉死解析）。走 `/proxy` 代理下载时由代理服务器负责解析。
- 下载失败时只回显链接的 `协议://主机/路径`，不带查询参数（签名、令牌常放在 query 里），并做密钥脱敏；关闭或删除代理会立即断开已建立的代理隧道。
- Android 端同样消费这些指令：图片直接显示在气泡里，语音与视频点击后在 App 内播放（也可交给其他应用），其余文件显示为可点击卡片；媒体统一通过 `GET /task/:id/media/:index` 下载并缓存到本机，防护规则与聊天端一致。

## 接收图片 / 视频 / 语音 / 文件

直接发送附件即可，可附带文字说明作为提示词：

| 输入 | 处理方式 |
| --- | --- |
| 文本/代码文件（`.txt`/`.md`/`.json`/`.ts`/`.log` 等） | 读取内容并随提示词发送（最多 6 万字，超出截断） |
| 图片 | 保存到 `data/inbox/`；当前模型声明支持图片时作为附件发送 |
| 视频 | 保存到 `data/inbox/`；当前模型声明支持视频时直接附加，否则保留绝对路径并明确提示可用 `ffprobe`/`ffmpeg` 读取，不会静默丢弃 |
| PDF | 同上（按模型的 PDF 能力） |
| 语音/音频 | 保存到 `data/inbox/`；模型支持音频时直接附加；不支持但配置了 `STT_BASE_URL` 时自动转写为文字（OpenAI 兼容 `/audio/transcriptions`，Groq、本地 whisper 等均可），转写失败回退为"无法转写"提示 |

- 附件保存在 `data/inbox/`，超过 24 小时自动清理；`MAX_INPUT_MB` 默认 `0`，即关闭项目级单文件与总量字节上限（可显式设 `0–100000`）。单条消息最多 4 个附件，内联文本合计最多 10 万字，但视频和其他文件不再有项目自设的 10MB/15MB 限制。进入模型时，OpenCode 对单个直连附件有约 20MB 的平台限制；超过后文件仍完整保存在 inbox，并以路径与“未直接附加”的说明交给模型。Android 端选择文件后流式复制到缓存并通过 multipart 上传，不再先读入内存或转 Base64。入站附件以 `0600` 写入、目录以 `0700` 创建，同机其他账户无法读取。
- 飞书入站附件沿用同一套流式下载与分类逻辑；默认不设项目级单文件/总量字节上限，图片、文件、视频、语音/音频均可接收。语音建议使用 Ogg/Opus，其他音频会按文件保存，必要时交给 `STT_BASE_URL` 转写。部分客户端把 MP4/M4A 标成 `application/octet-stream`（甚至不给 MIME），服务端会按扩展名恢复为视频/音频/图片，而不是降级成普通文件。
- 能力检测来自 opencode 的 `GET /provider`。当前环境中的 custom/grok 模型未开启视觉/音频/视频输入，因此对应媒体会以“路径 + 不支持”提示交给模型。
- 想启用视觉/音频/视频：换用支持多模态的 provider/模型，并在 `opencode.json` 对应模型上设置 `"attachment": true` 与 `"capabilities": { "input": ["text","image","audio","video","pdf"] }`。
- 每个会话最多排队 4 条消息，超出会提示等待；`/stop` 会同时清空排队。

## 网络代理

在聊天中发送 `/proxy` 打开管理面板，也可以直接用命令：

```text
/proxy add http://127.0.0.1:7890 本地代理
/proxy add socks5://user:pass@host:1080
/proxy use 1
/proxy test 1
/proxy off
/proxy del 1
```

- 支持 `http://`、`https://`、`socks4://`、`socks5://`（`socks5h://` 等价于 `socks5://`），地址可带用户名密码。
- 添加时会用 10 秒超时访问测试地址（默认 `https://www.gstatic.com/generate_204`，可用 `PROXY_TEST_URL` 覆盖）；测试失败不会保存。
- 同一时间只启用一个代理；列表保存在 `data/proxies.json`，启用后生成 `data/proxy.env`（权限 600，含凭据，请勿分享）。
- 生效范围：远程媒体下载、所有 Agent CLI 子进程，以及 Agent 通过 `scripts/proxy-exec.sh` 执行的网络命令（`assistant.md` 已要求 Agent 自动使用）。
- Telegram / 飞书收发与本地 opencode 连接始终直连，因此代理故障不会导致 Bot 失联，可随时在面板停用。
- 如果希望 opencode 访问模型时也走代理，使用 `npm run serve:proxy` 重启 opencode（会短暂中断生成）。

## 定时提醒

```text
/remind 30m 喝水
/remind 1h30m 站会
/remind 18:30 开会        # 当天 18:30 已过则顺延到次日
/remind 明天 08:30 打卡
/remind every 30m 喝水    # 每 30 分钟重复
/remind 每2h 起身活动     # 每隔 2 小时重复
/remind 每天 08:30 打卡   # 每天固定时间重复
/remind 5分钟后 喝水      # 中文时长：分钟 / 小时 / 天 / 秒，可带“后”“以后”“内”
/remind 半小时后 休息     # 也支持“一刻钟”
/remind 下午3点 开会      # 12 小时制口语：上午/中午/下午/傍晚/晚上/凌晨
/remind 今晚8点半 电影    # “N点”“N点半”“N点30分”，今晚/明晚自动按晚间处理
/remind 后天 09:00 复诊   # 今天 / 明天 / 后天（“今天 …”若已过时报错，不会顺延）
/reminders                 # 查看待触发列表
/cancel 3                  # 取消编号为 3 的提醒
```

`/schedule add`（定时 AI 任务）使用同一套时间解析与重复语义，写法可直接照搬。

- 时间按 `REMINDER_TIMEZONE`（默认 `Asia/Shanghai`）解析，与服务器系统时区无关。
- 提醒保存在 `data/reminders.json`，每 15 秒检查一次；Bot 重启后仍然有效。
- 重复提醒在每次成功投递后自动排下一次；停机期间错过的周期不会补发多条，而是直接排到下一个未来时间点。
- 停机期间到期的一次性提醒会在启动后补发，并标记「补发」；过期超过 7 天的提醒会被丢弃。
- 投递失败（例如 Telegram 或飞书暂时不可用）会保留提醒，并按 1 分钟 → 5 分钟 → 15 分钟 → 1 小时退避重试；一次性提醒连续失败 8 次后放弃并记录错误，**重复提醒只跳过这一次**并排到下一个周期，不会因为一段网络故障而永久消失。
- 每个会话最多同时保留 20 条提醒；提醒投递依赖 Bot 进程运行。
- **延后（snooze）三端一致**：投递消息带「10 分钟 / 1 小时 / 明天」按钮；`/reminders` 面板的一次性提醒带「⏰+1h」一键延后；App 列表可选三档时长（`POST /api/v1/reminders/:id/snooze`）。延后只作用于待触发的一次性提醒，重复提醒保持周期。

## 定时 AI 任务

```text
/schedule                                          # 打开任务面板
/schedule add 30m 检查服务器                       # 10 分钟后执行一次
/schedule add every 2h 汇总日志                    # 每 2 小时重复
/schedule add 每天 09:00 生成日报                  # 每天固定时间重复
/schedule add --engine qoder --model deepseek 2h 汇总日志
/schedule pause 3 / resume 3 / del 3               # 暂停 / 恢复 / 删除
/schedule run 3                                    # 立即执行一次，不影响原定时间
```

- 时间格式与 `/remind` 相同（`30m`、`18:30`、`明天 08:30`、`every 2h`、`每天 09:00`），按 `REMINDER_TIMEZONE` 解析。
- 创建时会快照当前引擎与模型；也可用 `--engine <opencode|任意 Agent CLI>` 和 `--model <简称>` 覆盖。OpenCode 模型简称见 `/model`；Agent CLI 的可用模型见 `/agent <id>` 的提示，未列出的模型 ID 也可直接使用（Qoder 仍限定 `deepseek` / `qwen`）。
- 到点后任务进入该会话的普通队列执行，结果以普通回复发到聊天；执行中可发送 `/stop` 取消。
- 一次性任务执行成功后自动删除；执行失败时按 1 分钟 / 5 分钟 / 15 分钟自动重试，最多 3 次，仍失败才删除（`/schedule` 面板会显示「失败（第 N 次重试中）」）。删除前会在聊天中提示。重复任务在每次执行结束后排下一次（重试计数清零），停机期间错过的周期直接跳过。
- 排队中的任务被 `/stop` 取消时：重复任务按原周期继续，一次性任务自动暂停并在聊天中提示恢复方式（`/schedule resume 编号`），不会静默丢失。
- 任务保存在 `data/schedules.json`（权限 600）；Bot 重启后继续生效，崩溃中断的任务会在下次启动时补跑。停机超过 7 天的一次性任务会被删除，并在聊天中告知。
- 每个会话最多 20 个任务，提示词上限 2000 字。
- 面板中的「暂停 / 恢复 / 删除」按钮与 `/schedule pause|resume|del 编号` 等价；`/status` 会显示任务数量。任务超过 4 个时面板自动分页（⬅️/➡️ 翻页，每页 4 个）。
- `▶️ 运行` 按钮或 `/schedule run 编号` 可立即执行一次（暂停中的任务也可以），只更新最近运行状态，不改动原定时间或消耗一次性任务。

## cc-switch 与模型管理

### 安装 cc-switch（可选）

```bash
npm run cc-switch:install            # 下载到 ./bin/cc-switch
npm run cc-switch:install -- --force # 覆盖已有二进制
# 也可设置 CC_SWITCH_BIN=/path/to/cc-switch 或把二进制放进 PATH
```

未安装时 `/cc` 面板仍可打开并给出安装提示，`/cc model` 不依赖 cc-switch。

### cc-switch 聊天操作

`/cc` 面板提供 Provider 切换/测速，以及 MCP、提示词、环境、代理、配置、会话、认证、技能、故障转移入口。所有非交互子命令都可直接执行，也可用通用入口 `/cc run <参数>`：

```text
/cc provider list|current|add|dup|delete|set-default|import-live|remove-from-config|export|quota|fetch-models
/cc use <id> · /cc test [id] · /cc stream <id> · /cc models <id>
/cc mcp list|sync|import|add|delete|enable|disable|set-apps|validate
/cc prompts list|current|live|show|import|activate|deactivate|rename|delete|new
/cc config path|validate|show|backup|export|import|common|webdav|s3
/cc proxy show|enable|disable|config
/cc failover show|list|available|add|remove|move|clear|enable|disable
/cc sessions list|show|messages|search|delete|sync-usage
/cc auth status|list|default|remove|logout|reset-quota
/cc skills list|info|install|update|check-updates|enable|disable|sync|repos ...
/cc settings show|language ...
/cc daemon status|logs|stop|start --detach
/cc env list|check|tools
/cc deeplink <ccswitch://v1/import?...>
/cc update [--check]
/cc hermes memory limits|show|set|clear|enable|disable ...
/cc run <任意非交互参数>
```

- `/cc mcp add '<JSON>'` 通过 Deep Link 导入 MCP（可省略 `mcpServers` 外层）；`/cc prompts new <名称> <内容>` 通过 Deep Link 创建提示词，绕开交互式编辑器。
- `/cc hermes memory set <memory|user> --content '<内容>'` 与 `clear <memory|user>` 都是整份覆盖，走确认按钮；确认后的 `clear` 由服务端补上 cc-switch 自己要的 `--yes`（不带它时 CLI 只打印拒绝并以 0 退出，看起来成功实则什么都没做）。`enable|disable` 只决定 Hermes 加载记忆时是否跳过该文件，不删内容；`open-dir` 会打开服务器上的文件管理器，在聊天与 App 中一律拒绝。App 端对应的是一整页编辑器（`GET`/`POST /cc/hermes`），不用在聊天里拼一行参数。
- 删除 Provider/MCP/提示词、卸载技能、登出账号、导入/重置配置、导入 `ccswitch://` Deep Link（`/cc deeplink`、`/cc run deeplink`）、清空故障转移、消费配额重置额度、升级二进制等操作会先发送确认按钮；确认后通过伪终端自动回应 CLI 的安全提示（依赖 **util-linux** 的 `script` 命令，BusyBox 版本不支持 `-qec`，执行前会检测并直接给出提示而不是挂到超时）。
- 所有确认按钮（cc-switch、运维中心、Agent CLI 安装/更新/卸载）都使用一次性随机令牌：点击即失效、5 分钟未点击自动过期，历史记录里的旧按钮再按会提示已过期，执行前还会重新校验前置条件。
- 输出中的 API Key、Token、URL 凭据会自动打码（`key: '值'`、`key="值"` 这类带引号、用 `;` 分隔的写法同样会被遮盖），`config show` 也会脱敏后再发送。需要导入含密钥的配置时，建议先上传到 `data/inbox/`，再用 `--config-file` 引用。
- 仅能由 TUI/编辑器/OAuth 完成的命令（`provider edit`、`mcp edit`、`prompts edit`、`auth login`、`sessions resume`、`config restore`、`start`、`proxy serve`、前台 `daemon start`、`interactive`）会在聊天中给出提示而不执行。
- 切换 Provider 会先弹出确认（面板按钮、`/cc use <id>`、`/cc run use <id>` 都一致）；确认后写入的是 cc-switch 管理的全局配置；项目根目录的 `opencode.json` 仍优先，Bot 的实际模型由 `/model` 控制。
- 测速、配额、更新等长任务最长约 90 秒，以独立消息返回，不阻塞 `/stop` 等命令。

### 模型管理

```text
/cc model list
/cc model agents
/cc model add <简称> <provider>/<modelID> [显示名] [--attachment] [--context N] [--output N]
/cc model del <简称> [force]
/cc model assign <agent|self> <简称|provider/modelID>
```

AI 也可在 bash 中执行 `npm run models -- <子命令>`：

```bash
npm run models -- list
npm run models -- agents
npm run models -- add argon2 custom/gemini-4-argon-high --label "Gemini 4 Argon" --attach --context 200000
npm run models -- del argon2 --force
npm run models -- assign self argon2
```

- 自定义模型保存在 `data/models.json`（权限 600），`add` 会同步写入 `opencode.json` 对应 provider 的 `models`，`/model` 立即可选。`/cc model add` 支持 `--attachment`（声明支持图片输入）、`--context 200000`（上下文窗口）与 `--output 64000`（输出上限），效果与 CLI 的 `--attach` / `--context` 相同。
- `assign self` 指向 Bot 使用的 agent（默认 `assistant`），同时把当前聊天切到该模型；其他 agent 只修改 `.opencode/agent/<name>.md` 的 `model` 字段。
- 删除仍被 agent 或 `opencode.json` 引用的模型会被拒绝，确认后才可加 `force` / `--force`。
- 强制删除时，被删模型所在 agent 文件 frontmatter 的 `model:` 行会被清除（该 agent 不再绑定模型，由引擎自身配置决定），引用它的会话选择同样被清除；`opencode.json` 的 `model` / `small_model` 仍指向它时只提示、不自动改动。
- Bot 按文件 mtime 自动重载 `data/models.json`，无需重启；新会话生效。文件被写坏（JSON 无效）时不会清空已加载的自定义模型，修好后自动恢复。

## magpie 集成（可选）

[magpie](https://github.com/yetone/magpie) 把各 Agent 的模型统一到一个本地网关（默认 `127.0.0.1:3425`）：Claude Code 可以走 Kimi、Codex 走 DeepSeek、OpenCode 走任意 Provider，并在配额用完时自动切换账号。Bot 不打包 magpie，只调用本机已安装的 CLI。

### 安装

```bash
npm run setup                                    # 客户端配置后进入工具安装
npm run setup:tools                              # 单独检测并按编号安装
# 或只安装 magpie：
curl -fsSL https://usemagpie.ai/install.sh | sh
# 也可把二进制放到 ./bin/magpie，或设置 MAGPIE_BIN=/path/to/magpie
```

`.env` 可选配置：

```ini
MAGPIE_BIN=                 # 留空：依次查找 ./bin/magpie 与 PATH
MAGPIE_URL=http://127.0.0.1:3425   # 面板做健康检查用
```

### magpie 聊天操作

```text
/magpie                      # 面板：版本、网关健康、快捷入口
/magpie providers            # 已添加的 Provider
/magpie presets              # 内置供应商模板
/magpie agents               # 全部支持的 Agent（/magpie status 看本机已检测的）
/magpie models [agent]       # 模型列表
/magpie groups               # 路由组
/magpie quota [provider]     # 配额
/magpie usage 7d             # 用量（today/7d/30d/all）
/magpie agent claude deepseek/deepseek-chat   # 为某个 Agent 指定模型
/magpie claude deepseek/deepseek-chat         # 同上，省略 agent 子命令
/magpie provider add deepseek sk-…            # 新建 Provider（密钥不回显）
/magpie group add daily models=deepseek/deepseek-chat routing=smart
/magpie provider test|models|rm <id>          # rm 需确认
/magpie daemon start|stop|restart             # 需确认
/magpie sync · /magpie update check · /magpie update
/magpie run <任意非交互参数>                  # 通用入口
/magpie help                                  # 完整指令
```

需要桌面/终端/交互完成的命令（`tui`、`web`、`serve`、`plugin`、`accounts add`、`gateway-key`、`backup`、`restore` 等）在聊天与 App 中会被拒绝并给出替代写法；所有输出都会去掉 ANSI 并脱敏 Token/Key。

### HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/magpie` | 概览：是否安装、版本、网关地址与健康状态，并下发视图/命令清单 |
| `GET` | `/magpie/views` | 只读视图与可执行命令清单（名称、标题、是否需要目标、是否需确认） |
| `GET` | `/magpie/view?name=&target=` | 运行只读视图（providers、models、quota、usage、settings、daemon 等） |
| `POST` | `/magpie/exec` | 运行白名单命令 `{name, target?, confirm?}`；需确认的缺 `confirm: true` 返回 400 |
| `POST` | `/magpie/run` | 通用透传 `{args, confirm?}`，逐段校验、拒绝交互式命令 |
| `POST` | `/magpie/provider` | 新建 Provider `{preset, key}`，密钥不回显 |
| `POST` | `/magpie/agent` | 为 Agent 指定模型 `{agent, model}` |
| `POST` | `/magpie/group` | 新建路由组 `{name, pairs}` |

同一时间只允许一个 magpie 变更操作；只读视图与命令走同一份 `src/apiMagpieSpecs.ts` 白名单，聊天端与 API 不会脱节。

## 使用统计

```text
/usage
```

- 统计每个会话的任务总数、成功 / 失败 / 取消、成功率、平均耗时、今日任务与引擎使用次数。
- 数据保存在 `data/usage.json`（权限 600），按 `REMINDER_TIMEZONE` 划分自然日，仅保留最近 31 个有记录的日子。
- 超过 31 天没有任何任务的会话会在下一次任务记录时被清理（每小时最多扫描一次），`data/usage.json` 与 `data/history.json` 不会随开放白名单的使用无限增长；代价是长期沉默的会话统计与历史会从头开始。
- 只记录任务结果与耗时，不保存提示词或回复内容。
- `/status` 也会显示今日任务数；面板与状态页均可点击「刷新」查看最新数据。
- 面板上的「📩 每日报告」随时生成全局汇总（跨所有聊天聚合）；`USAGE_DAILY_REPORT=1` 后每天 `USAGE_DAILY_REPORT_TIME`（默认 21:00）自动向白名单第一位用户推送一份，当天只发一次（状态存于 `data/usage-report.json`，重启补发、不重复）。

## 超时与错误

所有引擎统一使用：

- 无活动超时：超过 `TASK_TIMEOUT_MS`（默认 10 分钟）没有任何输出即中止。
- 绝对上限：任务总耗时达到 `TASK_MAX_TIMEOUT_MS`（默认 10 分钟）即中止；长任务可调大。
- OpenCode 超时会调用 `POST /session/:id/abort` 终止服务端生成；Agent CLI 会终止整个进程组（含子进程）。

常见故障：

| 现象 | 处理 |
| --- | --- |
| `请求失败: ECONNREFUSED` | 本地 `opencode serve` 未启动；执行 `npm run bot -- start`（会启动受管 OpenCode），或手工运行 `npm run serve`。未显式选择引擎的新会话会自动回退到已安装的 Codex/CLI，App 气泡会注明回退原因 |
| `请求失败: UND_ERR_SOCKET` | 服务端连接被关闭；查看 opencode serve 日志与上游模型状态 |
| `fetch failed` | 已自动解包底层 `ECONNREFUSED` / `ETIMEDOUT` / socket 错误码；按对应原因处理 |
| `-> 404` 会话不存在 | Bot 会自动新建会话，上下文清空 |
| 启动报白名单 / Token 错误 | 运行 `npm run clients` 重选出错的渠道重新校验，或手动检查：Telegram 的 `TELEGRAM_ALLOW_USERS` / `TELEGRAM_BOT_TOKEN`（也可显式设置 `TELEGRAM_ALLOW_ALL_USERS=1`）；飞书的 `FEISHU_APP_ID` 是否为 `cli_` + 16 位十六进制字符、`FEISHU_APP_SECRET` 是否已填、`FEISHU_ALLOW_OPEN_IDS` 是否为 `ou_` 开头。Bot 已运行时让任一白名单用户发送 `/access add <你的 ID>` |
| 飞书完全无响应 | 确认应用已启用「机器人」能力；事件配置使用**长连接**并订阅 `im.message.receive_v1`；消息收发与资源读取权限已发布并通过审核；`FEISHU_APP_ID` / `FEISHU_APP_SECRET` 正确，且 `open_id` 在 `FEISHU_ALLOW_OPEN_IDS` 中（或开启 `FEISHU_ALLOW_ALL_USERS=1`）。用 `/logs 100` 查看长连接或鉴权错误；也可重跑 `npm run clients` 重新校验凭据 |
| 飞书文字可用但按钮无响应 | 检查 `FEISHU_CALLBACK_ENABLED=1`；开放平台回调地址使用公网 HTTPS，路径与 `FEISHU_CALLBACK_PATH` 完全一致；反向代理转发到 `FEISHU_CALLBACK_BIND:FEISHU_CALLBACK_PORT`（默认 `127.0.0.1:3081`）；`FEISHU_CALLBACK_VERIFICATION_TOKEN` 或 `FEISHU_CALLBACK_ENCRYPT_KEY` 与开放平台一致。未配置回调时请改用文字命令 |
| 飞书图片 / 文件发送失败或被降级 | 出站图片超过约 10MB 会自动按文件发送，单文件超过约 30MB 无法发送；入站默认不设项目级字节上限，单条消息最多 4 个附件。若传送大文件失败，通常是平台接口、反向代理或磁盘空间限制，请查看 Bot 日志 |
| 飞书语音没有按语音播放 | 语音建议使用 Ogg/Opus；其他音频格式可能上传失败并回退为文件附件，转成 Opus 后重试 |
| 首次启动没有出现向导 | 当前不是交互式终端（systemd/CI），或已有任一可用控制端；按输出提示手动配置，或在终端运行 `npm run setup` / `npm run clients` |
| Telegram 向导识别不到用户 ID | 确认已给 Bot 发送消息；若提示 409 Conflict，先停止其他轮询实例或移除 Webhook，再手动输入 ID |
| 安卓 App 无法连接或二维码指向回环地址 | 设置手机可达的 `API_PUBLIC_URL`（局域网写 `http://192.168.1.10:3080`，反向代理写 `https://bot.example.com`，Instabox 用 `instabox-port publish 3080` 输出的 HTTPS 地址）；仅监听 `127.0.0.1` 或 `0.0.0.0` 无法自动推断手机该连的地址。提供公网入口时务必保持 Bearer Token 鉴权，并优先走 HTTPS / VPN / SSH 隧道 |
| 仅安卓端时提醒或定时任务返回 409 | 这些功能需要向 Telegram 或飞书 owner 聊天推送。运行 `npm run clients` 添加聊天控制端，并与 Bot 私聊发送一次 `/start` |
| 启动提示已有实例（PID） | 说明旧进程仍在运行；用 `npm run bot -- restart` 重启，或先结束该 PID（锁文件会校验 PID 启动时间，不会误杀复用 PID 的进程） |
| 群组中发消息无响应 | 预期行为：Bot 只处理私聊 |
| 图片/视频/语音提示不支持 | 当前模型未声明对应输入能力；换用多模态模型或在 `opencode.json` 中开启 `attachment` 并声明 `video`/`audio` 能力 |
| 附件下载失败 / 超过 20MB | Telegram Bot API 的 `getFile` 约 20MB 的平台下载限制；压缩后重发，或改用飞书/安卓 App（默认不设项目级字节上限，单条最多 4 个附件）。反向代理还可能有自己的 body/timeout 限制 |
| agent 不存在 / 400 | 确认 `OPENCODE_AGENT` 与 `.opencode/agent/*.md` 名称一致，并重启 opencode serve |

## 安全说明

- `.env`、`data/`、`dist/` 已在 `.gitignore` 中。
- 首次连接向导中，Telegram Bot Token 与飞书 App Secret 只显示掩码；安卓配对所需的新 `API_TOKEN` 会在终端完整显示一次供手动填写。`.env` 原子写入且权限为 `0600`，Bot Token 与 API Token 不会进入日志或聊天消息（终端输入行仍会回显）。
- `opencode.json` 不再包含明文密钥；密钥统一放在 `.env`。
- 若密钥曾以明文形式存放或分享，请在供应商后台轮换 `GROK_API_KEY` / `MY_API_KEY`。
- Agent CLI 引擎默认以各家的免确认参数运行（如 Claude Code 的 `--dangerously-skip-permissions`、Codex 的 `--dangerously-bypass-approvals-and-sandbox`），且 OpenCode agent 允许 bash/edit，请在可信环境中使用。
- 子进程环境会先剥离 Bot 自身的访问控制变量：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_ALLOW_USERS`、`TELEGRAM_ALLOW_ALL_USERS`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_ALLOW_OPEN_IDS`、`FEISHU_ALLOW_ALL_USERS`、`OPENCODE_SERVER_USERNAME`、`OPENCODE_SERVER_PASSWORD`、`API_TOKEN`、`STT_API_KEY` 不会传给任何 Agent CLI、运维命令或安装器（否则一个被劫持的 CLI 就能以 Bot 身份操作全部白名单会话）。运行中的 Agent 仍保留自己的供应商 Key；`/agents install` 用的安装器额外剥离所有名称形似密钥的变量，因为 npm 会执行包作者写的 lifecycle 脚本。
- `/agents install` 只执行内置白名单中的 npm/pip 包，不接受用户自定义命令；`/agents update` 只对 `data/agent-cli-installs.json` 中由 Bot 安装的包重跑同一条白名单安装命令；`/agents uninstall` 只删除由 Bot 安装的版本，不会动系统预装 CLI。
- `/ops` 的更新、重启、服务启停、cc-switch 安装都只执行固定命令并要求确认；不接受任意 shell 输入。`/env` 只开放非密钥配置，密钥字段永远不读取、不显示、不写入。日志输出会统一去除 ANSI 并脱敏 Token、API Key、密码与 URL 凭据。发往聊天端的文本与写入日志的错误信息也会统一脱敏，其中 Telegram Bot Token 还会额外替换为 `***`。
- 飞书回调的 `FEISHU_CALLBACK_VERIFICATION_TOKEN` / `FEISHU_CALLBACK_ENCRYPT_KEY` 只从 `.env` 读取；未通过验签的请求返回 403，这些凭据不会出现在 `/env`、`/logs`、`/diag` 或聊天回复中。
- 会话、用量、历史、代理这几份 JSON 数据文件都是“临时文件 + 原子重命名”写入，权限 `0600`。若启动时发现文件内容无法解析（手动改坏、旧版本残留等），Bot 会把它改名为 `<文件名>.corrupt-<时间戳>` 留作排查，再以空数据继续运行，而不是在下次保存时直接覆盖——损坏前的记录仍可从该文件恢复。

## 辅助脚本

| 脚本 | 用途 |
| --- | --- |
| `scripts/send_mail.js` / `check_inbox.js` | Outlook 收发信（Playwright） |
| `scripts/x_action.js` | X 发推 / 账号信息 |
| `scripts/search_image.js` | DuckDuckGo 搜图并保存到 `data/outbox/` |
| `scripts/x_search_free_servers.mjs` | 搜索免费服务器信息 |
| `scripts/check_free_site.mjs` | 检查站点是否提供免费额度 |
| `scripts/sniper_free_vps.mjs` | 免费 VPS 抢注守护进程（读取 `SNIPER_*`） |
| `scripts/proxy-exec.sh` | 按 `/proxy` 当前启用项注入代理环境后执行命令 |
| `scripts/check-android-sources.mjs` | 无 Android SDK 时的安卓源码静态门：必需源文件是否缺失、是否被 `.gitignore` 吞掉、Kotlin 括号与字符串是否闭合（`npm run check:android`） |
| `scripts/check-size.mjs` | 模块体积门禁：超过预算即失败，防止已拆分的文件重新长成超大文件（`npm run check:size`） |
| `scripts/install-cc-switch.sh` | 下载 cc-switch CLI 到 `./bin`（`npm run cc-switch:install`） |
| `scripts/restart.sh` | 兼容入口，委托 `npm run bot -- restart` |
| `scripts/run-current.sh` | 兼容入口，委托 `npm run bot -- run`；优先使用 current release 的构建 |
| `scripts/apply-release.sh` | 兼容入口，委托 `npm run bot -- restart`（含 pending 激活与回滚） |
| `scripts/release-health.mjs` | 发布健康探针：API 可用时走 `/health`，Telegram/飞书-only 时校验本次启动自检的 release/PID/时间 |
| `scripts/publish-android-release.mjs` | 把已签名 APK 复制到 `data/android/releases/`，按实际字节计算 SHA-256/大小并原子更新清单（`npm run release:android`） |
| `scripts/check-release.mjs` | 发布门禁：类型检查、安卓源码检查、体积预算与全部单元测试（`npm run check:release`） |
