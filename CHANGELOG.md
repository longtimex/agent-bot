# 更新日志

本项目的显著变更记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
