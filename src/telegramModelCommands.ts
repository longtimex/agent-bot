import { statSync } from "node:fs"
import { homedir } from "node:os"
import { InlineKeyboard } from "grammy"
import { normalizeWorkDirInput, type AgentCliService } from "./agentCli.js"
import type { BotConfig } from "./config.js"
import { resolveOpencodeModel } from "./engineCall.js"
import type { Logger } from "./logger.js"
import { escapeMarkdown, type Panel } from "./messages.js"
import { AVAILABLE_MODELS, MODEL_DEFAULT_WORDS, resolveModelKey, type ModelInfo } from "./models.js"
import type { Opencode } from "./opencode.js"
import type { SessionStore } from "./store.js"
import type { Job } from "./telegram.js"

export interface ModelCommandDeps {
  store: SessionStore
  agents: AgentCliService
  oc: Opencode
  cfg: BotConfig
  log: Logger
  runningSince: Map<string, number>
  sendText: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>
  sendPanel: (chatId: number, panel: Panel) => Promise<void>
  dirPanel: (key: string) => Panel
  modelPanel: (key: string) => Panel
}

export class TelegramModelCommands {
  readonly #deps: ModelCommandDeps

  constructor(deps: ModelCommandDeps) {
    this.#deps = deps
  }

  async handleDirCommand(job: Job, arg?: string): Promise<void> {
    const key = job.key
    const engine = this.#deps.store.getEngine(key)
    const cliNote =
      engine === "opencode" ? "\n_当前引擎是 OpenCode，目录由其服务端决定；该设置只对 CLI 引擎生效。_" : ""

    if (arg === undefined) {
      const panel = this.#deps.dirPanel(key)
      await this.#deps.sendText(job.chatId, panel.text, panel.keyboard)
      return
    }

    if (/^(reset|default|clear|默认|恢复默认)$/i.test(arg.trim())) {
      if (!this.#deps.store.clearDir(key)) {
        await this.#deps.sendText(job.chatId, "ℹ️ 本会话没有单独指定工作目录，当前就是 Bot 默认目录。")
        return
      }
      this.resetCliSessions(key)
      await this.#deps.sendText(
        job.chatId,
        `↩️ 已恢复默认工作目录 \`${escapeMarkdown(this.#deps.agents.defaultWorkDir)}\`（已重置 CLI 会话上下文）。`,
      )
      return
    }

    // Switching the directory under a running task would split one session across two projects
    if (this.#deps.runningSince.has(key)) {
      await this.#deps.sendText(job.chatId, "⚠️ 任务执行中，请先发送 `/stop`。")
      return
    }

    const dir = normalizeWorkDirInput(arg, this.#deps.agents.defaultWorkDir, homedir())
    if (!dir) {
      await this.#deps.sendText(
        job.chatId,
        "❌ 路径无效：不能为空、含控制字符、超过 512 字符，或指向文件系统根目录。",
      )
      return
    }
    let isDirectory: boolean
    try {
      isDirectory = statSync(dir).isDirectory()
    } catch {
      await this.#deps.sendText(job.chatId, `❌ 目录不存在：\`${escapeMarkdown(dir)}\``)
      return
    }
    if (!isDirectory) {
      await this.#deps.sendText(job.chatId, `❌ 不是目录：\`${escapeMarkdown(dir)}\``)
      return
    }

    this.#deps.store.setDir(key, dir)
    this.resetCliSessions(key)
    await this.#deps.sendText(
      job.chatId,
      `📁 本会话的 CLI 工作目录已设为 \`${escapeMarkdown(dir)}\`（已重置 CLI 会话上下文）。${cliNote}`,
    )
  }

  /** A CLI session belongs to the directory it was created in, so both reset together. */
  resetCliSessions(key: string): void {
    for (const profile of this.#deps.agents.registry.list()) this.#deps.store.clearCliSession(key, profile.id)
  }

  async handleModelCommand(job: Job, arg?: string): Promise<void> {
    const engine = this.#deps.store.getEngine(job.key)

    if (engine !== "opencode") {
      if (!arg) {
        await this.#deps.sendPanel(job.chatId, this.#deps.modelPanel(job.key))
        return
      }

      const profile = this.#deps.agents.registry.get(engine)
      if (!profile) {
        await this.#deps.sendText(job.chatId, `❌ 未知引擎：\`${engine}\``)
        return
      }
      if (!profile.supportsModel) {
        await this.#deps.sendText(job.chatId, `ℹ️ ${escapeMarkdown(profile.label)} 的模型由 CLI 自身配置，Bot 不支持切换。`)
        return
      }

      const word = arg.trim().toLowerCase()
      // Only a model the profile actually declares may shadow the reset keyword: engines
      // without `strictModels` pass any string through
      const declared = this.#deps.agents.registry.declaresModel(engine, arg)
      const selectedModel = this.#deps.agents.registry.resolveModel(engine, arg)
      if (!declared && MODEL_DEFAULT_WORDS.has(word)) {
        if (!this.clearCliModelSelection(job.key, engine)) {
          await this.#deps.sendText(
            job.chatId,
            `ℹ️ 本会话没有独立的模型选择，当前就是 *${escapeMarkdown(profile.label)}* 的默认模型。`,
          )
          return
        }
        await this.#deps.sendText(
          job.chatId,
          `↩️ 已取消本会话的模型选择，恢复 *${escapeMarkdown(profile.label)}* 默认模型（已重置会话上下文）。`,
        )
        return
      }

      if (!selectedModel) {
        const hint = profile.models?.map((model) => `\`${model.id}\``).join("、") ?? profile.modelHint
        await this.#deps.sendText(
          job.chatId,
          `❌ 未识别的模型：\`${arg}\`${hint ? `\n\n可用：${hint}` : ""}`,
        )
        return
      }

      const current = this.#deps.store.getCliModel(job.key, engine) ?? profile.defaultModel
      if (current === selectedModel) {
        await this.#deps.sendText(
          job.chatId,
          `✅ 当前已经是 *${escapeMarkdown(this.#deps.agents.registry.modelLabel(engine, selectedModel))}*，无需切换，会话上下文保持不变。`,
        )
        return
      }

      this.applyCliModel(job.key, engine, selectedModel)
      await this.#deps.sendText(
        job.chatId,
        `✅ *${escapeMarkdown(profile.label)} 模型已切换为：${escapeMarkdown(this.#deps.agents.registry.modelLabel(engine, selectedModel))}* (已开启新会话上下文)`,
      )
      return
    }

    // Handle OpenCode models
    if (!arg) {
      await this.#deps.sendPanel(job.chatId, this.#deps.modelPanel(job.key))
      return
    }

    const targetKey = resolveModelKey(arg)
    const targetModel = targetKey ? AVAILABLE_MODELS[targetKey] : undefined

    // Same rule as the CLI branch: a model really named `auto` stays reachable
    if (!targetModel && MODEL_DEFAULT_WORDS.has(arg.trim().toLowerCase())) {
      await this.resetOpenCodeModel(job.chatId, job.key)
      return
    }

    if (!targetModel) {
      const valid = Object.keys(AVAILABLE_MODELS).join(", ")
      await this.#deps.sendText(
        job.chatId,
        `❌ 未识别的模型名称：\`${arg}\`\n\n可选简称有：\`${valid}\`\n发送 \`/model\` 可查看详细列表。`,
      )
      return
    }

    const current = this.getCurrentModel(job.key)
    if (current.providerID === targetModel.providerID && current.modelID === targetModel.modelID) {
      await this.#deps.sendText(
        job.chatId,
        `✅ 当前已经是 *${escapeMarkdown(targetModel.label)}*，无需切换，会话上下文保持不变。`,
      )
      return
    }

    await this.applyOpenCodeModel(job.key, targetModel)
    await this.#deps.sendText(
      job.chatId,
      `✅ *已成功切换模型！*\n\n当前模型：*${escapeMarkdown(targetModel.label)}*\n_${escapeMarkdown(targetModel.desc)}_\n\n已自动重置会话上下文，你可以直接开始向新模型提问了。`,
    )
  }

  async applyOpenCodeModel(key: string, target: ModelInfo): Promise<void> {
    this.#deps.store.setModel(key, {
      providerID: target.providerID,
      modelID: target.modelID,
      label: target.label,
    })
    this.#deps.log.info(`model switched [${key}] -> ${target.label} (${target.providerID}/${target.modelID})`)
    await this.dropSessionForModel(key)
  }

  /** A model change must not carry the previous model's context over. */
  async dropSessionForModel(key: string): Promise<void> {
    const oldSession = this.#deps.store.get(key)
    if (!oldSession) return
    await this.#deps.oc.deleteSession(oldSession).catch(() => {})
    this.#deps.store.clearSession(key)
  }

  /** Drops the chat's own OpenCode selection and resets its context; false if there was nothing to drop. */
  async clearOpenCodeModelSelection(key: string): Promise<boolean> {
    const saved = this.#deps.store.getModel(key)
    if (!saved) return false
    this.#deps.store.clearModel(key)
    await this.dropSessionForModel(key)
    this.#deps.log.info(`model selection cleared [${key}] (was ${saved.providerID}/${saved.modelID})`)
    return true
  }

  async resetOpenCodeModel(chatId: number, key: string): Promise<void> {
    if (!(await this.clearOpenCodeModelSelection(key))) {
      await this.#deps.sendText(
        chatId,
        `ℹ️ 本会话没有独立的模型选择，当前就是默认模型 *${escapeMarkdown(this.getCurrentModel(key).label)}*。`,
      )
      return
    }
    await this.#deps.sendText(
      chatId,
      `↩️ 已取消本会话的模型选择，恢复默认模型：*${escapeMarkdown(this.getCurrentModel(key).label)}*\n（已重置会话上下文，可直接继续提问）`,
    )
  }

  applyCliModel(key: string, engine: string, model: string): void {
    this.#deps.store.setCliModel(key, engine, model)
    this.#deps.store.clearCliSession(key, engine)
    this.#deps.log.info(`${engine} model switched [${key}] -> ${model}`)
  }

  /** Drops the chat's own CLI model selection and resets its context; false if there was none. */
  clearCliModelSelection(key: string, engine: string): boolean {
    const saved = this.#deps.store.getCliModel(key, engine)
    if (!saved) return false
    this.#deps.store.setCliModel(key, engine, "")
    this.#deps.store.clearCliSession(key, engine)
    this.#deps.log.info(`${engine} model selection cleared [${key}] (was ${saved})`)
    return true
  }

  cliModelLabel(engine: string, model: string | undefined): string {
    if (model) return this.#deps.agents.registry.modelLabel(engine, model)
    const profile = this.#deps.agents.registry.get(engine)
    if (!profile) return "CLI 默认"
    return profile.supportsModel ? "CLI 默认" : "CLI 固定"
  }

  getCurrentModel(key: string): { providerID: string; modelID: string; label: string } {
    return resolveOpencodeModel(this.#deps.store, this.#deps.cfg.opencode.model, key)
  }

}
