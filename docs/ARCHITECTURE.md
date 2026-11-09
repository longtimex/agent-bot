# 项目架构

本文记录 `agent-bot` 的分层边界和拆分规则。目标是让新增能力落在正确的层，而不是继续堆进 `telegram.ts` / `api.ts`。

## 分层

```text
Telegram / Feishu / Android App
        │
        ▼
┌──────────────┐  ┌───────────────────┐  ┌──────────────────┐
│  Telegram    │  │  飞书传输层        │  │  HTTP API 传输层  │
│  telegram.ts │  │  feishu*.ts        │  │  api.ts           │
└──────┬───────┘  └────────┬──────────┘  └────────┬─────────┘
       │                   │                       │
       └───────────────────┴───────────┬───────────┘
                         ▼
              服务与领域模块
   apiTasks / apiPersonal / apiCc / engineCall
   reminders / scheduler / models / ops / release / proxy …
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
      OpenCode       Agent CLI       JSON stores
```

### 传输层

- `src/telegram.ts`：命令分发、面板跳转、任务队列入口。
- `src/feishu.ts` / `src/feishuApi.ts` / `src/feishuCards.ts` / `src/feishuAttachments.ts`：飞书长连接事件、卡片按钮、消息与附件适配。普通消息走 SDK 长连接；SDK 长连接不分发卡片回调，因此按钮由可选的 `feishuCallback.ts` HTTP 入口接收并复用同一处理函数。飞书事件被转换为合成 grammY Update，出站 Bot API 调用由 transformer 改道飞书，因此不会维护第二套命令实现。
- `src/feishuIdentity.ts` / `src/channelRegistry.ts`：把飞书 `open_id` / `chat_id` 映射到持久化的私有数字命名空间，并为会话键加上 `tg:` / `fs:` 前缀，避免与 Telegram ID 或彼此上下文串线。
- `src/api.ts`：`/api/v1` 路由、鉴权、请求解码。
- `src/setup.ts` / `src/setup-cli.ts`：安装期控制端配置向导。它只负责选择客户端、校验输入并把结果原子写入 `.env`；不启动长连接，也不承载运行时逻辑。
- 传输层只做三件事：解码请求、调用一个服务方法、把错误映射成 Telegram/HTTP 错误。

### 服务与领域模块

- `src/apiTasks.ts`：API 任务队列、SSE、重试、停止、附件摘要。
- `src/apiTaskRoutes.ts`：任务路由的薄适配层。
- `src/apiPersonal.ts`：提醒、定时、目录、时区、白名单等个人数据路由。
- `src/apiCc.ts` / `src/apiCcSpecs.ts`：cc-switch 路由与白名单表。
- `src/engineCall.ts`：OpenCode / Agent CLI 统一调用入口。
- `src/reminders.ts` / `src/scheduler.ts`：提醒与定时任务。
- `src/ops.ts`：运维诊断、日志、服务管理与更新编排的入口。
- `src/releaseManager.ts`：在隔离的 staging checkout 中构建 release，维护 `data/releases/store`、`state.json`、保留策略与 current/previous/pending 指针。
- `src/updateOrchestrator.ts`：更新生命周期：备份状态 → 构建与门禁 → pending → 取消 pending/回滚；不直接改运行中的 checkout。
- `src/updateChecker.ts`：`stable` / `beta` 更新目标、只读更新检查与 release 诊断。
- `src/releaseStatus.ts`：`GET /ops/release` 的轻量版本卡，不触发 git/OpenCode/磁盘探针。
- `src/release-control.ts`：`scripts/apply-release.sh` 使用的状态 CLI（entry/current-id/activate/rollback/record-ok），保证 shell 不手写 JSON。
- `src/startupSelfCheck.ts`：启动自检与失败记录；成功记录写在各控制端启动之后，供无 API 部署做发布健康检查。
- `src/dataMigration.ts`：启动前的数据 schema 快照、迁移标记与保留策略。
- `src/androidRelease.ts`：Android 更新清单校验、APK 路径边界、SHA-256/大小复核与下载路由。
- `src/ccswitch.ts` / `src/ccCommands.ts` / `src/ccGuards.ts`：cc-switch 适配与危险命令拦截。

### 聊天子模块（Telegram / 飞书共用）

命令与面板的领域逻辑按命令组拆到独立模块，`telegram.ts` 只保留委托方法；这些模块同时服务 Telegram 与飞书：

| 模块 | 职责 |
| --- | --- |
| `telegramSupport.ts` | 时间、ID、格式化等纯辅助 |
| `telegramStats.ts` | 使用统计、历史、运行状态面板 |
| `telegramPersonalPanels.ts` | 代理、队列、快捷指令、提醒、定时、白名单、时区面板 |
| `telegramCorePanels.ts` | 欢迎页、主菜单、Agent/模型/目录/安装面板 |
| `telegramPersonalCommands.ts` | 提醒、快捷指令、定时任务命令 |
| `telegramModelCommands.ts` | 模型切换、恢复默认、工作目录 |
| `telegramOpsCommands.ts` | 诊断、日志、更新、备份、服务、配置项 |
| `telegramAgentCommands.ts` | Agent 切换、CLI 安装/更新/卸载 |
| `telegramProxyCommands.ts` | 代理管理 |
| `telegramAdminCommands.ts` | 白名单、时区 |
| `telegramAttachments.ts` | 入站附件收集、下载、模型输入构建 |
| `telegramInfoCommands.ts` | 队列、配对信息、导出、状态、统计 |
| `telegramMedia.ts` | 出站媒体、远程媒体下载、SSRF/大小限制 |

## 新增能力放哪里

1. **聊天命令**：新建或扩展对应 `telegram*Commands.ts`，不要直接写进 `telegram.ts`。这些模块同时服务 Telegram 与飞书；不要把平台专属调用写进领域逻辑。
2. **HTTP 路由**：参数解码留在 `api.ts`，领域操作放到 `api*.ts` 或已有服务。
3. **跨客户端能力**：先做服务方法，再让 Telegram、飞书与 API 各自调用；不要只写在一个 handler 里。需要发消息、编辑面板或上传媒体时，只调用 grammY Bot API，飞书 transformer 会负责翻译。
4. **纯工具**：放到 `telegramSupport.ts`、`messages.ts`、`media.ts` 等无状态模块。
5. **持久化**：沿用 `store.ts` / `usage.ts` / `history.ts` 的原子写与损坏隔离规则。

## 约束

- 传输层不直接操作文件、进程或子进程；这类工作放到服务/适配器。
- 每个新模块通过 `Deps` 接口注入依赖，避免直接依赖 `TelegramBridge` / `ApiServer` 私有状态。
- 行为变化必须带测试；测试放在 `tests/`，优先覆盖边界、失败和并发语义。
- 不把 APK、构建产物或密钥提交进仓库；`android/releases/` 已在 `.gitignore` 中。
- 模块体积由 `npm run check:size` 把关，防止重新长成超大文件。
- 发布构建只写 `data/releases/.staging-*` 与 `data/releases/store/`；运行中的 checkout 与 `dist/` 不得被 `/update` 原地改写。
- release 健康检查必须绑定本次启动：有 API 时校验 `/health`，无 API 时校验 `data/startup-check.json` 的 release、时间与 PID，不能接受旧成功记录。
- 切换 `debug` 与正式 release 签名 APK 需要卸载重装，属于 Android 签名身份约束；文档与 UI 必须明确本地 App 数据会丢失。

## 数据流

```text
Telegram / 飞书消息 / App 任务
  → 命令/路由解码
  → 任务队列（每会话串行）
  → engineCall（OpenCode 或 Agent CLI）
  → 进度/终态
  → Telegram 卡片 / 飞书交互卡片 / API SSE
  → usage / history / attachments
```

飞书与 Telegram 共享同一进程内服务，但会话、usage 与提醒记录使用独立渠道前缀和身份编号；通知类消息由持久化的 owner 聊天投递，不会因另一渠道启动而丢失。

## 相关文档

- `README.md`：安装、命令、HTTP API
- `CHANGELOG.md`：版本变更
- `DEEP-100.md`：深度审查台账
- `android/README.md`：安卓构建与连接

## 发布脚本

| 脚本 | 边界 |
| --- | --- |
| `scripts/run-current.sh` | systemd 唯一入口，只选择并 `exec` current release；首次部署回退 checkout 的 `dist/index.js` |
| `scripts/apply-release.sh` | 激活 pending 或重启 current，健康检查失败回滚；`RELEASE_SUPERVISOR=systemd` 时用 `systemctl`/`systemd-run`，否则管理脚本 PID |
| `scripts/release-health.mjs` | 发布健康探针；API 可用时用 `/health`，否则要求本次启动的 self-check |
| `scripts/publish-android-release.mjs` | 发布 App APK、按实际字节计算哈希/大小并原子写清单 |
| `scripts/check-release.mjs` | 发布门禁（类型、Android 源码、体积、单测） |
