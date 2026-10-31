# Telegram AI 私人助手（OpenCode + 任意 Agent CLI）

把 Telegram 官方 Bot 接到本地 `opencode serve` 与市面上主流的 Agent CLI 上的私人 AI 助手。

```
Telegram Client ⇄ Telegram Bot API ⇄ ┌──────────┐ ⇄ opencode serve ⇄ 模型 + 工具
                                     │  本项目   │ └─ Agent CLI（Claude Code / Codex / Gemini / Qwen / Qoder …）
安卓 App        ⇄ HTTP API(/api/v1) ⇄ └──────────┘
```

## 功能

- **Telegram 官方 Bot**：长轮询，无需公网地址，无需扫码。
- **安卓 App**：Grok 风格的原生客户端（聊天与可选中复制的 Markdown、代码块/整条回复复制、全屏看图、会话内搜索、输入框 `/` 快捷命令、拍照与相册/文件附件、语音消息、单条消息临时换引擎、图片/文件回复查看、附件回显、系统分享导入、实时进度与失败重试、后台通知、任务队列、引擎/模型切换、工作目录、时区、历史、提醒、定时任务、状态统计），通过内置 HTTP API 控制同一台 bot；详见 `android/README.md`。
- **HTTP API**：`/api/v1` 提供 Bearer Token 鉴权的任务提交、引擎/模型切换、工作目录/时区调整、提醒/定时任务管理、运维诊断与日志查看，供 App 或任意脚本调用；Telegram 聊天里发 `/api` 查看配对信息。
- **多引擎切换**：`/agent opencode`（多模型、工具调用）与 Claude Code、Codex、Gemini、Qwen、Qoder、Cursor、Copilot、Aider、Goose、Amp、Droid 等 14 种主流 Linux Agent CLI；可用 `data/agents.json` 接入任意私有 CLI。
- **自动检测与安装**：首次启动扫描 `PATH`，`/start`、`/agent`、`/agents` 都会展示本机已安装的 CLI；可在 Telegram 中通过 `/agents install <id>` 用 npm/pip 安装新 CLI，`/agents update <id>` 原地升级、`/agents uninstall <id>` 卸载由 Bot 安装的版本。默认推荐使用 OpenCode。
- **多模型切换**：Claude Sonnet/Opus、Gemini 3.8/4、Grok 4.7、GPT OSS、DeepSeek、GLM、MiMo、Nemotron 等。
- **cc-switch 集成**：`/cc` 面板与 `/cc <分组>` / `/cc run` 覆盖 Provider、MCP、提示词、技能、配置、代理、故障转移、会话、认证、守护进程等全部非交互命令；危险操作先确认，输出自动脱敏。
- **模型管理**：`/cc model` 或 `npm run models` 为 Bot 与其他 agent 添加/删除模型、同步 `opencode.json`、指定 agent 模型，改动无需重启。
- **Telegram 运维中心**：`/ops` 提供系统诊断、日志查看、项目更新、Bot 重启、OpenCode 服务启停、cc-switch 安装/更新与非密钥配置修改；首次部署之外几乎无需再登录服务器。
- **交互面板**：`/start`、`/agent`、`/model`、`/dir`、`/access`、`/reminders`、`/schedule`、`/proxy`、`/usage`、`/ops` 均带内联按钮，可直接点选切换引擎/模型、设置工作目录、增删访问白名单、暂停任务、取消提醒或操作代理。
- **实时进度**：处理时间超过 2 秒后显示进度卡片（带「停止任务」按钮），并持续发送 typing 状态。卡片被限流时会自动退避而不是每 2 秒重试，状态没有变化时也最多每 30 秒刷新一次，避免长任务把 Telegram 的编辑额度耗尽。
- **重试与队列**：失败消息附带的「重试」按钮只重发**它那一条**任务（不会被之后的新消息顶掉）；`/retry` 重发上一条任务，但若中途发过 `/stop`，排队的 `/retry` 会一起作废，不会把已取消的活儿再跑一遍；`/queue` 可逐条取消或一键清空排队消息。
- **命令自动补全**：启动时注册 Telegram 的 `/` 菜单（`BOT_MENU_COMMANDS`），输入 `/` 即可看到全部命令与说明；测试会校验菜单与 `/help full` 保持一致。
- **网络代理**：Telegram 内添加 HTTP/HTTPS/SOCKS4/SOCKS5 代理，自动测试连通性，可启用、停用、删除；远程媒体、Agent CLI 子进程与 Agent 网络命令自动使用。
- **附件接收**：可直接发送图片、文件、语音；文本/代码文件会读取内容，图片/PDF/音频按当前模型能力附加。
- **原生附件**：模型通过 `[[image:...]]` 等指令发送图片、视频、语音、文档。
- **白名单**：默认只允许 `.env` 中配置的 Telegram 用户；未配置时拒绝启动。日常增删用 `/access`，立即生效且不会把自己移出。
- **仅私聊**：只响应私聊消息，群组/频道消息直接忽略，避免误触发。
- **提醒稍后提醒**：一次性提醒触发时附带「10分钟 / 1小时 / 明天」按钮，一键延后
- **定时提醒**：`/remind 30m 喝水` 即可设置；支持重复提醒（`every 30m`、`每5分钟`、`每天 08:30`）与中文口语时间（`5分钟后`、`下午3点`、`今晚8点半`、`后天 09:00`）；保存在 `data/reminders.json`，重启后仍然有效。
- **时区可在线切换**：`/timezone` 或 `/timezone Asia/Tokyo` 立即改变提醒、定时任务与每日统计所用的时区，并写入 `.env`（`REMINDER_TIMEZONE`），无需重启。
- **定时 AI 任务**：`/schedule add 每天 09:00 检查服务器` 到点自动调用 AI 执行提示词并回传结果；支持一次性与重复任务、指定引擎/模型、暂停/恢复/删除、立即运行一次，保存在 `data/schedules.json`。
- **使用统计**：`/usage` 查看任务量、成功率、平均耗时、今日任务、近 7 天趋势与引擎分布，持久化到 `data/usage.json`。
- **任务历史**：`/history` 查看最近任务（提示词摘要、引擎/模型、耗时、结果、是否定时），每聊天保留 50 条，可一键清空，持久化到 `data/history.json`。
- **任务取消**：`/stop` 可立即终止正在执行的 OpenCode / Agent CLI 任务，并清空排队中的提示。
- **单实例**：`data/bot.lock` 防止重复启动；异常退出后残留的锁会被自动回收。
- **会话持久化**：`data/sessions.json` 保存会话 ID、引擎与模型偏好，重启后自动恢复。

## 命令

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
| `/model` | 查看或切换当前引擎的模型，支持按引擎分组的按钮；`/model default`（或面板上的「↩️ 恢复默认模型」）取消本会话选择、回到配置的默认模型并重置上下文 |
| `/model <模型ID>` | 为当前 Agent CLI 指定模型（如 `/model sonnet`；OpenCode 仍走 `/model` 面板） |
| `/dir` | 查看本会话 CLI 引擎的工作目录（默认是 Bot 自身所在目录），面板上有「恢复默认目录」按钮 |
| `/dir <路径>` | 让本会话的 CLI 引擎在另一个项目里执行，支持 `~`、相对路径与引号；目录必须存在，切换会重置该会话的 CLI 上下文。OpenCode 的目录由其服务端决定，不受此设置影响 |
| `/new`、`/reset` | 重置当前会话上下文 |
| `/stop` | 停止当前任务（同时丢弃排队中的提示） |
| `/retry` | 重新发送上一条任务（失败提示上也有「重试」按钮，只重发它自己那一条） |
| `/queue` | 查看排队消息，可逐条取消或一键清空；当前任务不受影响 |
| `/status` | 查看引擎、模型、运行时长、今日任务、代理、队列与提醒数 |
| `/usage` | 查看任务量、成功率、平均耗时、今日与引擎统计 |
| `/history [条数]` | 查看最近任务历史（提示词摘要、引擎/模型、耗时与结果），可一键清空 |
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
| `/cc use <id>` / `/cc test [id]` | 切换 Provider / 测试端点速度与连通性 |
| `/cc mcp [sync]` / `/cc prompts` / `/cc env` / `/cc proxy` | 查看 MCP、同步配置、提示词预设、本地工具与代理状态 |
| `/cc model add <简称> <provider>/<modelID> [名称] [参数]` | 添加自定义模型并同步 `opencode.json`（参数：`--attachment`、`--context N`、`--output N`） |
| `/cc model del <简称> [force]` | 删除自定义模型（需在聊天内点按确认；被 agent、`opencode.json` 或某个聊天选用时需 `force`；强制删除会清除这些 agent 的 `model:` 绑定，并把会话的模型选择重置为引擎默认） |
| `/cc model assign <agent\|self> <模型>` | 为 Bot 或其他 agent 指定模型 |
| `/ops` | 运维中心：诊断、日志、更新、重启、服务与配置 |
| `/diag` | 查看 Node、Git、OpenCode、cc-switch、磁盘与日志状态 |
| `/logs [行数]` | 查看 Bot 日志；`/logs opencode [行数]` 查看 OpenCode 日志 |
| `/update` | 拉取代码、安装依赖并构建（需确认） |
| `/restart` | 重启 Bot（需确认，systemd 部署会提示改用 systemctl） |
| `/service opencode start\|stop\|restart` | 管理由 Bot 托管的 OpenCode 服务 |
| `/env` / `/env set KEY VALUE` / `/env unset KEY` | 查看或修改非密钥配置，重启后生效 |
| `/access` | 查看 Telegram 访问白名单（含每个 ID 的移除按钮）与「放行所有用户」的状态 |
| `/access add <用户 ID>` / `/access del <用户 ID>` | 增删白名单：写入 `.env` 并**立即生效**，无需重启；会拒绝移除你自己、拒绝留空白名单。ID 可让对方发送 `/start` 后从被拒回复中取得 |
| `/api` | 查看安卓 App 配对信息（HTTP API 地址、令牌与暴露提示），并附带可被 App「扫码配对」直接导入的二维码图片 |
| `/alias` | 自定义快捷指令面板；`/alias add 名称 指令内容` 创建后，发送 `/名称` 即触发（支持 3 层嵌套，重启后保留） |
| `/id` | 查看聊天 ID、用户 ID、时区与会话 ID |

所有功能面板底部都有「⬅️ 主菜单」；在面板之间切换时会原地编辑当前消息，不会不断刷屏。`/start`、`/menu`、`/help` 不经过任务队列，即使正在执行长任务也能立即打开。

## HTTP API（/api/v1）

默认启用，监听 `127.0.0.1:3080`（`API_ENABLED/API_PORT/API_BIND/API_TOKEN` 可调）。
所有请求需携带 `Authorization: Bearer <token>`；令牌在 Telegram 发 `/api` 查看。

| 端点 | 说明 |
| --- | --- |
| `GET /health` | 存活检查：版本、当前引擎、时区 |
| `GET /info` | 会话与配对信息（同 `/id` + `/api`）：引擎/模型、会话 ID、工作目录、推送聊天 ID、API 监听地址；令牌不会回传 |
| `GET /help` | 与 Telegram 共享的帮助文案：`sections` 含基础菜单、完整说明与 cc-switch 指令（已去除 Markdown 标记，供 App 直接展示） |
| `GET /session` | 当前引擎/模型/工作目录；`POST /agent {engine}` 切换、`POST /model {model}` 切模型（`default` 恢复默认）、`POST /new` 重置会话 |
| `POST /task` | 提交任务 `{text, engine?, model?, attachments?}`；附件为 `{name, mime, data(base64)}` 数组，最多 4 个共 15MB，文本内联、图片/音频/PDF 直连模型；`text` 可为空但需带附件（服务端按类型补默认指令）；`engine`/`model` 只作用于本条任务，不改动会话默认，`model` 在提交时按该引擎解析（OpenCode 走模型注册表、CLI 走引擎模型表），无法识别直接返回 400 而不入队；返回 202 与 taskId |
| `GET /task/:id` · `GET /tasks?limit=` | 轮询任务状态（queued/running/done/failed/cancelled）与结果；完成时 `reply` 已剔除媒体指令，`media[]` 给出回复附件元数据（kind/label/name/size/remote）；`POST /stop` 停止全部 |
| `POST /task/:id/stop` · `GET /queue` · `POST /queue/clear` | 停止单个任务（排队中直接丢弃、执行中中止）；查看当前排队/执行中的任务；一键清空排队（仅取消 queued，不影响执行中的任务） |
| `GET /task/:id/events` | SSE 事件流：实时推送任务进度行与终态快照（250ms 节流、15s 心跳、终态自动关闭）；App 优先走流式，断流自动回退 1.5s 轮询 |
| `GET /task/:id/media/:index` | 下载回复中的第 `index` 个媒体（任务视图 `media[]` 给出 kind/label/name/size/remote）；本地文件限 `data/outbox`，远程链接沿用与 Telegram 相同的 SSRF/代理防护 |
| `GET/POST /dir` | 查看 CLI 工作目录；`{dir:"/path"}` 切换（支持 `~` 与相对路径），`{reset:true}` 恢复默认；切换会重置 CLI 会话 |
| `GET/POST /timezone` | 查看当前时区；`{timezone:"Asia/Shanghai"}` 切换（校验 IANA 名称，写入 `.env` 并立即生效） |
| `GET/POST /proxy` · `POST /proxy/:id/use\|test` · `POST /proxy/off` · `DELETE /proxy/:id` | 网络代理：列表（地址已脱敏）、添加（先测试连通性）、启用/停用、单条测试与删除 |
| `GET/POST /aliases` · `DELETE /aliases/:name` | 快捷指令：与 Telegram `/alias` 共享同一份列表；提交任务时 `/名称 ...` 会先展开（最多 3 层） |
| `GET/POST /access` · `DELETE /access/:id` | 访问白名单：查看/添加/移除，写入 `.env` 并立即生效；与 `/access` 共用防锁死校验（不能移除自己、不能清空） |
| `GET/POST /models/custom` · `DELETE /models/custom/:key?force=1` | 自定义 OpenCode 模型：列表（含 Agent 绑定）、添加（简称 + `provider/modelID`）、删除（仍被引用时返回 409，`force=1` 强制并重置相关会话） |
| `POST /models/assign` | 为 Agent 绑定模型（等同于 `/cc model assign`）：body `{agent, model}`，`agent=self` 且当前引擎为 opencode 时同步切换 App 会话 |
| `GET /cc` | cc-switch 状态：是否安装、版本、应用、Provider 列表与当前项（与 `/cc` 面板一致） |
| `POST /cc/use` · `POST /cc/test` | 切换 Provider（body `{id}`）与测速（省略 `id` 时测当前项）；同一时间只允许一个 cc-switch 变更操作 |
| `GET /cc/providers` · `POST /cc/providers` | 对应 `/cc provider add`：`GET` 下发 cc-switch 允许的模板/API 格式与字段上限，`POST` body `{name, id?, template?, baseUrl?, apiKey?, model?, apiFormat?, config?}` 逐项校验后拼固定参数（非法字段 400）。`apiKey` 只在服务层抹除，任何响应都不会回显；`GET` 还返回 `app`/`fieldMode`——cc-switch 只对 Claude/Codex/Gemini 接受 base/key/model 字段模式，其余应用必须提交 `config` JSON（App 表单据此切换） |
| `GET /cc/proxy` · `GET /cc/mcp` · `POST /cc/mcp/sync` | cc-switch 代理状态、MCP 列表与同步 |
| `GET /cc/prompts` · `POST /cc/prompts/activate` · `POST /cc/prompts/deactivate` | 提示词列表、启用（body `{id}`）与停用 |
| `GET /cc/env?mode=tools\|check` | cc-switch 环境工具与检查输出 |
| `GET /cc/view?name=config\|sessions\|auth\|skills\|failover\|daemon\|settings` | cc-switch 只读视图（配置、会话、认证、技能、故障转移、守护进程、设置），输出脱敏 |
| `GET /cc/stream?id=` · `GET /cc/models?id=` · `GET /cc/quota?id=` | 对应 `/cc stream`、`/cc models`、`/cc quota`：流式连通性、Provider 模型列表与配额（只读，不含烧额度的 `--reset`） |
| `POST /cc/mcp/import` · `POST /cc/prompts/create` | 对应 `/cc mcp import`（body `{json}`）与 `/cc prompt new`（body `{name, content}`），上限 20000 字 |
| `GET /cc/exec` · `POST /cc/exec` | cc-switch 危险命令白名单：`GET` 下发可执行项（名称/说明/是否需要目标 ID/是否需确认），`POST` body `{name, arg?, confirm?}` 只跑表内固定参数；未知名称、缺 `confirm`、非法目标 ID 一律 400。表内含 `skill-install`（`owner/name`，90 秒长超时）、`mcp-enable|disable`、`provider-duplicate|set-default|import-live|remove-from-config`、`proxy-enable|disable`、`failover-add|remove`、`config-validate`、`sessions-sync-usage`、`skills-sync|update|update-all` |
| `GET /cc/sessions?q=` · `POST /cc/deeplink` | 对应 `/cc sessions search`（关键词上限 128 字、不得以 `-` 开头或含控制字符，90 秒超时）与 `/cc deeplink`：仅接受 `ccswitch://v1/import?...`（上限 8192 字）、需 `confirm: true`，响应不回显链接本身 |
| `GET /config` · `PUT /config/:key` · `DELETE /config/:key` | `.env` 配置项：查看（密钥值不下发）、修改、删除；仅允许规则内的键，`TELEGRAM_ALLOW_USERS` 仍须走 `/access`，`REMINDER_TIMEZONE` 立即生效 |
| `GET /agents` · `GET /models` | 引擎列表（含安装状态 / 是否 Bot 托管 / 可安装性）与模型列表；`GET /models?engine=<id>` 可取其他引擎的模型（供单条临时指定使用），未知引擎返回 400 |
| `POST /agents/:id/install\|update\|uninstall` | 安装、更新或卸载 Bot 托管的 Agent CLI（npm/pip 方式）。已安装不可重复安装、非托管不可更新/卸载、当前引擎不可卸载；同一时间只允许一个操作 |
| `GET /ops/diag` · `GET /ops/logs?source=bot\|opencode&lines=N` | 运维诊断（版本、Git、OpenCode 可达性、磁盘/内存、日志大小）与日志尾部（10–400 行，自动脱敏） |
| `POST /ops/check` · `POST /ops/update` · `POST /ops/restart` | 运行检查（npm run check）、更新项目（git pull + 依赖 + 构建）、重启 Bot；同一时间只允许一个运维操作，输出自动脱敏 |
| `GET /ops/service` · `POST /ops/service/start\|stop\|restart` | OpenCode 服务状态与启停/重启（只管理 Bot 自己启动的进程） |
| `POST /ops/cc` · `POST /ops/cc-update` | 安装 / 更新 cc-switch 二进制（较久，输出脱敏） |
| `GET /history?limit=` · `DELETE /history` | 任务历史：`limit`（1–50）取最近 N 条，响应同时返回服务端保留的 `total`（最多 50 条），供 App 显示「已显示 N / 共 M 条」 |
| `GET /export?format=markdown\|json` | 下载任务历史文档（markdown/JSON，附件形式返回） |
| `GET /usage` | 用量统计与近 7 天趋势 |
| `GET/POST /reminders` · `DELETE /reminders/:id` | 提醒管理（触发时经 Telegram 推送） |
| `GET/POST /schedules` · `POST /schedules/:id/pause\|resume\|run` · `DELETE /schedules/:id` | 定时任务管理（`POST` 的 `text` 支持 `--engine/--model` 前缀指定执行目标；响应含 `target`「引擎 / 模型」；`run` 立即执行一次，不影响原定时间） |
| `GET /status` | 系统状态：运行时长、今日任务、OpenCode 可达性 |

App 的会话是独立上下文（`api:app`），与各 Telegram 聊天互不干扰。

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

启动日志会输出 `agent CLI detection: n/14 installed (...)`，并列出可在 Telegram 内安装的 id。首次使用发送 `/start` 或 `/agents` 即可看到本机检测结果。

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
- 检测与调用不依赖登录 shell 的 `PATH`：Bot 会在 `PATH` 之后自动补上常见的用户级全局目录（`~/.npm-global/bin`、`~/.local/bin`、`~/.local/share/pnpm`、`~/.bun/bin`、`~/.deno/bin`、`~/.cargo/bin`、`~/.pyenv/shims`、`~/bin`、`/usr/local/bin`、`/snap/bin`），systemd / cron 启动时同样能找到自己装好的 CLI；系统已有同名可执行文件时仍以 `PATH` 中的为准。这些目录每次检测都会重新扫描，因此在 Telegram 里装完 CLI 立刻就能被识别，无需重启 Bot。
- 全局目录不可写时会自动降级重试，无需 root：npm 报 `EACCES` 时改用 `--prefix=~/.npm-global` 重装一次；pip 遇到 `externally-managed-environment`（Debian 12 / Ubuntu 24.04 常见）时改用 `--break-system-packages` 重装一次。重试成功的标记会记入 `data/agent-cli-installs.json`，`/agents update` 与 `/agents uninstall` 复用同一标记，消息里也会说明发生过降级。
- 只有当包管理器把可执行文件放到上述目录之外时，安装才会在成功后提示未检测到可执行文件，需要手动把对应 bin 目录加入 `PATH`。

### 自定义 / 覆盖档案

编辑 `data/agents.json`（可用 `AGENT_CLI_CONFIG` 指向其他路径）。文件按 mtime 热加载，无需重启；与内置 id 同名时按字段合并覆盖：

```json
{
  "agents": {
    "claude": { "defaultModel": "opus" },
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

- `sessionMode`：`preassign` / `capture` / `stateless`；`parse`：`text` / `json-result` / `jsonl-result` / `claude-json` / `codex-jsonl` / `gemini-stream`。
- `args` 支持 `base`、`resumeBase`（续接时替换 `base`）、`newSession`、`resumeSession`、`cwd`、`model`、`prompt`；占位符为 `{workDir}`、`{sessionId}`、`{model}`、`{prompt}`。消息正文若以 `-` 开头（例如粘贴的 `- 项目符号` 列表），会自动补一个空格，避免它被 CLI 当成命令行开关。
- `models` 可为 `{ "id": "显示名" }` 或 `[{ "id", "label", "aliases" }]`；`strictModels: true` 时只接受列表内模型，否则模型 ID 透传给 CLI——但不接受以 `-` 开头或含控制字符、超过 120 字符的值，这类值会被视为非法模型而拒绝，避免它被 CLI 解析成额外的命令行开关。
- `resumeErrorPattern` 是识别“会话失效”的正则，命中后清空会话并重试一次；`env` 可附加进程环境变量。
- `installSpec` 可选，仅接受 `method: "npm" | "pip"` 与合法包名；Telegram 只会执行固定的 `npm install -g` / `python3 -m pip install --user` 命令，不会把包名拼进 shell。
- id 必须匹配 `^[a-z0-9][a-z0-9._-]*$`，`opencode` 保留给服务端引擎；未知占位符、非法正则或缺少 `bin` 的条目会记录警告并被忽略。`amazonq` / `kiro` 的非交互参数可能随版本变化，标为实验性。
- 安装检测只看 `PATH` 中是否存在可执行文件；个别发行版会放置“安装引导 shim”，此时仍需实际安装后才能执行。
- 未安装任何 CLI 时仍可正常使用 OpenCode；`npm run serve` 只对 OpenCode 引擎必需。

## 目录

```
bot/
├── src/
│   ├── index.ts      入口：首次连接向导、配置加载、单实例锁、服务健康检查、定时清理
│   ├── setup.ts      首次连接向导：Token 校验、用户 ID 识别、.env 原子写入
│   ├── setup-cli.ts  `npm run setup` 命令行入口
│   ├── config.ts     .env 解析、白名单与超时配置
│   ├── lock.ts       PID 锁文件（单实例 + 陈旧锁回收）
│   ├── telegram.ts   Telegram 消息、命令、附件发送
│   ├── models.ts     模型表、别名解析与自定义模型热加载
│   ├── modelAdmin.ts 自定义模型注册、opencode.json 同步、agent 模型绑定
│   ├── model-cli.ts  `npm run models` 命令行入口
│   ├── ccswitch.ts   cc-switch CLI 封装：Provider/测速/MCP/提示词/环境/代理
│   ├── progress.ts   进度卡片
│   ├── opencode.ts   opencode HTTP/SSE 客户端
│   ├── agentCli.ts   通用 Agent CLI 适配层：内置档案、PATH 检测、子进程、会话与输出解析
│   ├── agentInstaller.ts npm/pip 安装、更新、卸载与 Bot 托管清单
│   ├── ops.ts        运维：诊断、日志、更新、重启、OpenCode 服务与 .env 编辑
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
├── tests/            单元测试（node:test）
├── deploy/           systemd 单元示例
├── scripts/          邮件、X、搜图、免费服务器扫描/抢注、重启与 cc-switch 安装脚本
├── bin/              可选：`npm run cc-switch:install` 下载的 cc-switch 二进制（已 gitignore）
├── .opencode/agent/assistant.md   Bot 的 agent 人设与工具权限
├── opencode.json     Provider 与模型配置
└── data/             会话状态、提醒、定时任务、使用统计、任务历史、自定义模型、Agent CLI 配置、Bot 安装记录、日志、代理配置、outbox 与 inbox 附件
```

## 配置

也可以直接运行 `npm run setup`，由向导完成 Token、用户 ID 与 `.env` 写入。手动配置时，复制 `.env.example` 为 `.env`，至少填写：

```ini
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOW_USERS=你的Telegram用户ID
OPENCODE_SERVER_PASSWORD=与 opencode serve 一致
MY_API_KEY=...
```

完整变量见 `.env.example`：

- `TELEGRAM_ALLOW_USERS`：逗号分隔的白名单；为空且未设置 `TELEGRAM_ALLOW_ALL_USERS=1` 时拒绝启动。日常修改请用 `/access`（`/env set` 会拒绝这个键，避免文件与运行中的白名单不一致）。
- `TASK_TIMEOUT_MS` / `TASK_MAX_TIMEOUT_MS`：无活动超时与任务绝对上限，默认均为 10 分钟，所有引擎共用。
- `MAX_MEDIA_MB` / `MAX_INPUT_MB`：出站单文件与入站附件上限，默认均为 20MB。
- `MEDIA_ALLOW_PRIVATE_URLS`：默认 `0`，拒绝远程媒体链接访问本机/内网地址；仅在本地调试时设为 `1`。
- `REMINDER_TIMEZONE`：提醒时间解析所用 IANA 时区，默认 `Asia/Shanghai`；无效时拒绝启动。
- `OPENCODE_AGENT`：默认 `assistant`，对应 `.opencode/agent/assistant.md`。
- `AGENT_CLI_CONFIG`：自定义 Agent CLI 档案路径，默认 `data/agents.json`；文件不存在时只使用内置档案。
- `CC_SWITCH_APP` / `CC_SWITCH_BIN`：cc-switch 集成的应用类型（默认 `opencode`，会自动映射为 CLI 的 `open-code`；也接受 `openclaw` → `open-claw`）与二进制路径；留空时依次查找 `./bin/cc-switch` 和 `PATH`。
- `GROK_API_KEY`：Grok provider 的密钥，`opencode.json` 通过 `{env:GROK_API_KEY}` 读取。
- `SNIPER_EMAIL` / `SNIPER_PASSWORD`：仅 `scripts/sniper_free_vps.mjs` 使用。

## 运行

```bash
npm install
npm run cc-switch:install   # 可选：安装 cc-switch CLI 集成
npm run serve      # 启动 opencode 无头服务（127.0.0.1:4096）
npm run build
npm run restart    # 按 data/bot.pid 优雅停止旧进程并后台启动
```

### 首次连接引导

首次启动且 `.env` 缺少 Bot Token 或白名单时，终端会自动进入连接向导：

1. 按提示在 Telegram 向 `@BotFather` 发送 `/newbot`，粘贴返回的 HTTP API Token
2. 向导调用 `getMe` 校验 Token，并显示 Bot 用户名
3. 按提示给 Bot 发送一条消息，向导通过长轮询自动识别你的用户 ID
4. 确认后原子写入 `.env`（权限 `0600`），然后继续启动 Bot

任何一步都可以取消；非交互环境（systemd、CI、无 TTY）不会阻塞，而是打印手动配置步骤并退出。已有 Bot 后想重新配置，可随时运行：

```bash
npm run setup
```

Token 在向导输出中只显示掩码；输入行仍由终端回显，请留意共享屏幕。Token 不会写入日志或 Telegram 消息。`npm run setup` 会保留 `.env` 中的注释与其他配置，只更新 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_ALLOW_USERS`。

启动时会自动扫描 `PATH` 并打印 `agent CLI detection: n/14 installed (...)`；首次在 Telegram 发送 `/start` 或 `/agents` 即可查看检测结果并安装新 CLI。

`npm run restart` 会在 `data/bot.log` 超过 10MB 时按时间戳轮转，并在启动后检查进程是否存活。
它还通过 `BOT_LOG_FILE` 告知 Bot 日志路径：进程每分钟检查一次，超过 10MB 时复制并清空（copytruncate），长期运行也不会无限增长；轮转文件只保留最近 7 个。
重复启动会被 `data/bot.lock` 拒绝，提示已有实例的 PID；锁文件同时记录进程启动时间，PID 被系统复用后不会误判为仍在运行。

开发模式：`npm run dev`；完整检查：`npm run check`（类型检查 + 测试 + 构建）。

### systemd 常驻（可选）

`deploy/telegram-bot.service` 提供了 systemd 单元示例。按实际用户与路径修改后：

```bash
sudo cp deploy/telegram-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-bot
journalctl -u telegram-bot -f
```

使用 systemd 时不要再执行 `npm run restart`，否则会与 systemd 管理的进程争抢单实例锁。`opencode serve` 需要另行启动（`npm run serve` 或自己的 unit）。

> `opencode serve` 不会自动读取 `.env`，修改 `opencode.json` 或 agent 文件后需要带环境变量重启：
> `set -a; . ./.env; set +a; opencode serve --port 4096 --hostname 127.0.0.1`

## Telegram 运维中心

首次完成克隆、`npm install` 与启动后，日常运维都可以在 Telegram 内完成：

```text
/ops                               # 运维面板：诊断 + 快捷按钮
/diag                              # Node、Git、OpenCode、cc-switch、磁盘、内存与日志大小
/logs 100                          # 最近 100 行 Bot 日志（自动去除 ANSI 与密钥）
/logs opencode 200                 # 最近 200 行 OpenCode 日志
/update                            # 确认后执行 git pull + npm install + npm run build
/restart                           # 确认后重启 Bot
/service opencode start|stop|restart
/env                               # 查看可修改的非密钥配置
/env set LOG_LEVEL debug
/env set TASK_TIMEOUT_MS 1200000
/env unset PROXY_TEST_URL
```

**项目更新**：`/update` 先检查 `git status --porcelain`，工作区有未提交改动会直接中止；随后依次执行 `git pull --ff-only`、`npm install --no-audit --no-fund`、`npm run build`。任一步失败都会停止并保留旧进程，不会自动重启。更新成功后点击面板中的「重启 Bot」或发送 `/restart` 生效。长命令（安装依赖、安装 cc-switch）超时时会终止整个进程组，连同 npm 生命周期脚本与下载子进程一起收掉，避免超时后仍有进程继续改写 `node_modules`。

**重启 Bot**：非 systemd 部署下调用 `scripts/restart.sh`，优先按 `data/bot.pid` 停止旧进程；该文件缺失或失效时（例如用 `npm start` 手动启动的实例）回退到 `data/bot.lock` 中记录的持锁进程，然后再后台启动新进程，期间短暂离线。检测到 systemd（`INVOCATION_ID` / `SYSTEMD_EXEC_PID`）时会拒绝脚本重启，避免与 systemd 争抢单实例锁，并提示改用 `systemctl restart telegram-bot`。

**OpenCode 服务**：`/service opencode start` 使用当前 `OPENCODE_URL` 的端口与 `--hostname 127.0.0.1` 启动 `opencode serve`，PID 写入 `data/opencode.pid`，日志追加到 `data/opencode.log`（超过 10MB 自动轮转）。Bot 只会停止自己启动的实例；手动启动的 OpenCode 会被识别为“未托管”并拒绝停止/重启。`OPENCODE_URL` 指向非本机地址时也不提供启停管理。

**cc-switch 安装/更新**：`/ops` 中的「cc-switch 安装/更新」会确认后执行 `scripts/install-cc-switch.sh`，下载对应平台二进制到 `./bin/cc-switch`；已安装时使用 `--force` 覆盖更新。下载自动继承 `/proxy` 中启用的代理。

**配置项**：`/env` 只允许修改下列非密钥配置，写入时保持注释与顺序、原子替换并将 `.env` 权限设为 `0600`：

`TASK_TIMEOUT_MS`、`TASK_MAX_TIMEOUT_MS`、`MAX_REPLY_LENGTH`、`MAX_MEDIA_MB`、`MAX_INPUT_MB`、`REMINDER_TIMEZONE`、`LOG_LEVEL`、`MEDIA_ALLOW_PRIVATE_URLS`、`TELEGRAM_ALLOW_ALL_USERS`、`OPENCODE_URL`、`OPENCODE_AGENT`、`CC_SWITCH_APP`、`CC_SWITCH_BIN`、`AGENT_CLI_CONFIG`、`PROXY_TEST_URL`。

`TELEGRAM_ALLOW_USERS` 也在 `.env` 里，但只能通过 `/access` 修改：它会同步更新运行中的白名单，并阻止清空白名单或把当前操作者移出去。

Telegram Token、API Key、密码、账号凭据等永远不会在 `/env`、`/logs`、`/diag` 中显示，也不能通过 Telegram 修改。配置修改后需要 `/restart` 生效；OpenCode 相关变量还需要重启 OpenCode 服务。

**运行检查**：`/ops` 中的「运行检查」执行 `npm run check`（类型检查 + 单元测试 + 构建），适合在修改自定义 agent 档案或模型配置后验证。所有运维操作均为固定命令，不接受任意 shell 输入，并有并发锁避免同时执行多个重任务。

**一次性确认**：更新项目、重启 Bot、停止/重启 OpenCode、cc-switch 安装/更新、`/agents` 安装/更新/卸载的确认按钮使用随机一次性令牌，点击「✅ 确认」后立即失效；「取消」按钮同样携带该令牌，点击即**撤销**这次请求（不会留下一个 5 分钟内仍可按下的确认按钮），再点确认会提示「已过期或已被使用」。超过 5 分钟未点击也会自动过期。执行前还会重新检查前置条件（是否 systemd 托管、是否有任务正在跑），因此确认时的状态比弹出提示时更新。

## 发送图片 / 视频 / 语音 / 文件

模型在回复末尾输出指令，桥接会转换成 Telegram 原生消息：

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
- 单条回复最多 5 个附件；默认单文件上限 20MB（`MAX_MEDIA_MB`）。
- 远程链接默认拒绝回环/私网/链路本地地址（含重定向后的每一跳），并把已通过校验的域名钉死在解析到的地址上（防止 DNS 重绑定），同时限制下载体积；调试内网地址需显式设置 `MEDIA_ALLOW_PRIVATE_URLS=1`（此时不做地址校验，也不钉死解析）。走 `/proxy` 代理下载时由代理服务器负责解析。
- 下载失败时只回显链接的 `协议://主机/路径`，不带查询参数（签名、令牌常放在 query 里），并做密钥脱敏；关闭或删除代理会立即断开已建立的代理隧道。
- Android 端同样消费这些指令：图片直接显示在气泡里，其余类型显示为可点击卡片，通过 `GET /task/:id/media/:index` 下载，防护规则与 Telegram 完全一致。

## 接收图片 / 文件 / 语音

直接发送附件即可，可附带文字说明作为提示词：

| 输入 | 处理方式 |
| --- | --- |
| 文本/代码文件（`.txt`/`.md`/`.json`/`.ts`/`.log` 等） | 读取内容并随提示词发送（最多 6 万字，超出截断） |
| 图片 | 保存到 `data/inbox/`；当前模型声明支持图片时作为附件发送 |
| PDF | 同上（按模型的 PDF 能力） |
| 语音/音频 | 保存到 `data/inbox/`；模型支持音频时直接附加，否则提示无法转写 |

- 附件保存在 `data/inbox/`，超过 24 小时自动清理；单文件上限 20MB（`MAX_INPUT_MB`），单条消息附件合计上限 15MB、内联文本合计 10 万字。入站附件以 `0600` 写入、目录以 `0700` 创建，同机其他账户无法读取。
- 能力检测来自 opencode 的 `GET /provider`。当前环境中的 custom/grok 模型未开启视觉/音频输入，因此图片与语音会以“路径 + 不支持”提示交给模型。
- 想启用视觉/音频：换用支持多模态的 provider/模型，并在 `opencode.json` 对应模型上设置 `"attachment": true` 与 `"capabilities": { "input": ["text","image","audio","pdf"] }`。
- 每个会话最多排队 4 条消息，超出会提示等待；`/stop` 会同时清空排队。

## 网络代理

在 Telegram 中发送 `/proxy` 打开管理面板，也可以直接用命令：

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
- Telegram 收发与本地 opencode 连接始终直连，因此代理故障不会导致 Bot 失联，可随时在面板停用。
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
- 投递失败（例如 Telegram 暂时不可用）会保留提醒，并按 1 分钟 → 5 分钟 → 15 分钟 → 1 小时退避重试；一次性提醒连续失败 8 次后放弃并记录错误，**重复提醒只跳过这一次**并排到下一个周期，不会因为一段网络故障而永久消失。
- 每个会话最多同时保留 20 条提醒；提醒投递依赖 Bot 进程运行。

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
- 面板中的「暂停 / 恢复 / 删除」按钮与 `/schedule pause|resume|del 编号` 等价；`/status` 会显示任务数量。
- `▶️ 运行` 按钮或 `/schedule run 编号` 可立即执行一次（暂停中的任务也可以），只更新最近运行状态，不改动原定时间或消耗一次性任务。

## cc-switch 与模型管理

### 安装 cc-switch（可选）

```bash
npm run cc-switch:install            # 下载到 ./bin/cc-switch
npm run cc-switch:install -- --force # 覆盖已有二进制
# 也可设置 CC_SWITCH_BIN=/path/to/cc-switch 或把二进制放进 PATH
```

未安装时 `/cc` 面板仍可打开并给出安装提示，`/cc model` 不依赖 cc-switch。

### Telegram 操作

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
/cc hermes memory ...
/cc run <任意非交互参数>
```

- `/cc mcp add '<JSON>'` 通过 Deep Link 导入 MCP（可省略 `mcpServers` 外层）；`/cc prompts new <名称> <内容>` 通过 Deep Link 创建提示词，绕开交互式编辑器。
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
- 强制删除时，被删模型所在 agent 文件 frontmatter 的 `model:` 行会被清除（该 agent 回落到引擎默认模型），引用它的会话选择同样被重置；`opencode.json` 的 `model` / `small_model` 仍指向它时只提示、不自动改动。
- Bot 按文件 mtime 自动重载 `data/models.json`，无需重启；新会话生效。文件被写坏（JSON 无效）时不会清空已加载的自定义模型，修好后自动恢复。

## 使用统计

```text
/usage
```

- 统计每个会话的任务总数、成功 / 失败 / 取消、成功率、平均耗时、今日任务与引擎使用次数。
- 数据保存在 `data/usage.json`（权限 600），按 `REMINDER_TIMEZONE` 划分自然日，仅保留最近 31 个有记录的日子。
- 超过 31 天没有任何任务的会话会在下一次任务记录时被清理（每小时最多扫描一次），`data/usage.json` 与 `data/history.json` 不会随开放白名单的使用无限增长；代价是长期沉默的会话统计与历史会从头开始。
- 只记录任务结果与耗时，不保存提示词或回复内容。
- `/status` 也会显示今日任务数；面板与状态页均可点击「刷新」查看最新数据。

## 超时与错误

所有引擎统一使用：

- 无活动超时：超过 `TASK_TIMEOUT_MS`（默认 10 分钟）没有任何输出即中止。
- 绝对上限：任务总耗时达到 `TASK_MAX_TIMEOUT_MS`（默认 10 分钟）即中止；长任务可调大。
- OpenCode 超时会调用 `POST /session/:id/abort` 终止服务端生成；Agent CLI 会终止整个进程组（含子进程）。

常见故障：

| 现象 | 处理 |
| --- | --- |
| `请求失败: ECONNREFUSED` | 本地 `opencode serve` 未启动，执行 `npm run serve` |
| `请求失败: UND_ERR_SOCKET` | 服务端连接被关闭；查看 opencode serve 日志与上游模型状态 |
| `fetch failed` | 已自动解包底层 `ECONNREFUSED` / `ETIMEDOUT` / socket 错误码；按对应原因处理 |
| `-> 404` 会话不存在 | Bot 会自动新建会话，上下文清空 |
| 启动报白名单 / Token 错误 | 在终端运行 `npm run setup`，或手动填写 `TELEGRAM_ALLOW_USERS` / `TELEGRAM_BOT_TOKEN`（也可显式设置 `TELEGRAM_ALLOW_ALL_USERS=1`）。Bot 已在运行时不必再改文件：让任一在白名单内的用户发送 `/access add <你的 ID>` |
| 首次启动没有出现向导 | 当前不是交互式终端（systemd/CI）；按输出提示手动配置，或在终端运行 `npm run setup` |
| 向导识别不到用户 ID | 确认已给 Bot 发送消息；若提示 409 Conflict，先停止其他轮询实例或移除 Webhook，再手动输入 ID |
| 启动提示已有实例（PID） | 说明旧进程仍在运行；用 `npm run restart` 重启，或先结束该 PID |
| 群组中发消息无响应 | 预期行为：Bot 只处理私聊 |
| 图片/语音提示不支持 | 当前模型未声明对应输入能力；换用多模态模型或在 `opencode.json` 中开启 `attachment` |
| 附件下载失败 / 超过 20MB | Telegram Bot API 限制；压缩后重发 |
| agent 不存在 / 400 | 确认 `OPENCODE_AGENT` 与 `.opencode/agent/*.md` 名称一致，并重启 opencode serve |

## 安全说明

- `.env`、`data/`、`dist/` 已在 `.gitignore` 中。
- 首次连接向导的输出只显示掩码 Token；`.env` 原子写入且权限为 `0600`，Token 不会进入日志或 Telegram 消息（终端输入行仍会回显）。
- `opencode.json` 不再包含明文密钥；密钥统一放在 `.env`。
- 若密钥曾以明文形式存放或分享，请在供应商后台轮换 `GROK_API_KEY` / `MY_API_KEY`。
- Agent CLI 引擎默认以各家的免确认参数运行（如 Claude Code 的 `--dangerously-skip-permissions`、Codex 的 `--dangerously-bypass-approvals-and-sandbox`），且 OpenCode agent 允许 bash/edit，请在可信环境中使用。
- 子进程环境会先剥离 Bot 自身的访问控制变量：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_ALLOW_USERS`、`TELEGRAM_ALLOW_ALL_USERS`、`OPENCODE_SERVER_USERNAME`、`OPENCODE_SERVER_PASSWORD` 不会传给任何 Agent CLI、运维命令或安装器（否则一个被劫持的 CLI 就能以 Bot 身份操作全部白名单会话）。运行中的 Agent 仍保留自己的供应商 Key；`/agents install` 用的安装器额外剥离所有名称形似密钥的变量，因为 npm 会执行包作者写的 lifecycle 脚本。
- `/agents install` 只执行内置白名单中的 npm/pip 包，不接受用户自定义命令；`/agents update` 只对 `data/agent-cli-installs.json` 中由 Bot 安装的包重跑同一条白名单安装命令；`/agents uninstall` 只删除由 Bot 安装的版本，不会动系统预装 CLI。
- `/ops` 的更新、重启、服务启停、cc-switch 安装都只执行固定命令并要求确认；不接受任意 shell 输入。`/env` 只开放非密钥配置，密钥字段永远不读取、不显示、不写入。日志输出会统一去除 ANSI 并脱敏 Token、API Key、密码与 URL 凭据。所有发往 Telegram 的文本与写入日志的错误信息，都会额外把 Bot 自身的 Token 替换为 `***`。
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
| `scripts/install-cc-switch.sh` | 下载 cc-switch CLI 到 `./bin`（`npm run cc-switch:install`） |
| `scripts/restart.sh` | 构建产物重启 Bot 并维护 `data/bot.pid` |
