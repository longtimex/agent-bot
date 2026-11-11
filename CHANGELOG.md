# 更新日志

本项目的显著变更记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.4.0] - 2026-11-08

### 新增

- **独立 release 更新链路**：`/update` 不再在原地 `git pull`，而是在 `data/releases/.staging-*` 中克隆目标分支、执行 `npm ci`、发布门禁与构建；通过后标记为 pending，重启后才激活。启动健康检查失败会自动切回上一版，状态与保留策略写入 `data/releases/state.json`，默认保留 3 个 release。
- **stable / beta 更新通道**：`UPDATE_CHANNEL=stable|beta` 与 `UPDATE_BRANCH` 决定更新目标；`/ops` 与 App 版本卡显示当前通道和 release 指针。
- **启动自检与数据快照**：启动时在 `data/startup-check.json` / `startup-checks.jsonl` 记录版本、commit、PID、数据迁移结果和 API 状态；升级前自动备份状态文件，首次启动新 schema 时在 `data/snapshots/` 生成只读快照。
- **Android 在线更新**：服务端可从 `data/android-release.json` 提供经 Bearer 鉴权的 APK 与 SHA-256；App 设置页显示当前/服务器版本、更新说明和大小，下载时流式写入 `.part`、校验大小与 SHA-256，再交给系统安装器。APK 下载端点跳过消息级加密头，避免二进制被误当 JSON。
- **正式签名 CI 与发布脚本**：Android 工作流读取 `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`，执行 `assembleRelease` 并用 `apksigner` 验证；缺少 Secrets 会直接失败。新增 `npm run release:android`，把已签名 APK 复制到 `data/android/releases/` 并原子写清单。
- **systemd 统一入口**：新增 `scripts/run-current.sh`，unit 的 `ExecStart` 始终启动 `data/releases` 中的 current release（首次部署回退 checkout 的 `dist/index.js`）；`RELEASE_SUPERVISOR=systemd` 时由 `apply-release.sh` 激活并重启，健康检查失败自动回滚。

### 变更

- **版本**：服务端 `0.4.0`，Android `1.1.0`（`versionCode 1001000`）。
- **Android APK 改为 CI 正式签名构建**：`android-v*` 标签执行 `assembleRelease`，发布 `agent-bot-v<版本>.apk`、`.sha256` 与 `android-release.json`；不再发布 debug 签名的 APK。
- **运维按钮安全**：App 的「应用 pending 并重启」「丢弃 pending」「回滚到上一版」改为先弹出确认框，与 Telegram 的一次性确认语义一致；有运行中任务时服务端仍返回 409。
- **更新接口**：新增 `GET /ops/release`（轻量 release/启动自检视图）、`POST /ops/rollback`、`POST /ops/cancel-pending`、`GET /android/release` 与 `GET /android/release/apk`；`GET /health` 增加 PID、commit 与 release。
- **文档**：README 与 android/README 更新为独立 release 构建、systemd 应用流程、Docker 需重建镜像、正式签名迁移与 APK 校验说明；旧的原地 `git pull --ff-only` 更新说明已移除。

### 修复

- 配对加密开启时 `/android/release` 的 JSON 现在走统一响应器，与其它 JSON 端点一样加密并带安全头；APK 原始字节仍保持明文。
- `apply-release.sh` 在没有 pending 时也会重启 current release，而不是错误地启动 checkout；systemd 下由 Bot 触发的重启使用 `systemd-run`，避免 installer 被自身重启杀死。
- Android 清单中的 APK 大小若与文件不一致会在加载时拒绝，而不是等到下载后才失败。

## [未发布]

### Android 1.1.4

- **长任务不再在十分钟被截断**：Telegram、飞书与 Android 共用后端任务层，过去无活动超时与任务总耗时上限都默认 10 分钟；即使任务持续有进度，也会在十分钟时被硬上限终止。现在无活动超时仍为 10 分钟，用于发现真正卡死的任务；总耗时兜底默认 24 小时，设为 `0` 可关闭。OpenCode 额外轮询 `/session/status`，只有会话仍为 `busy`/`retry` 时续期，SSE 暂时没有新事件的长工具调用不会再被误杀；CLI 持续有输出时同样不会被总耗时上限提前终止。
- **修复聊天搜索编译**：补回 `ChatSearchBar` 使用的 `FocusRequester` 导入，确保真实 Android release 构建通过。

- **附件大小一致**：待发送附件与已发送气泡共用 `formatFileSize()`；小于 1KB 的文件显示精确字节数（例如 `34B`），不会再出现待发送时 `1KB`、发送后 `34B`。
- **队列读失败保留旧数据**：刷新任务队列时，只有 `queue` 与最近任务都成功读取后才替换列表；任一读取失败会保留旧行并显示原因，空列表冷启动失败时给出完整错误与重试。
- **操作失败留在原页面**：配置、白名单、代理、快捷指令、会话设置、模型、队列与定时任务等写操作失败时在各自页面展示原因，不关闭正在编辑的弹窗；删除和清空操作先确认。
- **发送失败不丢输入**：App 发送失败会把提示词放回草稿，并保留本次选择的一次性引擎/模型，避免重试时悄悄换引擎；新增契约测试固定这一行为。
- **配对与凭据页面**：配对失败会留在设置页说明旧配置是否保留，令牌与加密密钥默认遮蔽并可显式查看；地址字段支持较长的 Instabox 主机名。
- **发布门禁**：Android 标签必须与 `android/app/build.gradle.kts` 的 `versionName` 一致；发布工作流先跑完整项目检查，再签名构建并校验 APK 签名。

### 新增

- **统一生命周期 CLI**：新增 `npm run bot -- <command>`，统一 `install`、`setup`、`doctor`、`status`、`logs`、`run`、`start`、`stop`、`restart`、`update`、`opencode` 与 `uninstall`。script/systemd supervisor、PID/锁身份、current release、安装清单和健康检查共用 `src/runtime.ts`，旧 `npm run restart`、`scripts/restart.sh`、`scripts/apply-release.sh`、`scripts/run-current.sh` 保留为兼容入口。
- **安全卸载**：新增 `npm run bot -- uninstall`。默认停止服务并删除受管 launcher/unit，但保留 `data/` 与 `.env`；`--purge-data` 才删除数据，`--dry-run` 只打印动作，`--yes` 供非交互环境使用。只删除带 `managed by agent-bot` 标记的文件，并在任何破坏性操作前拒绝 `/`、项目根与包含项目目录的 `DATA_DIR`。
- **systemd 发布切换**：`npm run bot -- restart` 在 systemd 下会先激活 pending，再重启 unit、等待本次启动健康检查；失败自动回滚并重启旧版本，成功或回滚结果写入 `data/releases/state.json`。安装器同时启用 Bot 与本机 OpenCode unit。

### 变更

- **安卓 UI 层级与导航重做**：抽屉从 18 项平铺改为「对话 / 自动化 / 智能体与工具 / 服务器」分组，顶部显示连接状态、默认引擎和队列角标，并将「新对话」做成主操作；聊天顶栏收敛为模型芯片、连接点、搜索和溢出菜单，会话设置、队列、状态与设置不再挤占标题栏；空会话提示可直接填入三条常用任务，助手气泡增加身份标签、失败/停止状态和更清晰的复制与重试操作。
- **安卓视觉系统统一**：扩充 Material3 Typography、Shapes、表面色与描边 token，新增共享 `ScreenHeader`、`SectionLabel`、`AppCard`、`StatusPill`、`EmptyState`；设置、运行状态、历史、提醒、定时任务、帮助，以及会话、队列、引擎、模型、cc-switch、magpie、Hermes、配置、白名单、代理、运维等页面全部使用统一标题层级、卡片边框与空状态；二级页新增「返回聊天」按钮，聊天输入区改为带聚焦边框的整合 composer，窄屏信息密度更稳定。连接点补充读屏状态说明，任务运行时抽屉会禁用「新对话」并显示原因。
- **安卓配对与网络诊断**：设置页会预览实际请求的 `/api/v1`，并在手机回环地址或公网明文 HTTP 时给出警告；扫码只导入地址、令牌与加密密钥，不再立即保存。保存时先对候选地址执行健康与会话探测，成功后才替换旧配置；失败留在设置页显示中文原因，旧连接及其在线状态不受影响。DNS、超时、拒绝连接与 TLS 证书错误统一改为可操作的中文提示。
- **Instabox 云电脑教程**：README 新增从空机到手机聊天的完整示例，覆盖 `instabox-port publish` 首选方案、Cloudflare 临时隧道、Tailscale 长期方案、`smoke:app` 链路验证、配对步骤与常见问题；android/README 的暴露方式表同步加入 Instabox 端口发布。
- **`npm run setup` 串接可选工具安装**：客户端配置成功后会继续检测 Agent CLI、magpie 与 cc-switch，并列出未安装项供按编号多选安装；工具阶段失败不会撤销已保存的 `.env` 或让客户端配置失败。`npm run clients` 保持只管理控制端，首次启动的自动向导只完成客户端配置，不额外下载工具。新增 `npm run setup -- --check-tools`（只检测）与 `--no-tools`（跳过）；`install.sh` 将 `--tools` / `--check-tools` / `--no-tools` 传入同一次向导，避免重复检测。新增 `npm run setup:tools` 供单独管理工具。
- **安装与运行入口收敛**：README 与安装脚本提示统一使用 `npm run bot -- start/restart/status/doctor/logs`；`install.sh --systemd` / `--user-systemd` 在不带 `--start` 时也会安装 unit，并校验互斥参数与 `--skip-build` 的 `dist/bot-cli.js`。

### 修复

- **新会话不再先清空本地聊天**：`newChat()` 改为等服务端接受重置并返回新会话后才清空气泡与媒体缓存；请求失败时保留当前对话，不会出现“界面已清空、服务端仍保留旧上下文”的错位。
- **CI 的 Node 20 兼容性**：`undici` 从 8.x（要求 Node ≥22.19）降到 7.30.2（支持 Node ≥20.18.1），修复 Node 20 runner 在导入阶段因 zstd API 缺失导致的 11 个测试文件崩溃；`engines`、安装脚本和 README 的 Node 下限同步为 20.18.1，CI 继续覆盖 Node 20/22 并新增 Node 24。诊断测试显式固定 `systemd` 状态，避免 GitHub runner 自身运行 systemd 时误报。
- **无 API 部署的发布健康检查**：`apply-release.sh` 在启动/重启前记录时间边界；`release-health.mjs` 在 `API_ENABLED=0` 或缺少令牌时改读 `data/startup-check.json`，并要求 release、时间与脚本监督的 PID 都对应本次启动。过期的成功记录、其它 release 或启动失败记录都会被拒绝，Telegram/飞书-only 部署不再因探针失败而每次更新都回滚。
- **启动自检时序**：成功的 `data/startup-check.json` 现在写在各控制端启动之后，并记录 checkout 状态（release=`checkout`）、引擎与各控制端状态，避免 API 已监听但 Telegram 初始化失败时被误判为健康。
- **CI 签名核验**：Android 发布工作流使用 `$ANDROID_HOME/build-tools/35.0.0/apksigner`，并把 APK 签名证书 SHA-256 与 `ANDROID_KEY_ALIAS` 对应证书指纹逐字比对；发布清单补上 `size`，与本地发布脚本一致。
- **Gradle keystore 路径**：`android/keystore.properties` 中的相对 `storeFile` 现在以 `android/` 根目录解析，避免被误解析到 `android/app/`。
- **架构门禁**：`/ops/release` 的轻量视图拆到 `src/releaseStatus.ts`，`release-control.ts` 显式登记为 knip 入口；移除未使用的 release 辅助导出以恢复 knip/lint/体积门禁。

### 优化

- **API 防爆破与响应加固**：`/api/v1` 现在按客户端地址统计失败的 Bearer 认证（60 秒内 10 次后暂停 5 分钟），JSON 响应统一带 `no-store`、`nosniff`、`DENY`、`no-referrer` 与 `default-src 'none'` 安全头；请求/头部/空闲连接超时收敛到 120s/30s/5s，大于 1KB 的 JSON 在客户端声明 `gzip` 时压缩返回。
- **任务记录回收补齐**：任务超过 200 条被清理时，同步删除该任务的 SSE 订阅与节流时间戳，避免长期运行时按任务 ID 累积的小对象。
- **超大源文件拆分**：cc-switch 路由与白名单表拆到 `src/apiCc.ts` / `src/apiCcSpecs.ts`，HTTP 基础类型拆到 `src/apiCore.ts`；内置 Agent CLI 档案拆到 `src/agentProfiles.ts`，Telegram 的纯格式化/时间/ID 辅助拆到 `src/telegramSupport.ts`。`src/api.ts` 由 2655 行降到约 1200 行，`src/agentCli.ts` 由 1357 行降到约 1060 行，`src/telegram.ts` 由 4263 行降到约 2106 行（统计面板、个人数据面板、核心面板、个人命令、模型命令、运维命令、Agent 命令、代理命令、访问/时区命令、入站附件、信息/导出命令与出站媒体分别拆到 `telegramStats.ts` / `telegramPersonalPanels.ts` / `telegramCorePanels.ts` / `telegramPersonalCommands.ts` / `telegramModelCommands.ts` / `telegramOpsCommands.ts` / `telegramAgentCommands.ts` / `telegramProxyCommands.ts` / `telegramAdminCommands.ts` / `telegramAttachments.ts` / `telegramInfoCommands.ts` / `telegramMedia.ts`）。`src/api.ts` 进一步降到约 1036 行，任务路由独立为 `src/apiTaskRoutes.ts`，运维路由独立为 `src/apiOpsRoutes.ts`，自定义模型路由独立为 `src/apiModelRoutes.ts`。API 的任务队列、SSE、重试与附件处理独立为 `src/apiTasks.ts`，路由只负责解码并调用服务，对应 T3 Code 的「transport 保持轻薄，能力放在 service」约定。
- **质量门禁**：新增 oxlint（`.oxlintrc.json`）与 `npm run lint`、knip（`knip.jsonc`）与 `npm run knip`，并接入 `npm run check` / CI；修复了未使用导入、无用转义、无意义 spread 等问题。
- **模块级回归测试**：新增 `tests/telegramAdminCommands.test.ts`、`tests/telegramProxyCommands.test.ts`、`tests/telegramAttachments.test.ts`、`tests/telegramAgentCommands.test.ts`、`tests/telegramInfoCommands.test.ts`、`tests/apiTaskRoutes.test.ts`，覆盖白名单锁死/空名单、时区写入失败、代理操作、附件分类上限、Agent 安装前置检查、信息面板与任务路由。
- **架构门禁**：新增 `docs/ARCHITECTURE.md` 记录分层与模块边界；新增 `scripts/check-size.mjs` 与 `npm run check:size`，对 `src/*.ts` 执行行数预算，防止已拆分文件重新膨胀。

### 变更

- **Android APK 改为 CI 构建（历史记录，已由 0.4.0 的正式签名发布取代）**：`android-v*` 标签由 GitHub Actions 安装 JDK 17、Android SDK 35 与 Gradle 8.9，按标签写入 `versionName` / `versionCode` 后构建并上传 GitHub Release；仓库不提交 `android/releases/` 下的二进制 APK，避免每次发版给 Git 历史永久增加约 18MB。0.4.0 起改为 `assembleRelease` + 强制 Secrets + `apksigner` 验证，不再发布 debug 签名包。
- **深度审查台账入库**：`DEEP-100.md` 记录当前 42/100 轮审查进度；早期并行审查的重复轮次编号已在文首说明，后续从第 43 轮继续。

### 新增

- **统一控制端安装向导**：`npm run setup` / `npm run clients` 现在共用同一个可重复运行的多选向导，支持 Telegram、安卓 App 与飞书，并可一次选择多个控制端。向导会标记 `[已配置]` / `[未配置]`，Telegram 继续自动识别 owner；安卓向导生成固定 `API_TOKEN`、校验手机可达的 `API_PUBLIC_URL` 并直接打印配对地址；飞书向导校验 App 凭据、open_id 白名单与可选卡片回调验签配置。重复运行只更新选中的控制端，保留 `.env` 注释与其他配置。`install.sh` 的交互式安装改为启动该向导，新增 `--setup`，并在结束后提示用 `npm run clients` 继续添加客户端。仅监听 `0.0.0.0` / `::` 且没有 `API_PUBLIC_URL` 不再被误判为已配置的安卓控制端。

- **飞书第三控制端**：新增企业自建应用接入，私聊消息通过长连接接收；交互卡片按钮通过可选的 HTTP 回调入口接收（飞书 SDK 长连接只分发事件、不分发卡片回调）。两者都会转换为内部 Telegram 更新，复用同一套命令、面板、会话队列、附件、提醒、定时任务、统计、白名单与运维能力；飞书与 Telegram 会话使用独立的 `fs:` / `tg:` 键，群聊忽略。支持图片、文件、音频、视频、富文本、按钮、二维码、导出与出站媒体，飞书-only 部署也可独立运行；访问控制走 `/access` 自动识别当前渠道，`open_id` 与 `chat_id` 映射持久化在 `data/feishu-identities.json`。未启用回调时文字命令仍可用，但面板按钮不可用；回调必须配置 Verification Token 或 Encrypt Key 验签。

- **magpie 模型网关集成**：新增 `/magpie` Telegram 面板与命令（Provider 列表/模板、各 Agent 模型切换、路由组、配额、用量、设置、账号、守护进程、同步/更新），以及 `/api/v1/magpie/*`（概览、视图清单、只读视图、白名单 exec、通用 run、Provider/Agent/路由组写入）。CLI 封装在 `src/magpie.ts`，白名单与确认规则在 `src/magpieGuards.ts` / `src/apiMagpieSpecs.ts`，路由在 `src/apiMagpie.ts`，Telegram 在 `src/telegramMagpieCommands.ts`；新增 `MAGPIE_BIN` / `MAGPIE_URL` 配置，密钥与 Token 输出自动脱敏，交互式/常驻命令（`tui`/`web`/`serve`/`plugin`/`accounts add`/`gateway-key` 等）在聊天与 API 中一律拒绝。安卓 App 新增「magpie 网关」页（概览、只读视图、命令执行与二次确认），并接入 `/` 命令表、抽屉与主菜单按钮。

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

### 修复

- **cc-switch 子进程不再继承 bot 凭据**：`CcSwitchService` 用 `extendedEnv(process.env)` 组装环境，是所有 spawn 点里唯一漏掉 `scrubEnv` 的一个（Agent CLI 走 `childEnv`、安装器走 `installerChildEnv`）；`TELEGRAM_BOT_TOKEN`、`API_TOKEN`、`OPENCODE_SERVER_PASSWORD`、`STT_API_KEY` 因此对一个第三方二进制可见，而它的 argv 由用户消息决定、`env tools` / `env check` 还会把环境信息原样打回聊天。现在同样只剥 bot 自己的凭据，Provider 的 `ANTHROPIC_API_KEY` 之类照常可见。
- **回显用户输入的地方统一转义 Markdown**：取消提醒的确认（`✅ 已取消提醒 #id：<原文>`）、状态面板的引擎名与模型名、`/model` 未识别参数都直接内插了用户或数据文件里的文本，一条内容为 `*bold* _under_` 的提醒取消后那条回执自己会解析失败（`tests/telegram.test.ts` 固定这一行为），自定义 `agents.json` 的 label 或自定义模型名带下划线时整个状态面板发不出去。
- **长回复分片不再超出长度上限**：`splitMessage()` 在「内联代码跨度太长、只能提前收尾」的分支里把关闭反引号加在分片之外，导致该分片比 `max` 多 1 个字符（Telegram 直接拒发 4000+ 的消息），`tests/messages.test.ts` 里「每片都不超过 max」的既有断言其实一直被绕过。现在收尾反引号从同一份预算里支出：预算不够时把最后一个字符交回下一片（沿用 `pickCut` 的代理对保护），并按实际反引号奇偶决定是否补标记，而不是无条件追加。
- **面板翻页按钮重新生效**：`#panelFor()` 用 `switch (which)` 匹配整个回调串，而翻页按钮的数据是 `show:reminders:2`、`show:schedule:2`、`show:history:20`，于是全部落到 `default: return undefined`——点「下一页 / 上一页 / 更早 10 条 / 回到最新」只有按钮变灰、面板原地不动，`case "reminders"` 里那句 `which.split(":")[1]` 也永远读不到参数。改为先按面板名分派、再取参数（`tests/telegram.test.ts` 新增翻页回归测试）。
- **cc-switch 的调用方错误不再伪装成服务端故障**：`#ccQuery()` / `#runCcAction()` 把闭包里抛出的任何异常一律重包成 502，而 `ccTargetId()` 正是在闭包内对非法 ID 抛 `ApiError(400)`，于是 `GET /cc/quota?id=-x` 回 502、`tests` 之外没有任何地方告诉 App「这是你参数写错了」，README 承诺的 400 也落空。现在 `ApiError` 原样透传，只有真正的 CLI 失败才记 502。
- **CLI 退出后遗留进程占着管道不再吞掉答案**：`agentCli.prompt()` 只在 `close` 事件上结算，而 `close` 要等所有管道 EOF——被调 CLI 派生出一个继承 stdout/stderr 的常驻助手（MCP server、npm shim）时，`close` 永不到来，10 分钟硬超时把已经拿到手的 `{"result": …}` 当作「执行超时」丢弃，并留下一个 `#active` 僵尸条目。`ops.ts` 的同形缺陷更糟：它的 `finish()` 只能由 `close` 触发，超时又只发信号不结算，整个运维步骤会永久挂住并把 `#opsActionRunning` 锁死，后续运维请求全部 409；`agentInstaller` 则把安装成功报成 `timedOut`。三个模块现在共用新拆出的 `src/childKill.ts`：进程 `exit` 后开启 `EXIT_DRAIN_MS` 排水窗口（仍有输出就重新计时），窗口内没等到 EOF 就先给该进程组发终止信号（回收孤儿、释放管道）再结算。同时 `terminateProcess()` 的 SIGKILL 升级原先只看 `stdioDrained()`，一个「自己关流但无视 SIGTERM」的 CLI 会永远活着而组内进程从不被信号触达；现在管道是否排空与进程是否存活分别判定。
- **安装日志保留失败原因**：`POST /agent/:engine/install` 的 `output` 此前取前 20000 字，而 npm/pip 的报错打在末尾，长日志会把失败原因整段截掉；改为与 `api.ts` 运维步骤一致的取尾。
- **cc-switch 执行失败与参数错误分档**：`CcSwitchService` 把「命令跑完但退出码非 0」和「字段没写对」都抛 `CcSwitchError`，`POST /cc/providers` 因此一律回 400，App 面对「该 Provider 名称已存在」这种上游拒绝也只能当作自己参数错、反复重试；新增 `CcSwitchRunError` 子类，路由按 502 透传 cc-switch 的原始说明（仍经 `redactSecrets`），校验类错误继续走 400。
- **`provider add` 失败回显里不再漏 key**：cc-switch 在创建失败时会把刚收到的 settings 整段打印出来，`errorDetail()` 只认得带标签的密钥格式，一串没有 `api key:` 前缀的裸 key 会原样进聊天与 App；现在 `addProvider()` 在拒绝路径与正常输出上都按本次提交的 key 精确替换为 `***`。
- **cc-switch 升级后不必重启 bot**：`get bin()` 与 `version()` 各自把结果缓存在实例上一辈子，`npm run cc-switch:install` 换掉 `bin/cc-switch` 或 PATH 里的副本后，面板继续显示旧版本、命令继续跑旧二进制，直到进程重启——这与 `src/binPath.ts` 对 Agent CLI「每次调用重新解析」的既定策略正相反。现在 `bin` 每次都重新解析，版本缓存以解析到的文件 `mtimeMs:size` 为键，文件一变即失效（`tests/ccswitch.test.ts` 用替换假二进制的办法固定这条行为）。
- **代理监听端口按端口判定**：`proxy-listen-port` 的第二个值只按「1-5 位数字」校验，`99999` 会一路传给 cc-switch 当成监听端口，症状是代理突然不通而不是一个可修正的 400；校验类型改名 `port` 并加 1–65535 区间。
- **Hermes 记忆写入成功不再被报成失败**：`POST /cc/hermes` 写完立刻用三个 `hermes memory show/limits` 刷新状态，任一读取抖动都会经 `#ccQuery()` 变成 502，用户看到的是「操作失败」并重复一次已生效的写入。现在刷新失败仍回 200 与写入结果，只是带上 `refreshed: false` 且不带状态字段；App 收到这个标记就保留上一次读到的内容，绝不用空字段覆盖编辑器（否则下一次保存会把记忆写成空的）。
- **任务历史「更早 10 条」真的往前翻**：`historyPanel()` 的按钮按请求条数生成 `show:history:60`，而渲染在 3200 字处截断——一条长 prompt 就能把预算吃满，于是每次点按钮都重新渲染同一批最新记录，更早的永远点不到。改为按真正渲染出来的条数翻页（`src/history.ts` 的 `list()` 增加 `offset`，回调变成 `show:history:<每页条数>:<偏移>`），标题也改成「第 A-B 条 / 共 N 条」，越界偏移会收敛到最后一页；新增 `tests/telegramStats.test.ts` 覆盖截断翻页。
- **模型按钮绑定模型本身而不是排位**：`cmodel:<engine>:<index>` 在档案热重载（`/agents` 改写 `agents.json`，`registry.get()` 每次都会重读）之后按新顺序取第 index 项，用户点的是 Beta、切过去的可能是 Alpha，回执还照常打印「已切换至 …」。按钮现在直接携带模型 ID（超出 Telegram 回调数据 64 字节时退回旧的下标格式），处理器优先按 ID 命中，旧面板的下标写法继续可用。
- **API 停机不再等客户端**：`stop()` 先 `await server.close()` 再 `closeAllConnections()`，而 `close` 要等所有连接结束——App 挂着一条任务 SSE 流时这两步的顺序等于永远等不到第二步（实测 4s 以上，端口迟迟不释放）。现在给在途请求 1 秒宽限后强制断连；`listen()` 成功后不再遗留那个 `once("error", reject)`，并补上常驻的 `error` 监听，避免运行期一次 socket 错误直接把整个进程带崩。

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

- **凭据不再外泄到可读渠道**：`redactSecrets` 补上裸 Telegram bot token 规则（`123456789:AAH…` 这种没有 `key=` 前缀的形式此前能躲过所有替换），并接到 `Logger` 的唯一出口上——`bot.log` 可由 `/logs`  tail、也会被复制进 bug 反馈，此前任何一行都可能带着 token；代理测速失败、添加代理失败与会抛给聊天的服务层错误也统一脱敏（undici 会把带 `user:pass@` 的代理 URL 原样写在错误里，聊天会逐字回显）。
- **引擎子进程拿不到 bot 自己的凭据**：`BOT_ONLY` 剥离表补 `API_TOKEN`、`STT_API_KEY`、`SNIPER_EMAIL`、`SNIPER_PASSWORD`。所有 CLI 档案都带 `--dangerously-skip-permissions` / `--approval-mode yolo` 一类免审批开关，模型一旦被提示词注入，`process.env.API_TOKEN` 就等于配对码泄漏。
- **状态文件真正落盘**：新增 `writePrivateAtomic()`（写临时文件 → `fsync` → rename → 两端 `chmod 0600`），`store` / `usage` / `history` / `reminders` / `scheduler` / `proxy` / `agentInstaller` / `api` 的 token 与加密密钥共 9 处写入点迁过去。此前只 rename 不 fsync，断电后可能留下「已 rename 但被截断」的 JSON；`openSync(path,"w",0o600)` 的 mode 只在创建时生效，早已存在的世界可读 `api-token.json` 也借这次改写收回权限。
- **超长提示词不再随机死在 spawn**：`agentCli` 新增 `argvBudgetError()`，单条 120 KiB（Linux `MAX_ARG_STRLEN` 128 KiB）/ 合计 1 MiB 超限时直接返回中文可执行提示（建议切 OpenCode 引擎），并在分配会话 ID 之前检查，避免超限请求顺手吃掉会话上下文。此前表现为无信息的 `spawn E2BIG`。
- **OpenCode 事件流不再按会话翻倍**：`/event` 改为整个进程一条连接、按 `sessionID` 分发给订阅者（引用计数，最后一个订阅者走时关闭）。此前每个聊天各开一条，而 OpenCode 把所有会话的事件广播给每条连接，N 个聊天就是 N 倍连接加 N 倍无关 JSON 解析。
- **会话不再永久卡在「执行中」**：`#process` 把 `#cancels` / `#runningSince` 的登记移进 `try`，两者由同一个 `finally` 清掉；此前 try 之外的那几行若抛错，该聊天在取消表和忙判定里都留下无人回收的标记。
- **CLI 引擎不再静默丢掉图片**：`callEngine` 此前把 `files` 原样丢弃（Telegram 与 App 的任务路由都受影响），提示词里却写着「图片: /绝对路径」，看起来像已经送到。现在明确追加一条 `[二进制附件]` 说明：文件只存在于清单里的路径、需要引擎自己读取，图片/音频/扫描件请改用 OpenCode 引擎。
- **提醒投递带回提醒本体**：`telegram.ts` 构造 `ReminderService` 时把投递回调写成 `(chatId, text) => …`（少接第三个参数在 TS 里合法，所以编译期毫无提示），`#deliverReminder` 里的 `if (reminder && …)` 永不成立——发送消息上的「10 分钟 / 1 小时 / 明天这个时候」三个按钮一直是死代码，`snooze:` 回调也从未可达。现在把 reminder 原样传下去。
- **延后提醒不再被投递吃掉**：`ReminderStore.postpone` 补 `runningAt` 判定。`tick()` 把提醒标为执行中后要等最长 20 秒的 Telegram 发送，这期间 App 的「稍后提醒」或面板的 `rpostpone` 会改 `dueAt` 并回成功，随后发送完成按「一次性提醒」直接把它删掉——用户以为延后了，实际什么都没留下。与 `ScheduleService.runNow` 用的是同一条守卫。
- **`POST /task` 校验顺序**：临时模型 pin 的校验挪到落盘附件之前。此前引擎/队列/模型都通过后才写 inbox，但模型名写错的那条分支在写之后：一个 400 请求能往收件目录留下最多 15 MB 无人引用的文件（要 24 小时才被回收），而客户端改正后重试会再留一份。
- **`POST /task/:id/retry` 不再假装带着附件跑**：重试是重新读 inbox 里的原始副本，而超过一天的文件已被 prune，此前读失败被 `catch {}` 吞掉。现在文本任务的重试提示词里会写明几个附件读不到；纯附件任务（提示词本来为空）直接 410，不再把一个空提示词送进引擎。
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
