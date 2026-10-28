# Telegram opencode 私人助手

把 Telegram 官方 Bot 接到本地 `opencode serve` 与 `qoder` CLI 上的私人 AI 助手。

```
Telegram Client ⇄ Telegram Bot API ⇄ 本项目 ⇄ opencode serve ⇄ 模型 + 工具
                                        └── qoder CLI（可选引擎）
```

## 功能

- **Telegram 官方 Bot**：长轮询，无需公网地址，无需扫码。
- **双引擎切换**：`/agent opencode`（多模型、工具调用）与 `/agent qoder`（本地编程 CLI）。
- **多模型切换**：Claude Sonnet/Opus、Gemini 3.8/4、Grok 4.7、GPT OSS、DeepSeek、GLM、MiMo、Nemotron 等。
- **交互面板**：`/start`、`/agent`、`/model`、`/reminders`、`/schedule`、`/proxy`、`/usage` 均带内联按钮，可直接点选切换引擎/模型、暂停任务、取消提醒或操作代理。
- **实时进度**：处理时间超过 2 秒后显示进度卡片（带「停止任务」按钮），并持续发送 typing 状态。
- **重试与队列**：失败消息附带「重试」按钮；`/retry` 重发上一条任务；`/queue` 查看或清空排队消息。
- **网络代理**：Telegram 内添加 HTTP/HTTPS/SOCKS4/SOCKS5 代理，自动测试连通性，可启用、停用、删除；远程媒体、Qoder 与 Agent 网络命令自动使用。
- **附件接收**：可直接发送图片、文件、语音；文本/代码文件会读取内容，图片/PDF/音频按当前模型能力附加。
- **原生附件**：模型通过 `[[image:...]]` 等指令发送图片、视频、语音、文档。
- **白名单**：默认只允许 `.env` 中配置的 Telegram 用户；未配置时拒绝启动。
- **仅私聊**：只响应私聊消息，群组/频道消息直接忽略，避免误触发。
- **定时提醒**：`/remind 30m 喝水` 即可设置；支持重复提醒（`every 30m`、`每天 08:30`）；保存在 `data/reminders.json`，重启后仍然有效。
- **定时 AI 任务**：`/schedule add 每天 09:00 检查服务器` 到点自动调用 AI 执行提示词并回传结果；支持一次性与重复任务、指定引擎/模型、暂停/恢复/删除，保存在 `data/schedules.json`。
- **使用统计**：`/usage` 查看任务量、成功率、平均耗时、今日任务与引擎分布，持久化到 `data/usage.json`。
- **任务取消**：`/stop` 可立即终止正在执行的 OpenCode / Qoder 任务，并清空排队中的提示。
- **单实例**：`data/bot.lock` 防止重复启动；异常退出后残留的锁会被自动回收。
- **会话持久化**：`data/sessions.json` 保存会话 ID、引擎与模型偏好，重启后自动恢复。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/start` | 欢迎页：当前引擎/模型 + 快捷按钮 |
| `/help` | 完整命令与功能说明 |
| `/agent` | 查看或切换引擎（`opencode` / `qoder`），支持按钮 |
| `/model` | 查看或切换模型，支持按钮 |
| `/new`、`/reset` | 重置当前会话上下文 |
| `/stop` | 停止当前任务（同时丢弃排队中的提示） |
| `/retry` | 重新发送上一条任务（失败提示上也有「重试」按钮） |
| `/queue` | 查看排队消息，可一键清空；当前任务不受影响 |
| `/status` | 查看引擎、模型、运行时长、今日任务、代理、队列与提醒数 |
| `/usage` | 查看任务量、成功率、平均耗时、今日与引擎统计 |
| `/schedule` | 定时 AI 任务面板：查看、暂停、恢复、删除 |
| `/schedule add 30m 检查服务器` | 到点自动执行 AI 任务；支持 `every 2h`、`每天 09:00` |
| `/schedule add --engine qoder --model deepseek 2h 汇总日志` | 指定执行引擎与模型 |
| `/remind 30m 喝水` | 定时提醒：支持相对时长、`18:30`、`明天 08:30` |
| `/remind every 30m 喝水` | 重复提醒：也支持 `每30m`、`每天 08:30` |
| `/reminders` | 查看待触发提醒，可点按钮取消 |
| `/cancel <编号>` | 取消指定提醒 |
| `/proxy` | 管理网络代理：添加、测试、启用、停用、删除 |
| `/id` | 查看聊天 ID、用户 ID、时区与会话 ID |

## 目录

```
bot/
├── src/
│   ├── index.ts      入口：配置加载、单实例锁、服务健康检查、定时清理
│   ├── config.ts     .env 解析、白名单与超时配置
│   ├── lock.ts       PID 锁文件（单实例 + 陈旧锁回收）
│   ├── telegram.ts   Telegram 消息、命令、附件发送
│   ├── models.ts     模型表与别名解析
│   ├── progress.ts   进度卡片
│   ├── opencode.ts   opencode HTTP/SSE 客户端
│   ├── qoder.ts      qoder CLI 子进程封装
│   ├── media.ts      [[image:...]] 指令解析、outbox 校验与清理
│   ├── attachments.ts 入站附件保存、文本内联、inbox 清理
│   ├── reminders.ts  定时提醒：解析、重复调度、持久化、轮询投递
│   ├── scheduler.ts  定时 AI 任务：解析、引擎/模型快照、持久化、执行与重复调度
│   ├── usage.ts      使用统计：任务量、成功率、耗时与每日聚合
│   ├── proxy.ts      HTTP(S)/SOCKS 代理：持久化、连通性测试、dispatcher
│   ├── messages.ts   长消息切分
│   ├── store.ts      会话持久化
│   └── logger.ts
├── tests/            单元测试（node:test）
├── deploy/           systemd 单元示例
├── scripts/          邮件、X、搜图、免费服务器扫描/抢注、重启脚本
├── .opencode/agent/assistant.md   Bot 的 agent 人设与工具权限
├── opencode.json     Provider 与模型配置
└── data/             会话状态、提醒、定时任务、使用统计、日志、代理配置、outbox 与 inbox 附件
```

## 配置

复制 `.env.example` 为 `.env`，至少填写：

```ini
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOW_USERS=你的Telegram用户ID
OPENCODE_SERVER_PASSWORD=与 opencode serve 一致
MY_API_KEY=...
```

完整变量见 `.env.example`：

- `TELEGRAM_ALLOW_USERS`：逗号分隔的白名单；为空且未设置 `TELEGRAM_ALLOW_ALL_USERS=1` 时拒绝启动。
- `TASK_TIMEOUT_MS` / `TASK_MAX_TIMEOUT_MS`：无活动超时与任务绝对上限，默认均为 10 分钟，两个引擎共用。
- `MAX_MEDIA_MB` / `MAX_INPUT_MB`：出站单文件与入站附件上限，默认均为 20MB。
- `MEDIA_ALLOW_PRIVATE_URLS`：默认 `0`，拒绝远程媒体链接访问本机/内网地址；仅在本地调试时设为 `1`。
- `REMINDER_TIMEZONE`：提醒时间解析所用 IANA 时区，默认 `Asia/Shanghai`；无效时拒绝启动。
- `OPENCODE_AGENT`：默认 `assistant`，对应 `.opencode/agent/assistant.md`。
- `GROK_API_KEY`：Grok provider 的密钥，`opencode.json` 通过 `{env:GROK_API_KEY}` 读取。
- `SNIPER_EMAIL` / `SNIPER_PASSWORD`：仅 `scripts/sniper_free_vps.mjs` 使用。

## 运行

```bash
npm install
npm run serve      # 启动 opencode 无头服务（127.0.0.1:4096）
npm run build
npm run restart    # 按 data/bot.pid 优雅停止旧进程并后台启动
```

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
- 校验会解析符号链接，防止通过 outbox 内的链接读取目录外文件。
- 单条回复最多 5 个附件；默认单文件上限 20MB（`MAX_MEDIA_MB`）。
- 远程链接默认拒绝回环/私网/链路本地地址（含重定向后的每一跳），并限制下载体积；调试内网地址需显式设置 `MEDIA_ALLOW_PRIVATE_URLS=1`。

## 接收图片 / 文件 / 语音

直接发送附件即可，可附带文字说明作为提示词：

| 输入 | 处理方式 |
| --- | --- |
| 文本/代码文件（`.txt`/`.md`/`.json`/`.ts`/`.log` 等） | 读取内容并随提示词发送（最多 6 万字，超出截断） |
| 图片 | 保存到 `data/inbox/`；当前模型声明支持图片时作为附件发送 |
| PDF | 同上（按模型的 PDF 能力） |
| 语音/音频 | 保存到 `data/inbox/`；模型支持音频时直接附加，否则提示无法转写 |

- 附件保存在 `data/inbox/`，超过 24 小时自动清理；单文件上限 20MB（`MAX_INPUT_MB`），单条消息附件合计上限 15MB、内联文本合计 10 万字。
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
- 生效范围：远程媒体下载、Qoder 子进程，以及 Agent 通过 `scripts/proxy-exec.sh` 执行的网络命令（`assistant.md` 已要求 Agent 自动使用）。
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
/reminders                 # 查看待触发列表
/cancel 3                  # 取消编号为 3 的提醒
```

- 时间按 `REMINDER_TIMEZONE`（默认 `Asia/Shanghai`）解析，与服务器系统时区无关。
- 提醒保存在 `data/reminders.json`，每 15 秒检查一次；Bot 重启后仍然有效。
- 重复提醒在每次成功投递后自动排下一次；停机期间错过的周期不会补发多条，而是直接排到下一个未来时间点。
- 停机期间到期的一次性提醒会在启动后补发，并标记「补发」；过期超过 7 天的提醒会被丢弃。
- 投递失败（例如 Telegram 暂时不可用）会保留提醒，并按 1 分钟 → 5 分钟 → 15 分钟 → 1 小时退避重试；连续失败 8 次后放弃并记录错误。
- 每个会话最多同时保留 20 条提醒；提醒投递依赖 Bot 进程运行。

## 定时 AI 任务

```text
/schedule                                          # 打开任务面板
/schedule add 30m 检查服务器                       # 10 分钟后执行一次
/schedule add every 2h 汇总日志                    # 每 2 小时重复
/schedule add 每天 09:00 生成日报                  # 每天固定时间重复
/schedule add --engine qoder --model deepseek 2h 汇总日志
/schedule pause 3 / resume 3 / del 3               # 暂停 / 恢复 / 删除
```

- 时间格式与 `/remind` 相同（`30m`、`18:30`、`明天 08:30`、`every 2h`、`每天 09:00`），按 `REMINDER_TIMEZONE` 解析。
- 创建时会快照当前引擎与模型；也可用 `--engine opencode|qoder` 和 `--model <简称>` 覆盖。OpenCode 模型简称见 `/model`，Qoder 支持 `deepseek` / `qwen`。
- 到点后任务进入该会话的普通队列执行，结果以普通回复发到聊天；执行中可发送 `/stop` 取消。
- 一次性任务执行后自动删除；重复任务在每次执行结束后排下一次，停机期间错过的周期直接跳过。
- 任务保存在 `data/schedules.json`（权限 600）；Bot 重启后继续生效，崩溃中断的任务会在下次启动时补跑。
- 失败不会自动重试；每个会话最多 20 个任务，提示词上限 2000 字。
- 面板中的「暂停 / 恢复 / 删除」按钮与 `/schedule pause|resume|del 编号` 等价；`/status` 会显示任务数量。

## 使用统计

```text
/usage
```

- 统计每个会话的任务总数、成功 / 失败 / 取消、成功率、平均耗时、今日任务与引擎使用次数。
- 数据保存在 `data/usage.json`（权限 600），按 `REMINDER_TIMEZONE` 划分自然日，仅保留最近 31 个有记录的日子。
- 只记录任务结果与耗时，不保存提示词或回复内容。
- `/status` 也会显示今日任务数；面板与状态页均可点击「刷新」查看最新数据。

## 超时与错误

两个引擎统一使用：

- 无活动超时：超过 `TASK_TIMEOUT_MS`（默认 10 分钟）没有任何输出即中止。
- 绝对上限：任务总耗时达到 `TASK_MAX_TIMEOUT_MS`（默认 10 分钟）即中止；长任务可调大。
- OpenCode 超时会调用 `POST /session/:id/abort` 终止服务端生成；Qoder 会终止整个进程组。

常见故障：

| 现象 | 处理 |
| --- | --- |
| `请求失败: ECONNREFUSED` | 本地 `opencode serve` 未启动，执行 `npm run serve` |
| `请求失败: UND_ERR_SOCKET` | 服务端连接被关闭；查看 opencode serve 日志与上游模型状态 |
| `fetch failed` | 已自动解包底层 `ECONNREFUSED` / `ETIMEDOUT` / socket 错误码；按对应原因处理 |
| `-> 404` 会话不存在 | Bot 会自动新建会话，上下文清空 |
| 启动报白名单错误 | 填写 `TELEGRAM_ALLOW_USERS` 或显式设置 `TELEGRAM_ALLOW_ALL_USERS=1` |
| 启动提示已有实例（PID） | 说明旧进程仍在运行；用 `npm run restart` 重启，或先结束该 PID |
| 群组中发消息无响应 | 预期行为：Bot 只处理私聊 |
| 图片/语音提示不支持 | 当前模型未声明对应输入能力；换用多模态模型或在 `opencode.json` 中开启 `attachment` |
| 附件下载失败 / 超过 20MB | Telegram Bot API 限制；压缩后重发 |
| agent 不存在 / 400 | 确认 `OPENCODE_AGENT` 与 `.opencode/agent/*.md` 名称一致，并重启 opencode serve |

## 安全说明

- `.env`、`data/`、`dist/` 已在 `.gitignore` 中。
- `opencode.json` 不再包含明文密钥；密钥统一放在 `.env`。
- 若密钥曾以明文形式存放或分享，请在供应商后台轮换 `GROK_API_KEY` / `MY_API_KEY`。
- Qoder 引擎以 `--dangerously-skip-permissions` 运行，且 agent 允许 bash/edit，请在可信环境中使用。

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
| `scripts/restart.sh` | 构建产物重启 Bot 并维护 `data/bot.pid` |
