import { randomBytes } from "node:crypto"
import { InlineKeyboard } from "grammy"
import type { AgentCliService } from "./agentCli.js"
import type { AgentCliInstaller } from "./agentInstaller.js"
import type { Logger } from "./logger.js"
import { escapeMarkdown, type Panel } from "./messages.js"
import type { SessionStore } from "./store.js"
import type { Job } from "./telegram.js"

export const AGENT_CONFIRM_TTL_MS = 5 * 60_000

export type AgentAction = "install" | "update" | "uninstall"

export const AGENT_ACTION_VERB: Record<AgentAction, string> = {
  install: "安装",
  update: "更新",
  uninstall: "卸载",
}

interface AgentPending {
  chatId: number
  action: AgentAction
  engine: string
  createdAt: number
}

export interface AgentCommandDeps {
  agents: AgentCliService
  installer: AgentCliInstaller
  store: SessionStore
  log: Logger
  sendText: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>
  sendPanel: (chatId: number, panel: Panel) => Promise<void>
  agentPanel: (key: string) => Panel
  agentInstallerPanel: () => Panel
}

export class TelegramAgentCommands {
  readonly #deps: AgentCommandDeps
  readonly #agentPending = new Map<string, AgentPending>()

  constructor(deps: AgentCommandDeps) {
    this.#deps = deps
  }

  clearPending(): void {
    this.#agentPending.clear()
  }

  getPending(token: string): AgentPending | undefined {
    return this.#agentPending.get(token)
  }

  deletePending(token: string): boolean {
    return this.#agentPending.delete(token)
  }

  async handleCommand(job: Job, target?: string): Promise<void> {
    if (!target) {
      await this.#deps.sendPanel(job.chatId, this.#deps.agentPanel(job.key))
      return
    }

    const [sub = "", rawId = ""] = target.split(/\s+/).filter(Boolean)
    const normalized = sub.toLowerCase()
    if (["install", "add", "uninstall", "remove", "del", "delete"].includes(normalized)) {
      await this.handleInstallCommand(job, normalized, rawId)
      return
    }

    const chosen = this.#deps.agents.registry.resolveEngine(target)
    if (!chosen) {
      const ids = ["opencode", ...this.#deps.agents.registry.list().map((profile) => profile.id)]
      await this.#deps.sendText(
        job.chatId,
        `❌ 未识别的 Agent 引擎：\`${target}\`\n\n可选：${ids.map((id) => `\`${id}\``).join("、")}`,
      )
      return
    }

    this.#deps.store.setEngine(job.key, chosen)
    this.#deps.log.info(`agent switched [${job.key}] -> ${chosen}`)

    if (chosen === "opencode") {
      await this.#deps.sendText(
        job.chatId,
        `✅ *已切换至 OpenCode Agent 引擎！*\n\n当前由 OpenCode 提供服务，支持多模型、工具调用与多媒体交互。\n发送 \`/model\` 可切换底层模型。`,
      )
      return
    }

    const profile = this.#deps.agents.registry.get(chosen)!
    const binPath = this.#deps.agents.registry.binPath(profile)
    const modelLine = profile.supportsModel
      ? profile.modelHint
        ? `\n• 可用模型提示：\`${profile.modelHint}\`（也可发送 \`/model <模型ID>\`）`
        : `\n• 模型：发送 \`/model <模型ID>\` 指定`
      : "\n• 模型：由 CLI 自身配置"
    const installLine = binPath
      ? `\n• 可执行文件：\`${binPath}\``
      : `\n• ⚠️ 未检测到 \`${profile.bin}\`${profile.install ? `\n• 安装：${profile.install}` : ""}`
    await this.#deps.sendText(
      job.chatId,
      `✅ *已切换至 ${escapeMarkdown(profile.label)}！*\n\n${escapeMarkdown(profile.desc)}${modelLine}${installLine}`,
    )
  }

  async handleAgentsCommand(job: Job, arg: string): Promise<void> {
    const [action = "", rawId = ""] = arg.split(/\s+/).filter(Boolean)
    if (!action) {
      await this.#deps.sendPanel(job.chatId, this.#deps.agentInstallerPanel())
      return
    }
    const normalized = action.toLowerCase()
    if (["install", "add", "uninstall", "remove", "del", "delete", "update", "upgrade"].includes(normalized)) {
      await this.handleInstallCommand(job, normalized, rawId)
      return
    }
    await this.#deps.sendText(
      job.chatId,
      "用法：`/agents` 查看检测与安装面板；`/agents install <id>` 安装；`/agents update <id>` 更新 Bot 托管的 CLI；`/agents uninstall <id>` 卸载。",
    )
  }

  async handleInstallCommand(job: Job, action: string, rawId: string): Promise<void> {
    const uninstall = ["uninstall", "remove", "del", "delete"].includes(action)
    const update = ["update", "upgrade"].includes(action)
    if (!rawId) {
      await this.#deps.sendPanel(job.chatId, this.#deps.agentInstallerPanel())
      return
    }
    const engine = this.#deps.agents.registry.resolveEngine(rawId)
    const profile = engine && engine !== "opencode" ? this.#deps.agents.registry.get(engine) : undefined
    if (!engine || !profile) {
      await this.#deps.sendText(job.chatId, `❌ 未识别的 Agent CLI：\`${rawId}\`\n发送 \`/agents\` 查看可管理列表。`)
      return
    }

    if (uninstall) {
      if (!this.#deps.installer.uninstallCommand(engine)) {
        await this.#deps.sendText(
          job.chatId,
          `ℹ️ ${escapeMarkdown(profile.label)} 不是由 Bot 安装的，无法自动卸载。\n只能卸载通过 \`/agents install\` 安装的 CLI；系统预装版本请手动管理。`,
        )
        return
      }
      if (this.#deps.store.getEngine(job.key) === engine) {
        await this.#deps.sendText(
          job.chatId,
          `⚠️ 当前正在使用 ${escapeMarkdown(profile.label)}，请先发送 \`/agent opencode\` 切换后再卸载。`,
        )
        return
      }
      await this.requestAction(job.chatId, job.key, "uninstall", engine)
      return
    }

    if (update) {
      if (!this.#deps.installer.updateCommand(engine)) {
        await this.#deps.sendText(
          job.chatId,
          `ℹ️ ${escapeMarkdown(profile.label)} 不是由 Bot 安装的，无法自动更新。\n只能更新通过 \`/agents install\` 安装的 CLI；其他方式安装的版本请手动升级。`,
        )
        return
      }
      await this.requestAction(job.chatId, job.key, "update", engine)
      return
    }

    const installed = this.#deps.agents.registry.binPath(profile)
    if (installed) {
      const managed = this.#deps.installer.isManaged(engine)
      await this.#deps.sendText(
        job.chatId,
        `✅ 已检测到 ${escapeMarkdown(profile.label)}：\`${installed}\`\n` +
          (managed
            ? "该版本由 Bot 托管，可用 `/agents update " + engine + "` 更新、`/agents uninstall " + engine + "` 卸载。"
            : "该版本不是由 Bot 安装的，Bot 不会自动更新或卸载它。"),
      )
      return
    }

    if (!this.#deps.installer.installCommand(profile)) {
      const hint = profile.install ? `\n安装方式：${escapeMarkdown(profile.install)}` : ""
      await this.#deps.sendText(
        job.chatId,
        `ℹ️ ${escapeMarkdown(profile.label)} 暂不支持在聊天内自动安装。${hint}`,
      )
      return
    }

    await this.requestAction(job.chatId, job.key, "install", engine)
  }

  actionBlocked(key: string, action: AgentAction, engine: string): string | undefined {
    const profile = this.#deps.agents.registry.get(engine)
    if (!profile || engine === "opencode") return "未识别的 Agent CLI"
    if (action === "install") {
      if (this.#deps.agents.registry.binPath(profile)) return `${profile.label} 已安装，无需重复安装`
      if (!this.#deps.installer.installCommand(profile)) return `${profile.label} 暂不支持在聊天内自动安装`
      return undefined
    }
    if (!this.#deps.installer.isManaged(engine)) {
      return `${profile.label} 不是由 Bot 安装的，无法自动${AGENT_ACTION_VERB[action]}`
    }
    if (action === "uninstall" && this.#deps.store.getEngine(key) === engine) return "请先切换到 OpenCode 再卸载"
    return undefined
  }

  async requestAction(chatId: number, key: string, action: AgentAction, engine: string): Promise<void> {
    const profile = this.#deps.agents.registry.get(engine)
    if (!profile) {
      await this.#deps.sendText(chatId, `❌ 未识别的 Agent CLI：\`${escapeMarkdown(engine)}\``)
      return
    }
    const command =
      action === "install"
        ? this.#deps.installer.installCommand(profile)
        : action === "update"
          ? this.#deps.installer.updateCommand(engine)
          : this.#deps.installer.uninstallCommand(engine)
    if (!command) {
      const hint = action === "install" && profile.install ? `\n安装方式：${escapeMarkdown(profile.install)}` : ""
      await this.#deps.sendText(
        chatId,
        `ℹ️ ${escapeMarkdown(profile.label)} 无法在聊天内自动${AGENT_ACTION_VERB[action]}。${hint}`,
      )
      return
    }
    const verb = AGENT_ACTION_VERB[action]
    const icon = action === "install" ? "⬇️" : action === "update" ? "🔄" : "🗑"
    const note =
      action === "install"
        ? `仅支持内置的 npm/pip 安装方式；安装完成后可用 \`/agent ${engine}\` 切换。`
        : action === "update"
          ? "会覆盖 Bot 托管的版本；更新期间该 CLI 的正在运行任务可能受影响。"
          : "只会移除由 Bot 安装的版本。"
    const now = Date.now()
    for (const [token, pending] of this.#agentPending) {
      if (now - pending.createdAt > AGENT_CONFIRM_TTL_MS) this.#agentPending.delete(token)
    }
    const token = randomBytes(6).toString("hex")
    this.#agentPending.set(token, { chatId, action, engine, createdAt: now })
    await this.#deps.sendText(
      chatId,
      `${icon} *确认${verb} ${escapeMarkdown(profile.label)}？*\n\n将执行：\`${command}\`\n\n${note}\n\n` +
        "_5 分钟内有效，点击确认后执行。_",
      new InlineKeyboard().text(`✅ 确认${verb}`, `a:cfm:${token}`).text("取消", `a:cnl:${token}`),
    )
  }

  async runAction(
    chatId: number,
    key: string,
    action: AgentAction,
    engine: string,
  ): Promise<void> {
    const profile = this.#deps.agents.registry.get(engine)
    const label = profile?.label ?? engine
    const verb = AGENT_ACTION_VERB[action]
    await this.#deps.sendText(chatId, `⏳ 正在${verb} ${escapeMarkdown(label)}…（最长 10 分钟，期间可继续使用其他命令）`)
    const result =
      action === "install"
        ? await this.#deps.installer.install(engine)
        : action === "uninstall"
          ? await this.#deps.installer.uninstall(engine)
          : await this.#deps.installer.update(engine)
    this.#deps.log.info(`agent ${action} [${key}] ${engine}: ${result.ok ? "ok" : "failed"}`)

    let text = result.ok ? `✅ ${escapeMarkdown(result.message)}` : `❌ ${escapeMarkdown(result.message)}`
    if (result.output) text += `\n\n${escapeMarkdown(result.output.replace(/```/g, "'''"))}`
    await this.#deps.sendText(chatId, text)
    await this.#deps.sendPanel(chatId, this.#deps.agentInstallerPanel())
  }

}
