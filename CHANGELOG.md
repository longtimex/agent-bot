# 更新日志

本项目的显著变更记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [未发布]

### 优化

- **API 防爆破与响应加固**：`/api/v1` 现在按客户端地址统计失败的 Bearer 认证（60 秒内 10 次后暂停 5 分钟），JSON 响应统一带 `no-store`、`nosniff`、`DENY`、`no-referrer` 与 `default-src 'none'` 安全头；请求/头部/空闲连接超时收敛到 120s/30s/5s，大于 1KB 的 JSON 在客户端声明 `gzip` 时压缩返回。
- **任务记录回收补齐**：任务超过 200 条被清理时，同步删除该任务的 SSE 订阅与节流时间戳，避免长期运行时按任务 ID 累积的小对象。
- **超大源文件拆分**：cc-switch 路由与白名单表拆到 `src/apiCc.ts` / `src/apiCcSpecs.ts`，HTTP 基础类型拆到 `src/apiCore.ts`；内置 Agent CLI 档案拆到 `src/agentProfiles.ts`，Telegram 的纯格式化/时间/ID 辅助拆到 `src/telegramSupport.ts`。`src/api.ts` 由 2655 行降到约 1200 行，`src/agentCli.ts` 由 1357 行降到约 1060 行，`src/telegram.ts` 由 4263 行降到约 2730 行（统计面板、个人数据面板、核心面板、个人命令、模型命令与运维命令分别拆到 `telegramStats.ts` / `telegramPersonalPanels.ts` / `telegramCorePanels.ts` / `telegramPersonalCommands.ts` / `telegramModelCommands.ts` / `telegramOpsCommands.ts`）。API 的任务队列、SSE、重试与附件处理独立为 `src/apiTasks.ts`，路由只负责解码并调用服务，对应 T3 Code 的「transport 保持轻薄，能力放在 service」约定。
- **质量门禁**：新增 oxlint（`.oxlintrc.json`）与 `npm run lint`、knip（`knip.jsonc`）与 `npm run knip`，并接入 `npm run check` / CI；修复了未使用导入、无用转义、无意义 spread 等问题。

### 新增

- **安装脚本**：新增仓库根目录的 `install.sh`，支持在当前 checkout 安装或从 GitHub 克隆到指定目录；自动检查 Node ≥ 20.12 / git / npm，安装依赖与 opencode CLI，构建项目，生成权限 `600` 的 `.env`，并可按需进入 Telegram 配置向导或直接启动。支持 `--dir`、`--branch`、`--local`、`--no-opencode`、`--no-setup`、`--start`、`--dry-run` 与环境变量配置；新增 `tests/install-script.test.ts` 做 shell 语法与帮助输出门禁。

- **模型复位词三端统一**：`POST /api/v1/model` 现在接受 Telegram 的整套复位词（`default`/`reset`/`clear`/`auto`/`默认`/`恢复默认`），并沿用「引擎真的声明了同名模型时该模型优先」规则；额外支持 `{model, reset: true}` 强制恢复默认（App 的「恢复默认模型」按钮）。复位词表迁到 `src/models.ts`，`AgentCliRegistry.declaresModel()` 承载声明判定，Telegram / API / App 共用同一份语义。
- **引擎切换回执**：`POST /api/v1/agent` 返回 `message`（`已切换至 X` / `当前已经是 X，无需切换` / CLI 不在 PATH 时附「未检测到命令 <bin>」），App 的顶栏芯片、引擎管理页与 `/agent <id>` 命令直接复用这条提示。
- **cc-switch 白名单补齐**：`GET /cc/views` 新增 `skills-repos`（已添加的技能仓库）与 `mcp-validate`（校验命令是否在 PATH）；`GET /cc/exec` 新增 `failover-move`、`mcp-set-apps`、`prompt-rename`、`proxy-listen-address`、`proxy-listen-port`、`cc-update-check`、`cc-update`（cc-switch 自升级二进制，与运维中心的安装脚本互不替代）。清单由服务器下发，App 不需要发版就能看到这些新项。
- **一条 `arg` 带两个值**：App 每个命令只弹一次输入框，因此 `failover move p1 up`、`mcp set-apps fs open-code,codex`、`prompts rename review 新名称`、`proxy config address 127.0.0.1` 用一个 `arg` 传；服务器按空格拆开，前一段走 `assertSafeId`，后一段按命令各自校验（方向 `up/down`、应用列表按 cc-switch 的 `--apps` 词表、端口须为数字、名称 ≤80 字且不得以 `-` 开头），不会再执行半截命令。
- **cc-switch 通用透传**：新增 `POST /api/v1/cc/run {args, confirm?}`，等于 Telegram 的 `/cc run <任意参数>`——白名单没覆盖的写法（`mcp enable fs --apps opencode`、`skills install owner/name --yes` 等）App 也能执行。判定与聊天共用新模块 `src/ccGuards.ts`：交互式/常驻命令回 400 并给出可改用的写法，需要确认的形状先回「需要确认」、带 `confirm: true` 重发才执行（并补上 cc-switch 自己要的 `--yes`/`--confirm`），`provider use|switch` 走与按钮同一条切换路径，`deeplink` 指向 `POST /cc/deeplink`；响应里的 `command` 只回显前三段且已脱敏。App 侧聊天框里解析不了的 `/cc …` 词组自动落到这条通道，需要确认时弹出与 Telegram 相同的确认框。
- **自定义模型的能力参数三端同解**：`POST /api/v1/models/custom` 早先就接受 `attachment`/`contextWindow`/`outputLimit`/`desc`，但 App 只发前三项里的 `label`；现在 App 的添加框直接写一行 `mymodel custom/x 我的模型 --attachment --context 200000 --output 64000`（与 Telegram 的 `/cc model add` 同一套词，含 `--vision`/`-a`/`--ctx`/`--max-output` 别名与 `--context=200000` 写法），服务器把没写进 `opencode.json` 的情况照 Telegram 的句式回在 `message` 里，`contextWindow`/`outputLimit` 不是 1–1000000000 的整数直接 400 且不落盘。

- **Hermes 记忆可编辑**：`GET /api/v1/cc/hermes` 一次回 `{limits, memory, user, memoryEnabled, userEnabled}`，`POST /api/v1/cc/hermes {kind, action, content?, confirm?}` 做 `set`/`clear`/`enable`/`disable`；App 新增「Hermes 记忆」页（抽屉与 cc-switch 页都可进），两份 `MEMORY.md` / `USER.md` 用多行文本框直接编辑，带字数与「有未保存的改动」提示、启用/停用开关、覆盖前确认框，写操作后采用服务器回的状态而不是本地草稿。`src/ccGuards.ts` 补上三词判定：`hermes memory open-dir`（会开服务器文件管理器）在两端都拒绝，`set`/`clear` 需要确认，且 `clear` 由服务端补 cc-switch 自己要的 `--yes`——不带它时 cc-switch 只打印拒绝并以 0 退出，看起来成功实则什么都没做。内容按一个 argv 词交给 CLI，换行原样保留；空内容、超 20000 字、含换行/制表符以外的控制字符一律 400 且不落盘；字数超过 Hermes 的加载预算时 `message` 附截断警告（预算从 `limits` 原文宽容解析，措辞变了就不提示而不是猜）。`/cc help` 同步列出这些形状。

- **工作目录可以点选**：新增 `GET /api/v1/dir/browse?path=`，列出服务器某一层的子目录（只列目录、跳过隐藏项与文件、软链接只在指向真实目录时列出、悬空链接丢弃、按不区分大小写排序、最多 200 条并标 `truncated`）。App 的会话设置页多出「浏览服务器目录…」：对话框里逐级点进去，「默认 / 主目录 / 运行目录 / 上一级」一键跳转，「选择此目录」走的还是原来那条 `POST /dir`——手机上手打绝对路径这件事终于不用再做一次。列举是纯读取：不写 `dir`、不重置 CLI 会话（测试专门断言这一点），路径解析复用 `POST /dir` 同一个 `normalizeWorkDirInput`，所以 `~`、相对路径、控制字符/超长/文件系统根目录的拒绝与设置目录时一字不差；`POST /dir/browse` 回 405，其它 `/dir/<子路径>` 回 404。

- **队列页也能重跑已结束的任务**：App 的任务队列页在实时列表下面新增「最近任务」，取 `GET /api/v1/tasks`（默认 50 条、上限 200，含 done/failed/cancelled）里已 settled 的记录，显示状态、耗时、完成时间、引擎、模型、附件数与失败原因，每条一个「重试」按钮直连 `POST /task/:id/retry`——即 Telegram `/retry` 的同一条路径，原始文本、临时模型与附件都来自服务器自己的副本。此前手机只能重跑聊天页里那一条：`/history` 的记录是清洗过的提示词、没有任务 ID，`GET /queue` 又只回排队/执行中的，所以早就结束的任务在 App 里根本没有入口。实时列表与记录列表按任务 ID 天然互斥（记录侧过滤掉 queued/running），两端都没有内容时才显示空态。

### 变更

- **会话级改动不再拆正在跑的任务**：`POST /new`、`POST /model`、`POST /dir`（含 `{reset:true}`，此前只有换目录有守卫）与 `POST /peers/follow` 在有任务排队/执行时统一返回 409「任务执行中，请先停止当前任务再…」，与 Telegram 按钮的拒绝同源；`POST /agent` 保留即时生效（它不重置上下文，只影响下一条任务）。`POST /task` 也补上 Telegram 的排队深度（4 条待处理，超出 409），App 的发送逻辑本就允许在执行中继续排队，`ApiClient` 因此把每主机并发上限从默认 5 提到 16，避免长连接的任务流把普通请求挡在后面。`POST /models/assign` 不再吞掉会话切换的失败：模型表写成功了但会话没跟上时，`sessionMessage` 会说明原因。App 的会话设置页在有任务排队/执行时直接写明这一点并附「停止」按钮（`vm.hasLiveTask`），不必先撞一次 409 才知道；「新建会话」也先给这句话，不再先清空本地聊天（此前会把执行中那条气泡一起抹掉，回复再也贴不回来）。
- 交互判定与确认判定从 `CcCommands` 私有方法迁到 `src/ccGuards.ts`，Telegram 与 HTTP API 共用一份；因此 Telegram 现在也对 `provider set-default`、`provider import-live`、`provider remove-from-config`、`auth default`、`daemon stop` 先要确认（App 的白名单早已要求，两端此前不一致），`/cc run` 与 `/cc …` 也不再放过 `-acodex` 这类紧凑写法的 `--app`。
- App 的 `/retry`（与错误横幅的「重试」）改为重发**上一条任务**，不再只看失败/已停止——与 Telegram 的 `/retry` 相同，成功的回答也能重跑；上一条仍在排队/执行时给出提示，本地文本补发只在任务已被服务器清理时发生（附件与临时模型由此不丢）。
- `provider export` 不进入只读视图表：不带 `-o` 时它会写出 `{cwd}/.claude/settings.local.json`，属于副作用。
- 通过 API/App 切换或恢复模型时，与 Telegram 一样丢弃上一个模型的会话上下文（OpenCode 删除会话、CLI 清 `cliSession`）；重复选中当前模型则保持上下文不变。

## [0.3.0] - 2026-11-03

### 新增

- **每日用量报告**：`USAGE_DAILY_REPORT` 开启后每天定时向白名单第一位用户推送跨聊天聚合的用量汇总；`/usage` 面板「📩 每日报告」随时预览；`GET /api/v1/usage/report` 供 App 与脚本使用；App 状态页新增「每日报告」卡片（含趋势条与分享按钮）；Telegram 新增 `/report` 命令。
- **语音转写（STT）**：配置任意 OpenAI 兼容 `/audio/transcriptions` 服务（OpenAI/Groq/本地 whisper）后，模型不支持音频输入时语音自动转写为文字，失败回退原提示；Telegram 与 HTTP API 两条路径均生效。
- **提醒延后（snooze）四入口**：投递消息按钮（10 分钟 / 1 小时 / 明天）、`/reminders` 面板「⏰+1h」、App 提醒列表三档延后（延后后列表立即同步）、`POST /api/v1/reminders/:id/snooze` 供脚本调用；服务端校验时长并拒绝重复提醒。
- **面板超量程浏览**：`/reminders` 与 `/schedule` 面板超量自动分页（⬅️/➡️ 翻页，`noop:` 页码指示）；`/history` 面板「⬇️ 更早 10 条 / ⬆️ 回到最新」渐进加载（`/history N` 上限提升到 50，到顶自动隐藏按钮）。
- **数据备份**：`/ops` 面板「📦 备份数据」把 `data/*.json` 打包成 tar.gz 发到聊天（不含配对令牌，`data/backups/` 保留最近 5 份）；`GET /api/v1/ops/backup` 下载同一份归档；App 运维页同样可备份并弹出分享保存。
- **检查更新（干跑）**：`/ops` 面板「🔍 检查更新」拉取远端并列出本地落后提交，不改动工作区；`GET /api/v1/ops/check-update`；App 运维页同款按钮。
- **启动通知**：每次成功上线自动向白名单第一位用户推送「✅ Bot 已上线」（版本号 + OpenCode 可达性），`STARTUP_NOTICE=0` 关闭。
- **App API 消息级加密**：`API_ENCRYPTION=1` 后，App 请求/响应体用 AES-256-GCM 加密（`x-enc: v1` 协议，配对密钥存 `data/api-enc-key.json` 并经 `/api` 二维码下发；明文请求渐进兼容，SSE、媒体流与导出/备份附件除外）；`/health`、`/status`、`/api` 与 App 设置页均显示加密状态。
- **状态可观测性**：`/status` 新增语音转写与每日报告配置行；App 设置页连接信息含加密标识。
- **Docker 部署**：Dockerfile（多阶段，内置 opencode CLI）+ docker-compose.yml（挂载 `data/` 与 `.env`）+ 入口脚本自动拉起 `opencode serve`。
- **持续集成**：GitHub Actions 在 Node 20/22 矩阵运行 `npm run check`（含安卓源码静态门禁），并构建 Docker 镜像验证。
- **对端会话（peers）**：`GET /peers`、`POST /peers/follow` 让 App 查看 Telegram 端正在使用的引擎/模型/目录并一键跟随（单向对齐）。
- **App 斜杠命令**：App 内输入 `/` 弹出与 Telegram 一致的命令表，并有 parity 测试保证两端命令永不脱节。
- **安卓源码静态门禁**：`npm run check:android` 在无 Android SDK 的环境检查必需 Kotlin 源文件、括号/字符串闭合，并禁止 TODO() 占位与 println() 裸打印。
- **代码质量门禁**：`noUnusedLocals` 写入 tsconfig,死代码在每次 check/CI 强制清零;泄露回归测试断言身份端点永不携带 token 或密钥形态的值;engineCall 分发器(404 透明重建会话、模型解析)补齐直测。
- **App 抽屉重排**：「运行状态」上移到任务域之后(每日报告/加密标识不再沉底),代理与白名单相邻,配置/运维类收尾。
- **用户路径走查**：Telegram 欢迎页补 `/report` 与 `/export` 示例;App 分享导入失败的提示区分全部/部分失败并显示导入计数。

### 修复

- `/usage` API 的无 id 路由会吞掉 `/usage/report` 等子路径。
- `.gitignore` 的 `data/` 规则误吞安卓源码包 `com.agentbot.app.data`（已锚定为 `/data/`）。
- `.dockerignore` 误排除 docker-entrypoint.sh 导致镜像构建失败。
- 数据备份在 `data/` 目录缺失时报错、同一秒内两次备份相互覆盖。
- 消息级加密开启时 App 的错误提示不解密，只显示 "HTTP 4xx" 而非服务端真实错误消息。
- `/history` 面板在历史达到 50 条上限时「更早」按钮仍然显示（点击无效的死按钮）。
- App 备份缓存目录随多次备份无限增长（现保留最近 3 份）。
- 数据备份的归档清单漏了后来新增的 `api-enc-key.json`——消息加密配对密钥会被打进 tar.gz 发到聊天（现与配对令牌一样排除）。
- App 分享导入全部附件读取失败时，提示仍说「部分」无法读取。

## [0.2.0] - 2026-10-31

### 新增

- 安卓客户端（Grok 风格原生 App）：聊天/Markdown 渲染/附件/语音/SSE 进度/后台通知/队列/引擎与模型切换/cc-switch 控制台/运维中心，通过内置 HTTP API 控制同一 bot。
- HTTP API `/api/v1`（Bearer 鉴权）：任务提交与 SSE 事件流、提醒/定时任务、自定义模型、cc-switch、运维与配置管理；Telegram 发 `/api` 扫码配对。
- cc-switch 集成与模型管理（`/cc` 面板、`/cc model`、`npm run models`）。
- 定时提醒与定时 AI 任务、任务历史与导出（`/export`）、使用统计、快捷指令（`/alias`）、网络代理管理。

## [0.1.0] - 2026-10-27

### 新增

- 首个可用版本：Telegram Bot 桥接本地 `opencode serve` 与 14 种 Agent CLI，首次连接向导、白名单、附件收发、进度卡片、单实例锁与会话持久化。
