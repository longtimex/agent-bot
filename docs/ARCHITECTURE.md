# 项目架构

本文记录 `agent-bot` 的分层边界和拆分规则。目标是让新增能力落在正确的层，而不是继续堆进 `telegram.ts` / `api.ts`。

## 分层

```text
Telegram / Android App
        │
        ▼
┌───────────────────┐        ┌──────────────────┐
│  Telegram 传输层   │        │  HTTP API 传输层  │
│  telegram.ts       │        │  api.ts           │
└─────────┬─────────┘        └────────┬─────────┘
          │                            │
          └──────────────┬─────────────┘
                         ▼
              服务与领域模块
   apiTasks / apiPersonal / apiCc / engineCall
   reminders / scheduler / models / ops / proxy …
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
      OpenCode       Agent CLI       JSON stores
```

### 传输层

- `src/telegram.ts`：命令分发、面板跳转、任务队列入口。
- `src/api.ts`：`/api/v1` 路由、鉴权、请求解码。
- 传输层只做三件事：解码请求、调用一个服务方法、把错误映射成 Telegram/HTTP 错误。

### 服务与领域模块

- `src/apiTasks.ts`：API 任务队列、SSE、重试、停止、附件摘要。
- `src/apiTaskRoutes.ts`：任务路由的薄适配层。
- `src/apiPersonal.ts`：提醒、定时、目录、时区、白名单等个人数据路由。
- `src/apiCc.ts` / `src/apiCcSpecs.ts`：cc-switch 路由与白名单表。
- `src/engineCall.ts`：OpenCode / Agent CLI 统一调用入口。
- `src/reminders.ts` / `src/scheduler.ts`：提醒与定时任务。
- `src/ops.ts`：运维诊断、日志、更新、服务管理。
- `src/ccswitch.ts` / `src/ccCommands.ts` / `src/ccGuards.ts`：cc-switch 适配与危险命令拦截。

### Telegram 子模块

Telegram 的领域逻辑按命令组拆到独立模块，`telegram.ts` 只保留委托方法：

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

1. **Telegram 命令**：新建或扩展对应 `telegram*Commands.ts`，不要直接写进 `telegram.ts`。
2. **HTTP 路由**：参数解码留在 `api.ts`，领域操作放到 `api*.ts` 或已有服务。
3. **跨客户端能力**：先做服务方法，再让 Telegram 与 API 各自调用；不要只写在一个 handler 里。
4. **纯工具**：放到 `telegramSupport.ts`、`messages.ts`、`media.ts` 等无状态模块。
5. **持久化**：沿用 `store.ts` / `usage.ts` / `history.ts` 的原子写与损坏隔离规则。

## 约束

- 传输层不直接操作文件、进程或子进程；这类工作放到服务/适配器。
- 每个新模块通过 `Deps` 接口注入依赖，避免直接依赖 `TelegramBridge` / `ApiServer` 私有状态。
- 行为变化必须带测试；测试放在 `tests/`，优先覆盖边界、失败和并发语义。
- 不把 APK、构建产物或密钥提交进仓库；`android/releases/` 已在 `.gitignore` 中。
- 模块体积由 `npm run check:size` 把关，防止重新长成超大文件。

## 数据流

```text
Telegram 消息 / App 任务
  → 命令/路由解码
  → 任务队列（每会话串行）
  → engineCall（OpenCode 或 Agent CLI）
  → 进度/终态
  → Telegram 卡片 / API SSE
  → usage / history / attachments
```

## 相关文档

- `README.md`：安装、命令、HTTP API
- `CHANGELOG.md`：版本变更
- `DEEP-100.md`：深度审查台账
- `android/README.md`：安卓构建与连接
