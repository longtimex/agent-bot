# Agent Bot 安卓客户端

控制云端 agent-bot 的原生安卓应用。界面参考 Grok 安卓版：暗色为主、居中对话、抽屉导航。
Bot 的 Telegram 控制方式不受影响——App 通过 bot 进程内置的 HTTP API(`/api/v1`)工作,
两者可以同时使用，共享提醒、定时任务、用量统计与运维能力。

## 功能

- **聊天**：发送提示词，实时显示排队/思考状态与回复；长任务一键停止；只有贴着底部时新消息才自动跟随，向上翻阅历史不会被拉回，滚动后右下角出现「回到最新」；回复支持 Markdown（代码块、列表、引用、链接），代码块与整条回复都可一键复制；收到的图片点开即全屏查看，支持双指缩放与拖动
- **发送保护**：发送失败（断网、服务重启）时提示词自动回到输入框，已选附件保留，可直接重发，不会丢内容
- **会话内搜索**：顶栏放大镜按关键词（不区分大小写）过滤当前聊天记录，命中结果按时间列出并显示上下文摘录；点任意结果回到对话并滚动到对应消息，返回键或「取消」退出搜索
- **快捷命令**：命令面板与 Telegram 同源——`GET /help` 除文案外还下发 `commands`（Bot 回答的全部命令词与说明）与 `aliases`（`tz`/`reset`/`svc`/`maintenance` 等等价写法），App 打开 `/` 面板时静默取回，Bot 侧新增命令无需发版即出现在列表里（App 只能跳页的命令会跳到对应页面并提示参数在页内操作，绝不会被当成提示词发给 Agent）。带参数的命令也直接执行：`/agent claude`、`/model sonnet`、`/model default`、`/dir ~/code`、`/dir reset`、`/timezone Europe/Berlin`、`/queue clear`、`/remind 30m 喝水`、`/cancel 12`、`/schedule add 每天 09:00 检查服务器`、`/history 50`、`/env set KEY 值`、`/env unset KEY`、`/access add 123`、`/alias add code 审查当前代码`、`/export json`、`/logs opencode 200`、`/proxy add http://127.0.0.1:7890 本地代理`、`/proxy use 2`、`/proxy test 2`、`/proxy del 2`、`/proxy off`、`/service opencode status|start`、`/cc provider current`、`/cc auth list`、`/cc sessions show <会话 ID>`、`/cc prompts use review`、`/cc skills repo add owner/name`——与 Telegram 用同一套参数写法；`/cc` 的词组与英文别名（`provider rm`、`skills del` 等）来自服务器 `GET /cc/views`、`GET /cc/exec` 下发的 `tokens`，App 不硬编码任何 cc-switch 命令词，解析不了的词组只提示并停在控制台面板。破坏性操作绝不被一条文字命令执行：`/restart`、`/update`、`/service opencode stop|restart` 会跳到运维中心、`/cc provider rm <ID>`、`/cc sessions del <ID>` 会跳到 cc-switch 控制台，各自弹出与 Telegram 相同的确认框，必须再点一次确认；需要目标 ID 却没写的（如 `/cc provider rm`）会先弹输入框。App 另有两个只影响**下一条消息**的写法：`/engine <id>` 临时换引擎、`/model! <id>` 为下一条消息选模型（不带参数即打开选择面板）。只有非命令的 `/开头` 文本（如 `/usr/bin/node 是什么`）与服务器上的 `/名称` 快捷指令才会作为提示词发出。
- **实时进度**：任务执行中显示服务端进度与已运行时长（每秒刷新），失败或已停止的气泡可直接重试/重新执行，不会重复插入提问；重试走 `POST /task/:id/retry`，由服务器用它自己保存的原始文本、引擎、临时模型和附件重放（与 Telegram `/retry` 同一份记录），只有任务已被服务器清理时才退回按本地文本补发；短暂断网（切换 Wi-Fi、服务重启）不会把仍在运行的任务误判为失败，恢复后自动继续同步并补发完成通知
- **后台通知**：App 在后台时，任务完成、失败或停止会发系统通知（含回复摘要，点击直接回到聊天页并滚动定位到该任务、短暂高亮；多条通知各自对应自己的任务）；Android 13+ 在任务开始后首次请求通知权限。若 App 进程已被系统回收，则仍由 Telegram 推送兜底
- **任务队列**：查看排队/执行中的任务，显示已排队/已运行时长（每秒刷新），停留期间每 5 秒自动同步状态（静默失败，不会弹错误），逐条停止，长任务运行期间仍可继续发送
- **会话设置**：查看/切换 CLI 工作目录、在线切换时区、恢复默认模型、新建会话，与 Telegram 的 `/dir`、`/timezone`、`/model default` 对应；OpenCode 会话的模型行连同 `provider/modelID` 一起显示（与 Telegram `/model` 面板标注当前模型的写法一致）；还能看到另一端会话（Telegram 聊天）的引擎/模型/目录与最近活动、今日/累计任务数，并一键跟随到 App 这边（`GET /peers`、`POST /peers/follow`，单向对齐、需确认）
- **附件**：点「📎」可拍照、从相册选图或选择任意文件（最多 4 个 / 共 15MB），与 Telegram 端附件能力一致；待发送的图片显示缩略图，发送后气泡内显示附件名与大小；不写文字只发附件也可以（服务端会补上对应图片/音频/文件的默认指令）
- **流式进度**：优先走 `GET /task/:id/events` 的 SSE 事件流，实时显示 agent 的思考/工具活动，断流自动回退轮询；顶栏状态点实时反映连接健康，点按直达设置页
- **语音消息**：输入框为空时右侧按钮变为麦克风，点一下开始录音（最长 2 分钟，界面显示计时），点「■」或到时后立即发送，行为与 Telegram 语音一致；录音需要麦克风权限（首次点击时申请），离开聊天页会自动停止录音并释放麦克风
- **系统分享**：从任意 App 的分享菜单选择 AgentBot，文本会填入输入框（可继续编辑），图片/文件自动加入待发送附件——只准备草稿，不会自动发送
- **回复媒体**：Agent 通过 `[[image|voice|video|file:...]]` 产出的图片在气泡内直接显示（点击全屏打开），语音/视频/文件显示为可点击卡片（打开或分享）；本地文件与远程链接走服务端同一套 SSRF/代理防护，媒体会缓存到本机，重开 App 不再重复下载
- **Markdown 渲染**：回复中的代码块（等宽、横向滚动、语言标签）、行内代码、加粗、斜体、删除线与链接（自动识别裸链接，点击用系统浏览器打开）正常排版，无序/有序列表与 `>` 引用块按块级排版（嵌套缩进、引用左侧竖线）；消息文本可长按选择复制，与 Telegram 的复制体验一致
- **本地持久化**：聊天记录与未发送的输入草稿保存在本机——切页、进程被杀后自动恢复，发送成功才清空
- **返回键**：先收起侧边抽屉；在其它页面按返回会回到聊天页，不会直接退出 App
- **前台刷新**：从后台切回 App 时静默刷新当前页与会话信息——聊天以外的每个页面（队列、状态、历史、提醒、定时、会话、引擎/模型、代理、cc-switch、配置、运维、快捷指令、白名单、帮助）都会重新拉取，静默失败不弹错误；正在执行的长操作（cc-switch 切换、运维动作）不会被刷新打断
- **引擎与模型切换**：顶栏芯片点开即切 OpenCode / Claude Code / Codex / Gemini 等引擎与模型；模型列表与 Telegram 同源，模型没有中文说明时副行直接显示可输入的值（OpenCode 的 `provider/modelID`、CLI 的别名），引擎只给提示不给列表时（如 `deepseek / qwen`）面板直接写明「模型由 CLI 自身配置，可用提示：…」，`/model <词>` 也认这些别名与提示里的 ID
- **单条消息换引擎/模型**：输入框右侧的「本条指定引擎」（🎚）可把下一条消息临时交给别的已安装引擎，并可为该引擎再点选一个模型（留空＝跟随该引擎默认，列表来自 `GET /models?engine=`，Claude/Qoder/Codex 等未列出模型时按默认执行）；发送后两项指定自动恢复默认，会话设置与 Telegram 端都不受影响，输入框上方显示「引擎 / 模型」并可一键取消；发送失败时指定会保留，重试仍发同一条请求
- **引擎管理**：与 Telegram 的 `/agents` 一致——查看安装状态、按内置 npm/pip 命令安装、更新或卸载 Bot 托管 CLI，破坏性操作会先展示完整命令并要求确认；页面顶部标出当前引擎，每个引擎卡片都有「使用此引擎」，一处即可完成 Telegram 里 `/agent <id>` 的切换（未安装的引擎标为 ⚠️，切过去后任务会失败），列表第一项始终是内置的 OpenCode，切到别的 CLI 后也能一键切回来；每张卡片还写明该引擎是否保留上下文（无状态引擎标「每次全新会话」）、模型能否由 Bot 切换，以及可输入别名（`/engine q`、`/engine claude-code` 与 Telegram 一样命中同一个引擎，别名与 `bin` 来自服务器 `GET /agents`）
- **模型管理**：与 `/cc model` 一致——查看/添加/删除自定义 OpenCode 模型（`简称 provider/modelID`），删除被引用模型时提示并可强制删除；Agent 绑定列表支持直接「设为模型」（同 `/cc model assign`，绑定 self 会切换当前会话）
- **cc-switch 控制台**：与 Telegram 的 `/cc` 一致——查看安装状态/版本/当前 Provider，每个 Provider 可切换（需确认）、测速、📡 流检、🧾 拉取模型、📊 配额，列表头部「＋ 新建」按 `/cc provider add` 创建 Provider（模板与 API 格式取自服务器，密钥只上传、不回显；OpenCode 等非 Claude/Codex/Gemini 应用会自动改为只填 settings JSON），MCP 列表/同步/导入（粘贴 `mcpServers` JSON）、提示词查看/启用/停用/新建（名称 + 内容）、环境检查/工具、代理状态，「只读视图」卡片整表来自服务器 `GET /cc/views`（配置、配置路径、会话列表/详情/消息、当前 Provider、认证状态/账号列表、技能列表/详情/仓库可用/更新检查、故障转移状态/队列/可选项、提示词当前/生效/内容、守护进程与其日志、设置；需要参数的先弹输入框），会话关键词搜索与 `ccswitch://` Deep Link 导入（覆盖配置前先展示链接并二次确认），「全部命令」直接跳到帮助页的 cc-switch 指令段（与 Telegram 的「📋 全部命令」同一份文案）；「高级操作」列出服务器白名单下发的命令（删除 Provider/MCP/提示词/技能/会话、安装技能、MCP 启用/停用、Provider 复制/设为默认/live 导入与移除、代理开关、配置校验、会话用量同步、技能同步与更新、故障转移入队/出队/开关与清空、ChatGPT 账号移除/登出/设为默认、提示词启用/停用、配置重置与备份、守护进程启停、cc-switch 语言切换、技能仓库添加），需要目标的先输入 ID、标记 ⚠️ 的还要二次确认，等价于 Telegram 的确认按钮；未安装时可一键安装或升级二进制
- **配置项**：与 Telegram 的 `/env` 一致——查看可安全读取的 `.env` 键（密钥值不下发），修改/删除规则内的键、新增缺失键；`TELEGRAM_ALLOW_USERS` 仍引导到访问白名单，时区修改立即生效
- **访问白名单**：与 Telegram 的 `/access` 一致——查看/添加/移除授权用户，服务端阻止移除自己或清空名单，改动立即生效
- **快捷指令**：与 Telegram 的 `/alias` 一致——创建/删除 `/名称` 快捷指令，在 App 或 Telegram 发送即展开
- **网络代理**：与 Telegram 的 `/proxy` 一致——添加（自动测连通性）、启用/停用、单条测试与删除；列表地址始终脱敏
- **运维中心**：与 Telegram 的 `/ops` 一致——诊断信息（Node/平台/PID/运行时长/Git/OpenCode 可达性/cc-switch/磁盘/内存/日志大小）、Bot/OpenCode 日志尾部（80/200/400 行，可选中复制），以及运行检查、检查更新（干跑，列出落后提交不改工作区）、更新项目、重启 Bot 与 OpenCode 服务启停（破坏性操作均需确认，长任务有进度提示）；「📦 备份数据」下载服务端 `data/*.json` 的 tar.gz 归档（不含配对令牌）并弹出系统分享面板保存
- **任务历史**：按日期分组（今天 / 昨天 / 日期）查看任务记录（提示词、引擎/模型、格式化耗时、结果，定时触发会标注 🗓），可清空；顶部 20/30/50 条窗口切换与 Telegram 的 `/history <条数>` 对应，记录多于窗口时显示「已显示 N / 共 M 条」；「分享」按钮可选 Markdown（默认）或 JSON，与 Telegram 的 `/export [json]` 是同一条 `GET /export?format=`；点任一条目可查看完整提示词，并一键「填入输入框」或「复制」，方便改写后重发
- **提醒**：创建/删除提醒，时间写法与 Telegram 的 `/remind` 完全一致（`30m`、`18:30`、`每天 08:30`…）；列表显示绝对时间与倒计时（如「2 小时后」），一次性提醒带「延后」按钮（10 分钟 / 1 小时 / 明天，`POST /reminders/:id/snooze`），确认后列表时间立即同步刷新；重复提醒保持周期不提供延后，
  触发时通过 Telegram 推送
- **定时 AI 任务**：创建、暂停/恢复、删除、立即执行一次（同 `/schedule run`，不影响原定时间）；新建对话框可像 Telegram 一样指定执行目标（引擎下拉 + 模型输入框，内部按 `--engine/--model` 前缀提交，留空则沿用当前会话），列表每项显示「执行 引擎 / 模型」、下次触发的绝对时间与倒计时，到点由 bot 执行并推送到 Telegram
- **任务队列**：查看排队/执行中的任务、单条停止，或一键「清空排队」（同 Telegram 队列面板，只取消排队中的任务）
- **运行状态**：OpenCode 可达性、运行时长、进行中任务数（另计服务器保留的可重试条目）、当前执行/排队中的任务与其最新进展、今日任务、成功率、平均耗时、最近活动（上次执行时间/引擎/模型）、引擎分布、近 7 天趋势；末尾的「每日报告」卡片跨全部聊天聚合当日用量（含 Telegram 端）与来源分布，与 `USAGE_DAILY_REPORT` 定时推送同源（`GET /usage/report`）；附「连接信息」（服务器地址、API 监听、引擎/模型、工作目录、时区、推送聊天 ID、会话 ID），对应 Telegram 的 `/api` 与 `/id`
- **帮助**：与 Telegram 的 `/help`、`/help full`、`/help cc` 共用同一份服务端文案——三档切换、可滚动可选中复制，不再与聊天端脱节
- **设置**：服务器地址 + 访问令牌，保存即测连；在 Telegram 发 `/api` 后可直接**扫码配对**（二维码含地址与令牌；服务器开启 `API_ENCRYPTION=1` 时还含加密密钥，自动启用消息级加密——请求/响应体 AES-256-GCM，SSE 与媒体流除外；密钥也可在设置页手动填写）

## 构建与安装

要求：Android Studio（Ladybug 或更新）或命令行 Gradle 8.9+、JDK 17。

```bash
cd android
./gradlew assembleDebug          # 产物: app/build/outputs/apk/debug/app-debug.apk
# 或在 Android Studio 中 Open 本目录后直接 Run
```

> 仓库未提交 `gradlew` 二进制包装器；用 Android Studio 打开会自动生成，或先执行
> `gradle wrapper --gradle-version 8.9` 生成后再构建。

> 本仓库的 CI 环境没有 Android SDK，编译不了 Kotlin。仓库根目录的 `npm run check` 因此先跑
> `npm run check:android`（`scripts/check-android-sources.mjs`：必需源文件是否缺失、是否被
> `.gitignore` 规则吞掉、每个 `.kt` 的括号与字符串/注释是否闭合），再跑
> `tests/appParity.test.ts`：校验命令表与 Bot 的命令清单一致、每个命令都有实际分支，
> 核对所有页面里 `vm.xxx` 引用的确是 `AppViewModel` 声明的成员，并比对 `ApiClient.kt`
> 请求的路径与 `src/api.ts` 路由的接口——App 调不到的端点会被拒绝，服务器有而 App 没用的
> 必须显式登记原因；`Usage`/`UsageDay`/`UsageTrendDay`/`HistoryEntry` 还会与 `src/usage.ts`、
> `src/history.ts` 的字段逐个对照（解码时未知键会被忽略，字段改名只会安静地显示 0）。
> 这些一起构成代替编译器的一层静态门。
> 它不能替代 `./gradlew assembleDebug`，改动 App 代码后仍需在本地编译一次。

## 连接服务器

1. 服务器端确保 `.env` 中 `API_ENABLED=1`（默认开启，默认只监听 `127.0.0.1:3080`）。
2. 在 Telegram 里向 bot 发送 `/api`，会返回 API 地址与访问令牌。
3. 手机能访问到服务器后（公网地址、反向代理、SSH 隧道或 VPN 均可），在 App「设置」页填入地址与令牌。

### 暴露方式建议

| 方式 | 说明 |
| --- | --- |
| 反向代理（推荐） | Nginx/Caddy 反代 `127.0.0.1:3080`，配置 HTTPS 与域名 |
| SSH 隧道 | `adb reverse tcp:3080 tcp:3080`（USB 调试场景）或 `ssh -L 3080:127.0.0.1:3080 host`，App 地址填 `http://127.0.0.1:3080` |
| VPN | Tailscale/WireGuard 组网后直接访问内网地址 |

令牌鉴权始终开启；请勿在没有 TLS 的公网上明文传输（令牌与对话内容均为明文 HTTP）。

## 使用说明

1. **配对连接**：首次打开进入「设置」页，填入服务器地址与访问令牌（Telegram 里向 Bot 发 `/api` 获取，点开回复中的二维码可直接扫码导入）；保存即测连，顶栏状态点实时反映连接健康，点按直达设置页。
2. **发消息**：底部输入框直接输入提示词发送；点「📎」拍照、选相册图片或选任意文件（最多 4 个 / 共 15MB）；输入框为空时右侧按钮变为麦克风，点击录音（最长 2 分钟）后自动发送。发送失败时内容自动回到输入框、附件保留，可直接重发。
3. **用命令**：输入 `/` 弹出与 Telegram 一致的命令和服务器上的快捷指令，点选即执行或跳转对应页面。
4. **切引擎 / 模型**：顶栏芯片切换本会话的引擎与模型；输入框右侧「🎚」可把**下一条**消息临时交给其他引擎并为其选模型，发送后自动恢复默认。
5. **看进度**：任务执行中实时显示思考 / 工具活动与已运行时长，可随时停止；App 在后台时任务完成 / 失败会发系统通知，点击直达该消息并高亮。
6. **更多页面**：左侧抽屉进入任务队列、状态统计、历史、提醒、定时任务、引擎管理、模型管理、cc-switch、代理、白名单、快捷指令、配置、运维中心与帮助，功能与 Telegram 同名命令一一对应。
7. **会话维护**：会话设置页可切换工作目录、时区，恢复默认模型或新建会话；页内还会列出 Bot 的另一端会话（通常是 Telegram 聊天）当前用的引擎/模型/目录与排队情况，「跟随该会话」可把 App 一次性对齐过去（只改本机 App，不动 Telegram，需确认）；顶栏放大镜可在当前聊天内按关键词搜索。
8. **本地体验**：聊天记录与未发送草稿保存在本机，进程被杀也能恢复；回复图片点开全屏（双指缩放），代码块与整条回复均可一键复制，消息文本可长按选择复制。

## 项目结构

```
android/
├── app/src/main/java/com/agentbot/app/
│   ├── MainActivity.kt            # 单 Activity + 抽屉导航
│   ├── ui/
│   │   ├── AppViewModel.kt        # 全部状态与 API 编排（轮询任务进度、附件、持久化）
│   │   ├── Markdown.kt            # 轻量 Markdown 渲染（代码块/行内代码/加粗/列表/引用块）
│   │   ├── ChatScreen.kt          # 聊天主界面
│   │   ├── ImageViewer.kt         # 全屏看图（双指缩放/拖动）
│   │   ├── SessionScreen.kt       # 会话设置（工作目录/时区/默认模型/对端会话）与任务队列
│   │   ├── AgentsScreen.kt        # 引擎安装/更新/卸载
│   │   ├── OpsScreen.kt           # 运维诊断与日志
│   │   ├── ProxyScreen.kt         # 网络代理管理
│   │   ├── AliasesScreen.kt       # 快捷指令
│   │   ├── AccessScreen.kt        # 访问白名单
│   │   ├── ModelsScreen.kt        # 自定义模型管理
│   │   ├── CcScreen.kt            # cc-switch 控制台（Provider/MCP/提示词/环境/代理/高级操作）
│   │   ├── ConfigScreen.kt        # .env 配置项查看与编辑
│   │   ├── PickerDialog.kt        # 引擎/模型切换、新建对话框
│   │   ├── ListScreens.kt         # 历史 / 提醒 / 定时任务
│   │   ├── StatusScreen.kt        # 状态与统计
│   │   ├── HelpScreen.kt          # 帮助（与 Telegram /help 共用文案）
│   │   ├── AppVisibility.kt       # 前后台标记（后台才发任务通知）
│   │   ├── SettingsScreen.kt      # 服务器连接设置
│   │   ├── AppDrawer.kt           # 侧边抽屉
│   │   └── theme/Theme.kt         # Grok 风格暗色主题
│   └── data/
│       ├── ApiClient.kt           # /api/v1 客户端（OkHttp + kotlinx.serialization）
│       ├── LocalStore.kt          # 附件读取（ContentResolver）与聊天记录持久化
│       ├── MediaFiles.kt          # 回复媒体磁盘缓存、图片降采样与 MIME 推断
│       ├── TaskNotifier.kt        # 后台任务完成通知（Android 13+ 权限检查）
│       ├── ApiModels.kt           # 接口模型
│       └── SettingsRepository.kt  # 连接信息持久化
```
