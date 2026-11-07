import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { InlineKeyboard } from "grammy"
import { formatBytes } from "./attachments.js"
import { redactSecrets } from "./ccswitch.js"
import type { BotConfig } from "./config.js"
import type { Logger } from "./logger.js"
import { escapeMarkdown, splitMessage, type Panel } from "./messages.js"
import {
  OPS_ENV_KEYS,
  OPS_ENV_RULES,
  type OpsDiagnostics,
  type OpsResult,
  type OpsService,
} from "./ops.js"
import type { ReminderService } from "./reminders.js"
import type { ScheduleService } from "./scheduler.js"
import type { UsageStore } from "./usage.js"
import { formatDateTime, formatDuration, parseAllowUsers } from "./telegramSupport.js"

const OPS_CONFIRM_TTL_MS = 5 * 60_000

export type OpsConfirmKind = "restart" | "update" | "cc-install" | "cc-update" | "svc-stop" | "svc-restart"

export interface OpsCommandDeps {
  ops: OpsService
  cfg: BotConfig
  log: Logger
  timezone: () => string
  setTimezone: (zone: string) => void
  reminders: ReminderService
  schedules: ScheduleService
  usage: UsageStore
  runningSince: Map<string, number>
  sendText: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>
  sendPanel: (chatId: number, panel: Panel) => Promise<void>
  sendDocument: (chatId: number, data: Buffer, filename: string, caption: string) => Promise<unknown>
  offLoop: (chatId: number, label: string, run: () => Promise<void>) => void
  maskToken: (text: string) => string
}

export class TelegramOpsCommands {
  readonly #deps: OpsCommandDeps
  readonly #opsPending = new Map<string, { chatId: number; kind: OpsConfirmKind; createdAt: number }>()
  #opsRunning = ""

  constructor(deps: OpsCommandDeps) {
    this.#deps = deps
  }

  clearPending(): void {
    this.#opsPending.clear()
  }

  async handleDiagnostics(chatId: number): Promise<void> {
    try {
      const diag = await this.#deps.ops.diagnostics()
      await this.#deps.sendText(
        chatId,
        this.diagnosticsText(diag),
        new InlineKeyboard()
          .text("🔄 刷新", "ops:diag")
          .text("🛠 运维中心", "show:ops")
          .row()
          .text("⬅️ 主菜单", "show:menu"),
      )
    } catch (err) {
      await this.#deps.sendText(chatId, `❌ 诊断失败：${escapeMarkdown(err instanceof Error ? err.message : String(err))}`)
    }
  }

  diagnosticsText(diag: OpsDiagnostics): string {
    const git = diag.git
      ? `${escapeMarkdown(diag.git.branch)} @ ${escapeMarkdown(diag.git.commit)}${diag.git.dirty ? "（有未提交改动）" : ""}`
      : "不可用"
    const ccSwitch = diag.ccSwitch
      ? `已安装${diag.ccSwitch.version ? `（${escapeMarkdown(diag.ccSwitch.version)}）` : ""}`
      : "未安装"
    const opencode = diag.opencode.reachable ? "🟢 可访问" : "🔴 不可访问"
    const disk = diag.disk
      ? `${formatBytes(diag.disk.freeBytes)} 可用 / ${formatBytes(diag.disk.totalBytes)}`
      : "未知"
    const memory = `${formatBytes(diag.memory.freeBytes)} 可用 / ${formatBytes(diag.memory.totalBytes)}`
    return (
      `🩺 *系统诊断*\n\n` +
      `• Node：${escapeMarkdown(diag.node)}（${escapeMarkdown(diag.platform)}）\n` +
      `• Bot PID：${diag.pid} · 已运行 ${formatDuration(diag.uptimeSec * 1000)}\n` +
      `• 部署方式：${diag.systemd ? "systemd" : "脚本 / 手动"}\n` +
      `• 项目目录：\`${escapeMarkdown(diag.projectDir)}\`\n` +
      `• Git：${git}\n` +
      `• OpenCode：${opencode}${diag.opencode.pid ? `（PID ${diag.opencode.pid}）` : ""}\n` +
      `• OpenCode URL：\`${escapeMarkdown(diag.opencode.url)}\`\n` +
      `• cc-switch：${ccSwitch}\n` +
      `• Bot 日志：${formatBytes(diag.log.bytes)} · \`${escapeMarkdown(diag.log.path)}\`\n` +
      `• OpenCode 日志：${formatBytes(diag.opencodeLog.bytes)}\n` +
      `• 磁盘：${disk}\n` +
      `• 内存：${memory}\n` +
      `• 最近备份：${diag.lastBackupAt ? `${formatDateTime(diag.lastBackupAt, this.#deps.timezone())}（📦 备份数据）` : "尚未备份"}`
    )
  }

  async opsPanel(): Promise<Panel> {
    let head = "🛠 *运维中心*\n\n诊断暂时不可用。"
    try {
      head = this.diagnosticsText(await this.#deps.ops.diagnostics())
    } catch {
      // keep fallback text
    }
    const busy = this.#opsRunning ? `\n\n⏳ 正在执行：${escapeMarkdown(this.#opsRunning)}` : ""
    return {
      text: `🛠 *运维中心*\n\n${head}${busy}\n\n⚠️ 更新、重启与停止服务需要确认；不会读取或输出 .env 中的密钥。`,
      keyboard: this.opsKeyboard(),
    }
  }

  opsKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("🩺 诊断", "ops:diag")
      .text("📜 Bot 日志", "ops:logs:bot:80")
      .row()
      .text("⚡ OpenCode 服务", "ops:svc")
      .text("🧪 运行检查", "ops:check")
      .row()
      .text("🔌 cc-switch 安装/更新", "ops:cc")
      .text("⚙️ 配置项", "ops:env")
      .row()
      .text("🔐 访问白名单", "show:access")
      .text("🔍 检查更新", "ops:checkup")
      .row()
      .text("⬆️ 更新项目", "ops:update")
      .text("📦 备份数据", "ops:backup")
      .row()
      .text("🔄 重启 Bot", "ops:restart")
      .text("🔄 刷新", "show:ops")
      .row()
      .text("⬅️ 主菜单", "show:menu")
  }

  async handleLogs(chatId: number, arg: string): Promise<void> {
    let source: "bot" | "opencode" = "bot"
    let lines = 80
    for (const token of arg.split(/\s+/).filter(Boolean)) {
      if (token === "opencode" || token === "oc") source = "opencode"
      else if (token === "bot") source = "bot"
      else if (/^\d+$/.test(token)) lines = Math.min(400, Math.max(10, Number(token)))
    }
    const label = source === "opencode" ? "OpenCode" : "Bot"
    const result = this.#deps.ops.tailLogs(source, lines)
    if (result.missing) {
      await this.#deps.sendText(
        chatId,
        `📜 ${label} 日志尚未生成：\`${escapeMarkdown(result.path)}\``,
        new InlineKeyboard().text("🛠 运维中心", "show:ops"),
      )
      return
    }
    if (!result.ok) {
      await this.#deps.sendText(chatId, `❌ 读取日志失败：${escapeMarkdown(result.text)}`)
      return
    }
    const body = result.text || "（日志为空）"
    const text =
      `📜 *${label} 日志（最近 ${lines} 行）*\n` +
      `\`${escapeMarkdown(result.path)}\` · ${formatBytes(result.bytes)}\n\n` +
      `\`\`\`\n${body.replace(/```/g, "'''")}\n\`\`\``
    for (const chunk of splitMessage(text, 3800)) {
      await this.#deps.sendText(chatId, chunk)
    }
    await this.#deps.sendText(
      chatId,
      "发送 `/logs opencode 200` 可查看 OpenCode 日志。",
      new InlineKeyboard()
        .text("🔄 刷新日志", `ops:logs:${source}:${lines}`)
        .text("🛠 运维中心", "show:ops")
        .row()
        .text("⬅️ 主菜单", "show:menu"),
    )
  }

  async handleOpsCallback(
    chatId: number,
    action: string,
    answer: (text?: string) => Promise<void>,
  ): Promise<void> {
    if (action === "diag") {
      await answer("正在诊断…")
      this.#deps.offLoop(chatId, "诊断", () => this.handleDiagnostics(chatId))
      return
    }
    if (action.startsWith("logs:")) {
      const [, source = "bot", rawLines = "80"] = action.split(":")
      await answer()
      this.#deps.offLoop(chatId, "日志", () => this.handleLogs(chatId, `${source} ${rawLines}`))
      return
    }
    if (action === "restart") {
      await answer()
      await this.confirmRestart(chatId)
      return
    }
    if (action.startsWith("cnl:")) {
      const token = action.slice("cnl:".length)
      const pending = this.#opsPending.get(token)
      if (pending && pending.chatId !== chatId) {
        await answer("该按钮不属于当前会话")
        return
      }
      // A declined restart/update must not stay executable until its TTL expires
      this.#opsPending.delete(token)
      await answer("已取消")
      await this.#deps.sendText(
        chatId,
        "🚫 已取消，未执行任何操作。",
        new InlineKeyboard().text("🛠 运维中心", "show:ops"),
      )
      return
    }
    if (action.startsWith("cfm:")) {
      const token = action.slice("cfm:".length)
      const pending = this.#opsPending.get(token)
      if (!pending || Date.now() - pending.createdAt > OPS_CONFIRM_TTL_MS) {
        this.#opsPending.delete(token)
        await answer("操作已过期，请重新发起")
        await this.#deps.sendText(chatId, "⌛ 该确认按钮已过期或已被使用，请重新发起操作。")
        return
      }
      if (pending.chatId !== chatId) {
        await answer("该按钮不属于当前会话")
        return
      }
      this.#opsPending.delete(token)
      await answer()
      await this.runOpsConfirm(chatId, pending.kind)
      return
    }
    if (action === "update") {
      await answer()
      await this.confirmUpdate(chatId)
      return
    }
    if (action === "check") {
      await answer("开始检查…")
      void this.runOpsAction(chatId, "运行检查", () => this.#deps.ops.runCheck())
      return
    }
    if (action === "checkup") {
      await answer("正在检查更新…")
      void this.runOpsAction(chatId, "检查更新", () => this.#deps.ops.checkUpdate())
      return
    }
    if (action === "backup") {
      await answer("正在打包…")
      void this.runBackup(chatId)
      return
    }
    if (action === "cc") {
      await answer()
      // confirmCcSwitch runs a full diagnostics pass to know whether to offer install
      // or update, and that shells out to git and cc-switch
      this.#deps.offLoop(chatId, "cc-switch 安装", () => this.confirmCcSwitch(chatId))
      return
    }
    if (action === "svc") {
      await answer()
      this.#deps.offLoop(chatId, "服务面板", () => this.sendServicePanel(chatId))
      return
    }
    if (action === "svc:start") {
      await answer("正在启动…")
      void this.runOpsAction(chatId, "启动 OpenCode", () => this.#deps.ops.startOpencode())
      return
    }
    if (action === "svc:stop") {
      await answer()
      await this.confirmServiceAction(chatId, "stop")
      return
    }
    if (action === "svc:restart") {
      await answer()
      await this.confirmServiceAction(chatId, "restart")
      return
    }
    if (action === "env") {
      await answer()
      await this.#deps.sendPanel(chatId, this.envPanel())
      return
    }
    await answer()
  }

  async requestOpsConfirm(chatId: number, kind: OpsConfirmKind, body: string): Promise<void> {
    const now = Date.now()
    for (const [token, pending] of this.#opsPending) {
      if (now - pending.createdAt > OPS_CONFIRM_TTL_MS) this.#opsPending.delete(token)
    }
    const token = randomBytes(6).toString("hex")
    this.#opsPending.set(token, { chatId, kind, createdAt: now })
    await this.#deps.sendText(
      chatId,
      body,
      new InlineKeyboard().text("✅ 确认执行", `ops:cfm:${token}`).text("取消", `ops:cnl:${token}`),
    )
  }

  async runOpsConfirm(chatId: number, kind: OpsConfirmKind): Promise<void> {
    const blockedByTasks = "⚠️ 当前有任务正在执行，请先发送 `/stop` 再操作。"
    switch (kind) {
      case "restart":
        if (this.#deps.ops.systemd) {
          await this.confirmRestart(chatId)
          return
        }
        if (this.#deps.runningSince.size > 0) {
          await this.#deps.sendText(chatId, blockedByTasks)
          return
        }
        void this.runOpsAction(chatId, "重启 Bot", () => this.#deps.ops.restartBot())
        return
      case "update":
        void this.runOpsAction(chatId, "更新项目", () => this.#deps.ops.updateProject())
        return
      case "cc-install":
        void this.runOpsAction(chatId, "安装 cc-switch", () => this.#deps.ops.installCcSwitch(false))
        return
      case "cc-update":
        void this.runOpsAction(chatId, "更新 cc-switch", () => this.#deps.ops.installCcSwitch(true))
        return
      case "svc-stop":
        if (this.#deps.runningSince.size > 0) {
          await this.#deps.sendText(chatId, blockedByTasks)
          return
        }
        void this.runOpsAction(chatId, "停止 OpenCode", () => this.#deps.ops.stopOpencode())
        return
      case "svc-restart":
        if (this.#deps.runningSince.size > 0) {
          await this.#deps.sendText(chatId, blockedByTasks)
          return
        }
        void this.runOpsAction(chatId, "重启 OpenCode", () => this.#deps.ops.restartOpencode())
        return
    }
  }

  /** Packs data/*.json and sends the archive into the chat; keeps ops-slot exclusivity. */
  async runBackup(chatId: number): Promise<void> {
    if (this.#opsRunning) {
      await this.#deps.sendText(chatId, `⏳ 正在执行「${escapeMarkdown(this.#opsRunning)}」，请稍后再试。`)
      return
    }
    this.#opsRunning = "备份数据"
    try {
      const result = await this.#deps.ops.backupData()
      if (result.ok && result.file) {
        const name = result.file.split("/").pop() ?? "backup.tar.gz"
        await this.#deps.sendDocument(chatId, readFileSync(result.file), name, escapeMarkdown(result.message))
      } else {
        await this.sendOpsResult(chatId, result)
      }
      await this.#deps.sendPanel(chatId, await this.opsPanel())
    } catch (err) {
      const detail = redactSecrets((err as Error).message)
      this.#deps.log.error(`ops 备份数据 failed:`, this.#deps.maskToken(detail))
      await this.#deps.sendText(chatId, `❌ 备份数据失败：${escapeMarkdown(detail)}`)
    } finally {
      this.#opsRunning = ""
    }
  }

  async runOpsAction(chatId: number, label: string, action: () => Promise<OpsResult>): Promise<void> {
    if (this.#opsRunning) {
      await this.#deps.sendText(chatId, `⏳ 正在执行「${escapeMarkdown(this.#opsRunning)}」，请稍后再试。`)
      return
    }
    this.#opsRunning = label
    const restarting = label.includes("重启 Bot")
    try {
      await this.#deps.sendText(chatId, `⏳ 正在${escapeMarkdown(label)}…`)
      const result = await action()
      this.#deps.log.info(`ops ${label}: ${result.ok ? "ok" : "failed"}`)
      await this.sendOpsResult(chatId, result)
      if (!restarting) await this.#deps.sendPanel(chatId, await this.opsPanel())
    } catch (err) {
      const detail = redactSecrets((err as Error).message)
      this.#deps.log.error(`ops ${label} failed:`, this.#deps.maskToken(detail))
      await this.#deps.sendText(chatId, `❌ ${escapeMarkdown(label)}失败：${escapeMarkdown(detail)}`)
    } finally {
      this.#opsRunning = ""
    }
  }

  async sendOpsResult(chatId: number, result: OpsResult): Promise<void> {
    let text = `${result.ok ? "✅" : "❌"} ${escapeMarkdown(redactSecrets(result.message))}`
    for (const step of result.steps) {
      text += `\n\n${step.ok ? "✅" : "❌"} ${escapeMarkdown(step.label)}${
        step.code !== null ? `（退出码 ${step.code}）` : ""
      }`
      if (step.output) {
        // Command output can echo env vars (npm/git failures), so scrub it before sending
        text += `\n\`\`\`\n${redactSecrets(step.output).replace(/```/g, "'''")}\n\`\`\``
      }
    }
    for (const chunk of splitMessage(text, 3800)) {
      await this.#deps.sendText(chatId, chunk)
    }
  }

  async confirmRestart(chatId: number): Promise<void> {
    if (this.#deps.ops.systemd) {
      await this.#deps.sendText(
        chatId,
        "ℹ️ 当前 Bot 由 systemd 管理，Bot 不会执行脚本重启。\n请运行 `sudo systemctl restart telegram-bot`（或你的服务名）。",
      )
      return
    }
    if (this.#deps.runningSince.size > 0) {
      await this.#deps.sendText(chatId, "⚠️ 当前有任务正在执行，请先发送 `/stop` 再重启，避免丢失回复。")
      return
    }
    await this.requestOpsConfirm(
      chatId,
      "restart",
      "🔄 *确认重启 Bot？*\n\n会在数秒内完成构建产物重启，期间 Bot 短暂离线。\n" +
        "如果正在执行任务，请先发送 `/stop`。\n\n_5 分钟内有效，点击确认后执行。_",
    )
  }

  async confirmUpdate(chatId: number): Promise<void> {
    await this.requestOpsConfirm(
      chatId,
      "update",
      "⬆️ *确认更新项目？*\n\n将依次执行：\n" +
        "1. `git status --porcelain`：工作区有未提交改动会直接中止\n" +
        "2. `git pull --ff-only`\n" +
        "3. `npm install --no-audit --no-fund`\n" +
        "4. `npm run build`\n\n" +
        "更新不会自动重启，完成后可点击「重启 Bot」。\n\n_5 分钟内有效，点击确认后执行。_",
    )
  }

  async confirmCcSwitch(chatId: number): Promise<void> {
    let installed = false
    try {
      installed = Boolean((await this.#deps.ops.diagnostics()).ccSwitch)
    } catch {
      installed = false
    }
    await this.requestOpsConfirm(
      chatId,
      installed ? "cc-update" : "cc-install",
      `🔌 *${installed ? "更新" : "安装"} cc-switch CLI？*\n\n` +
        "将运行 `scripts/install-cc-switch.sh` 下载对应平台的二进制到 `./bin/cc-switch`。" +
        (installed ? "\n已有版本会被覆盖（`--force`）。" : "") +
        "\n下载需要网络；已启用的代理会自动生效。\n\n_5 分钟内有效，点击确认后执行。_",
    )
  }

  async servicePanel(): Promise<Panel> {
    let status: { reachable: boolean; managed: boolean; pid?: number; url: string }
    try {
      status = await this.#deps.ops.opencodeStatus()
    } catch {
      status = { reachable: false, managed: false, url: this.#deps.cfg.opencode.url }
    }
    const state = status.reachable ? "🟢 运行中" : "🔴 未运行"
    const managed = status.pid
      ? `由 Bot 托管（PID ${status.pid}）`
      : status.reachable
        ? "运行中，但未由 Bot 托管"
        : "未运行"
    return {
      text:
        `⚡ *OpenCode 服务*\n\n• 状态：${state}\n• 托管：${managed}\n• URL：\`${escapeMarkdown(status.url)}\`\n\n` +
        "Bot 只会停止由自己启动的 OpenCode（通过 `data/opencode.pid` 识别），不会误杀手动启动的进程。",
      keyboard: new InlineKeyboard()
        .text("▶️ 启动", "ops:svc:start")
        .text("🔄 重启", "ops:svc:restart")
        .row()
        .text("⏹ 停止", "ops:svc:stop")
        .text("📜 日志", "ops:logs:opencode:80")
        .row()
        .text("🔄 刷新", "ops:svc")
        .text("🛠 运维中心", "show:ops")
        .row()
        .text("⬅️ 主菜单", "show:menu"),
    }
  }

  /**
   * The service panel asks OpenCode whether it answers, which costs up to the health
   * timeout, so every caller runs this through `offLoop` instead of awaiting it on the
   * update loop.
   */
  async sendServicePanel(chatId: number): Promise<void> {
    await this.#deps.sendPanel(chatId, await this.servicePanel())
  }

  async handleServiceCommand(chatId: number, arg: string): Promise<void> {
    const tokens = arg.split(/\s+/).filter(Boolean)
    let action = (tokens[0] ?? "").toLowerCase()
    if (action === "opencode") action = (tokens[1] ?? "").toLowerCase()
    if (!action || action === "status") {
      this.#deps.offLoop(chatId, "服务面板", () => this.sendServicePanel(chatId))
      return
    }
    if (action === "start") {
      void this.runOpsAction(chatId, "启动 OpenCode", () => this.#deps.ops.startOpencode())
      return
    }
    if (action === "stop") {
      await this.confirmServiceAction(chatId, "stop")
      return
    }
    if (action === "restart") {
      await this.confirmServiceAction(chatId, "restart")
      return
    }
    await this.#deps.sendText(
      chatId,
      "用法：`/service opencode start|stop|restart`，或发送 `/service` 打开面板。",
    )
  }

  async confirmServiceAction(chatId: number, action: "stop" | "restart"): Promise<void> {
    if (this.#deps.runningSince.size > 0) {
      await this.#deps.sendText(chatId, "⚠️ 当前有任务正在执行，请先发送 `/stop` 再操作 OpenCode 服务。")
      return
    }
    const verb = action === "stop" ? "停止" : "重启"
    await this.requestOpsConfirm(
      chatId,
      action === "stop" ? "svc-stop" : "svc-restart",
      `⚡ *确认${verb} OpenCode？*\n\n${verb}期间所有依赖 OpenCode 的任务都会失败。\n` +
        "只会操作由 Bot 启动的实例；手动启动的实例会被拒绝。\n\n_5 分钟内有效，点击确认后执行。_",
    )
  }

  envPanel(): Panel {
    const list = this.#deps.ops.envList()
    const mapping = new Map(list.entries.map((entry) => [entry.key, entry]))
    const hidden = list.entries.filter((entry) => entry.secret).length
    const lines = OPS_ENV_KEYS.map((key) => {
      const entry = mapping.get(key)
      const shown = !entry ? "_未设置_" : entry.secret ? "***" : entry.value ? `\`${escapeMarkdown(entry.value)}\`` : "（空）"
      return `• \`${key}\` = ${shown} — ${escapeMarkdown(OPS_ENV_RULES[key]?.hint ?? "")}`
    })
    return {
      text:
        "⚙️ *配置项*\n\n" +
        `\`.env\`：${list.exists ? "已加载" : "不存在"}${hidden > 0 ? ` · 已隐藏 ${hidden} 个密钥类配置` : ""}\n\n` +
        `${lines.join("\n")}\n\n` +
        "修改：`/env set KEY VALUE`\n删除：`/env unset KEY`\n\n" +
        "_只允许修改上表中的非密钥配置；Telegram Token、API Key、密码等永远不会显示或修改。重启 Bot 后生效。_",
      keyboard: new InlineKeyboard()
        .text("🔄 刷新", "ops:env")
        .text("📜 日志", "ops:logs:bot:80")
        .row()
        .text("🛠 运维中心", "show:ops")
        .text("⬅️ 主菜单", "show:menu"),
    }
  }

  async handleEnvCommand(chatId: number, arg: string): Promise<void> {
    const [rawAction = "", rawKey = "", ...rest] = arg.split(/\s+/).filter(Boolean)
    const action = rawAction.toLowerCase()
    if (!action || action === "list" || action === "show") {
      await this.#deps.sendPanel(chatId, this.envPanel())
      return
    }
    if (action === "set") {
      if (!rawKey || rest.length === 0) {
        await this.#deps.sendText(chatId, "用法：`/env set KEY VALUE`，例如 `/env set LOG_LEVEL debug`。")
        return
      }
      const result = this.#deps.ops.envSet(rawKey, rest.join(" "))
      if (result.ok) this.applyLiveEnv(rawKey.trim().toUpperCase(), rest.join(" ").trim())
      await this.#deps.sendText(chatId, `${result.ok ? "✅" : "❌"} ${escapeMarkdown(result.message)}`)
      if (result.ok) await this.#deps.sendPanel(chatId, this.envPanel())
      return
    }
    if (action === "unset" || action === "del" || action === "delete") {
      if (!rawKey) {
        await this.#deps.sendText(chatId, "用法：`/env unset KEY`。")
        return
      }
      const result = this.#deps.ops.envUnset(rawKey)
      await this.#deps.sendText(chatId, `${result.ok ? "✅" : "❌"} ${escapeMarkdown(result.message)}`)
      if (result.ok) await this.#deps.sendPanel(chatId, this.envPanel())
      return
    }
    await this.#deps.sendText(
      chatId,
      "用法：`/env` 查看配置；`/env set KEY VALUE` 修改；`/env unset KEY` 删除。",
    )
  }

  /** Some .env keys can be honoured by the running process, so the user does not have to restart. */
  applyLiveEnv(key: string, value: string): void {
    if (key === "REMINDER_TIMEZONE") {
      this.#deps.setTimezone(value)
      this.#deps.reminders.setTimeZone(value)
      this.#deps.schedules.setTimeZone(value)
      this.#deps.usage.setTimeZone(value)
      return
    }
    if (key === "TELEGRAM_ALLOW_USERS") {
      const ids = parseAllowUsers(value)
      // An empty list would lock everyone out; config.ts refuses to start with one, so
      // the running bot keeps its current gate instead of diverging from the file.
      if (ids.length === 0 && !this.#deps.cfg.telegram.allowAll) return
      const users = this.#deps.cfg.telegram.allowUsers
      users.clear()
      for (const id of ids) users.add(id)
      this.#deps.log.info(`access whitelist now ${users.size} user(s): ${[...users].join(",")}`)
    }
  }

}
