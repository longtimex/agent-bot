import { InlineKeyboard } from "grammy"
import type { AgentCliProfile, AgentCliService } from "./agentCli.js"
import type { AgentCliInstaller } from "./agentInstaller.js"
import { clip, escapeMarkdown, type Panel } from "./messages.js"
import { AVAILABLE_MODELS, reloadCustomModels } from "./models.js"
import type { ReminderService } from "./reminders.js"
import type { ScheduleService } from "./scheduler.js"
import type { SessionStore } from "./store.js"
import { formatDuration } from "./telegramSupport.js"
import type { UsageStore } from "./usage.js"

export interface CorePanelDeps {
  store: SessionStore
  agents: AgentCliService
  agentInstaller: AgentCliInstaller
  usage: UsageStore
  reminders: ReminderService
  schedules: ScheduleService
  runningSince: Map<string, number>
  pendingCount: (key: string) => number
  currentModel: (key: string) => { providerID: string; modelID: string; label: string }
  cliModelLabel: (engine: string, model: string | undefined) => string
}

export class TelegramCorePanels {
  readonly #deps: CorePanelDeps

  constructor(deps: CorePanelDeps) {
    this.#deps = deps
  }

  welcomeText(key: string, userId: number): string {
    const engine = this.#deps.store.getEngine(key)
    const model =
      engine === "opencode"
        ? this.#deps.currentModel(key).label
        : this.#deps.cliModelLabel(engine, this.#deps.store.getCliModel(key, engine))
    const detected = this.#deps.agents.registry
      .list()
      .filter((profile) => this.#deps.agents.registry.binPath(profile))
      .map((profile) => profile.label)
    const detectedText =
      detected.length > 0
        ? `${detected.slice(0, 6).map((label) => escapeMarkdown(label)).join("、")}${detected.length > 6 ? ` 等 ${detected.length} 个` : ""}`
        : "无（可使用 OpenCode，或发送 /agents 安装）"
    return (
      `👋 *欢迎使用 AI 私人助手*\n\n• 用户 ID：\`${userId}\`\n` +
      `• 引擎：*${escapeMarkdown(this.#deps.agents.registry.label(engine))}*\n• 模型：*${escapeMarkdown(model)}*\n` +
      `• 本机 Agent CLI：${detectedText}\n\n` +
      `💡 *推荐使用 OpenCode*：多模型、工具调用、附件收发与定时任务。\n` +
      `☰ 发送 \`/menu\` 打开功能菜单（含 Agent、模型、任务、cc-switch 与运维中心）。\n\n` +
      `*直接发消息即可对话：*\n• 代码编写、分析与调试\n• 发送图片、文件、语音（文本文件会读取内容）\n` +
      `• 发送 \`/remind 30m 喝水\` 设定提醒\n• 发送 \`/schedule add 30m 检查服务器\` 定时执行 AI 任务\n` +
      `• 发送 \`/report\` 看每日用量报告 · \`/export\` 导出任务历史\n\n` +
      `_仅响应私聊消息。发送 /help 查看帮助，或 /menu 打开功能菜单。_`
    )
  }

  menuPanel(chatId: number, key: string): Panel {
    const engine = this.#deps.store.getEngine(key)
    const model =
      engine === "opencode"
        ? this.#deps.currentModel(key).label
        : this.#deps.cliModelLabel(engine, this.#deps.store.getCliModel(key, engine))
    const since = this.#deps.runningSince.get(key)
    const pending = this.#deps.pendingCount(key)
    const running = since ? `运行中 ${formatDuration(Date.now() - since)}` : "空闲"
    const reminders = this.#deps.reminders.list(chatId).length
    const schedules = this.#deps.schedules.count(chatId)
    const today = this.#deps.usage.summary(key).today.tasks
    return {
      text:
        `🤖 *功能菜单*\n\n` +
        `• 引擎：*${escapeMarkdown(this.#deps.agents.registry.label(engine))}*\n` +
        `• 模型：*${escapeMarkdown(model)}*\n` +
        `• 状态：${running} · 今日 ${today} 条\n` +
        `• 提醒 ${reminders} · 定时 ${schedules} · 队列 ${pending}\n\n` +
        `直接发送消息即可对话，或点击下方按钮进入功能区。`,
      keyboard: this.menuKeyboard(),
    }
  }

  menuKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("🤖 Agent 引擎", "show:agent")
      .text("🧠 模型", "show:model")
      .row()
      .text("🗓 定时任务", "show:schedule")
      .text("⏰ 提醒", "show:reminders")
      .row()
      .text("📊 运行状态", "show:status")
      .text("📈 使用统计", "show:usage")
      .row()
      .text("📋 任务队列", "show:queue")
      .text("🕘 任务历史", "show:history")
      .row()
      .text("📦 Agent CLI", "show:agents")
      .text("🔌 cc-switch", "show:cc")
      .row()
      .text("🌐 网络代理", "show:proxy")
      .text("🛠 运维中心", "show:ops")
      .row()
      .text("🕐 时区", "tz:")
      .text("❓ 帮助", "show:help")
  }

  agentInstallerPanel(): Panel {
    const profiles = this.#deps.agents.registry.list()
    const installed = profiles.filter((profile) => this.#deps.agents.registry.binPath(profile))
    const installable = profiles.filter((profile) => profile.installSpec && !this.#deps.agents.registry.binPath(profile))
    const manual = profiles.filter((profile) => !profile.installSpec && !this.#deps.agents.registry.binPath(profile))
    const managed = this.#deps.agentInstaller.managed()

    const keyboard = new InlineKeyboard()
    installable.slice(0, 10).forEach((profile, index) => {
      keyboard.text(clip(`⬇️ ${profile.label}`, 60) ?? profile.label, `areq:install:${profile.id}`)
      if (index % 2 === 1) keyboard.row()
    })
    if (installable.slice(0, 10).length % 2 === 1) keyboard.row()
    managed.slice(0, 10).forEach((record) => {
      const label = this.#deps.agents.registry.get(record.engine)?.label ?? record.engine
      keyboard.text(clip(`🔄 ${label}`, 60) ?? label, `areq:update:${record.engine}`)
      keyboard.text(clip(`🗑 ${label}`, 60) ?? label, `areq:uninstall:${record.engine}`)
      keyboard.row()
    })
    keyboard.text("🤖 选择引擎", "show:agent").text("🔄 刷新", "show:agents")
    keyboard.row().text("⬅️ 主菜单", "show:menu")

    const commandLines = installable
      .slice(0, 6)
      .map((profile) => `• ${escapeMarkdown(profile.label)}：\`${this.#deps.agentInstaller.installCommand(profile) ?? ""}\``)
      .join("\n")
    const manualLabels = manual.slice(0, 8).map((profile) => escapeMarkdown(profile.label)).join("、")
    const installedLine =
      this.joinLabels(installed.map((profile) => escapeMarkdown(profile.label))) || "无"
    const managedLine =
      managed.length > 0
        ? `• 🔄 Bot 托管：${this.joinLabels(
            managed.map((record) => escapeMarkdown(this.#deps.agents.registry.get(record.engine)?.label ?? record.engine)),
          )}（可更新或卸载）\n`
        : ""
    return {
      text:
        `📦 *Agent CLI 管理*\n\n` +
        `💡 *推荐使用 OpenCode*：多模型、工具调用、附件收发与定时任务能力最完整。\n\n` +
        `🖥 *本机已检测到*：${installedLine}\n` +
        managedLine +
        (installable.length > 0
          ? `\n⬇️ *可自动安装（npm/pip）*：\n${commandLines}${installable.length > 6 ? `\n_另有 ${installable.length - 6} 个，见下方按钮。_` : ""}\n`
          : "\n✅ 所有内置 npm/pip CLI 均已安装。\n") +
        (manualLabels ? `\n🛠 *需手动安装*：${manualLabels}${manual.length > 8 ? " 等" : ""}\n` : "") +
        `\n_仅能卸载由 Bot 安装的 CLI；系统预装版本请手动管理。_`,
      keyboard,
    }
  }

  /** `/dir` view: where CLI engines start for this chat, with a one-tap reset. */
  dirPanel(key: string): Panel {
    const engine = this.#deps.store.getEngine(key)
    const custom = this.#deps.store.getDir(key)
    const effective = this.#deps.agents.workDir(key)
    return {
      text:
        `📁 *CLI 工作目录*\n\n` +
        `• 本会话：\`${escapeMarkdown(effective)}\`（${custom ? "已单独指定" : "Bot 默认"}）\n` +
        `• Bot 默认：\`${escapeMarkdown(this.#deps.agents.defaultWorkDir)}\`\n` +
        (custom && effective !== custom ? "• ⚠️ 指定目录当前不可用，已回退到默认目录\n" : "") +
        `• 当前引擎：*${escapeMarkdown(this.#deps.agents.registry.label(engine))}*\n` +
        (engine === "opencode" ? "\n_OpenCode 的目录由其服务端决定，该设置只对 CLI 引擎生效。_\n" : "") +
        "\n_发送 `/dir <路径>` 切换（支持 `~` 与相对路径），切换会重置该会话的 CLI 上下文。_",
      keyboard: new InlineKeyboard()
        .text("↩️ 恢复默认目录", "dir:reset")
        .text("🤖 切换引擎", "show:agent")
        .row()
        .text("⬅️ 主菜单", "show:menu"),
    }
  }

  /** Joins escaped labels for one line, folding the rest into a count so the panel stays under the message limit. */
  joinLabels(labels: string[], budget = 400): string {
    let text = ""
    let shown = 0
    for (const label of labels) {
      const next = text ? `${text}、${label}` : label
      if (next.length > budget) break
      text = next
      shown += 1
    }
    if (!text) return ""
    return shown < labels.length ? `${text} 等 ${labels.length} 个` : text
  }

  agentPanel(key: string): Panel {
    const current = this.#deps.store.getEngine(key)
    const profiles = this.#deps.agents.registry.list()
    const entries = [
      { id: "opencode", label: "OpenCode", desc: "多模型、工具调用、附件收发", installed: true, profile: undefined },
      ...profiles.map((profile: AgentCliProfile) => ({
        id: profile.id,
        label: profile.label,
        desc: profile.desc,
        installed: Boolean(this.#deps.agents.registry.binPath(profile)),
        profile,
      })),
    ].sort((a, b) => Number(b.installed) - Number(a.installed))

    const keyboard = new InlineKeyboard()
    entries.slice(0, 30).forEach((entry, index) => {
      const mark = entry.id === current ? "✅ " : entry.installed ? "" : "⚠️ "
      keyboard.text(clip(`${mark}${entry.label}`, 60) ?? "", `agent:${entry.id}`)
      if (index % 2 === 1) keyboard.row()
    })
    if (entries.slice(0, 30).length % 2 === 1) keyboard.row()
    keyboard.text("🧠 选择模型", "show:model").text("📦 安装 / 卸载", "show:agents")
    keyboard.row().text("📁 工作目录", "show:dir").text("🔄 刷新", "show:agent").text("⬅️ 主菜单", "show:menu")

    const installed = entries.filter((entry) => entry.installed).map((entry) => escapeMarkdown(entry.label))
    const installedLine = this.joinLabels(installed)
    const missing = entries.filter((entry) => !entry.installed).length
    const currentLabel = this.#deps.agents.registry.label(current)
    const managed = this.#deps.agentInstaller.managed().length
    return {
      text:
        `🤖 *Agent 引擎*\n\n当前：*${escapeMarkdown(currentLabel)}*\n\n` +
        `• 已检测到：${installedLine || "无"}\n` +
        (current === "opencode"
          ? ""
          : `• 📁 工作目录：\`${escapeMarkdown(this.#deps.agents.workDir(key))}\`（\`/dir\` 可修改）\n`) +
        (missing > 0 ? `• ⚠️ ${missing} 个引擎未安装，可点「安装 / 卸载」或发送 \`/agents\`。\n` : "") +
        (managed > 0 ? `• 📦 Bot 托管：${managed} 个（可在 \`/agents\` 中更新或卸载）\n` : "") +
        (entries.length > 30 ? `• 另有 ${entries.length - 30} 个引擎可用 \`/agent <id>\` 切换。\n` : "") +
        `\n💡 *推荐使用 OpenCode*：多模型、工具调用、附件收发与定时任务。\n` +
        `\n点击下方按钮切换，或发送 \`/agent <id>\`。`,
      keyboard,
    }
  }

  modelPanel(key: string): Panel {
    const engine = this.#deps.store.getEngine(key)
    if (engine !== "opencode") {
      const profile = this.#deps.agents.registry.get(engine)
      if (!profile) {
        return {
          text: `🧠 *模型*\n\n未知引擎：\`${escapeMarkdown(engine)}\``,
          keyboard: new InlineKeyboard().text("🤖 切换引擎", "show:agent").text("⬅️ 主菜单", "show:menu"),
        }
      }

      const current = this.#deps.store.getCliModel(key, engine) ?? profile.defaultModel
      const keyboard = new InlineKeyboard()
      if (profile.supportsModel && profile.models?.length) {
        profile.models.slice(0, 30).forEach((model, index) => {
          const mark = current === model.id ? "✅ " : ""
          // A profile list can be reloaded between rendering this panel and the tap, and then
          // an index points at whichever model sits there now. The id survives that, up to the
          // 64 byte limit Telegram puts on callback data.
          const byId = `cmodel:${engine}:${model.id}`
          keyboard.text(
            clip(`${mark}${model.label}`, 60) ?? "",
            Buffer.byteLength(byId, "utf8") <= 64 ? byId : `cmodel:${engine}:${index}`,
          )
          if (index % 2 === 1) keyboard.row()
        })
        if (profile.models.slice(0, 30).length % 2 === 1) keyboard.row()
      }
      if (this.#deps.store.getCliModel(key, engine)) {
        keyboard.text("↩️ 恢复默认模型", `cmodelreset:${engine}`).row()
      }
      keyboard.text("🤖 切换引擎", "show:agent").text("🔄 刷新", "show:model")
      keyboard.row().text("⬅️ 主菜单", "show:menu")

      const modelLine = profile.supportsModel
        ? this.#deps.cliModelLabel(engine, current)
        : "由 CLI 自身配置"
      const hint = profile.supportsModel
        ? profile.models?.length
          ? `\n\n也可发送 \`/model <模型ID>\` 直接指定${profile.modelHint ? `（如 \`${profile.modelHint}\`）` : ""}。`
          : `\n\n该引擎支持任意模型 ID，发送 \`/model <模型ID>\` 切换。${profile.modelHint ? `\n示例：\`${profile.modelHint}\`` : ""}`
        : "\n\n该引擎不支持通过 Bot 切换模型，请在 CLI 配置中设置。"
      return {
        text:
          `🧠 *${escapeMarkdown(profile.label)} 模型*\n\n当前：*${escapeMarkdown(modelLine)}*\n` +
          `\n切换后会重置当前引擎的会话上下文。${hint}`,
        keyboard,
      }
    }

    reloadCustomModels()
    const current = this.#deps.currentModel(key)
    const currentInfo = Object.values(AVAILABLE_MODELS).find(
      (item) => item.providerID === current.providerID && item.modelID === current.modelID,
    )
    const keyboard = new InlineKeyboard()
    const entries = Object.entries(AVAILABLE_MODELS)
    const limit = 40
    let models = entries.slice(0, limit)
    if (entries.length > limit) {
      const currentIndex = entries.findIndex(
        ([, info]) => info.providerID === current.providerID && info.modelID === current.modelID,
      )
      if (currentIndex >= limit) models = [...entries.slice(0, limit - 1), entries[currentIndex]!]
    }
    models.forEach(([modelKey, info], index) => {
      const isCurrent = info.providerID === current.providerID && info.modelID === current.modelID
      keyboard.text(clip(`${isCurrent ? "✅ " : ""}${info.label}`, 60) ?? "", `model:${modelKey}`)
      if (index % 2 === 1) keyboard.row()
    })
    if (models.length % 2 === 1) keyboard.row()
    if (this.#deps.store.getModel(key)) {
      keyboard.text("↩️ 恢复默认模型", "model:reset").row()
    }
    keyboard.text("🔌 模型管理", "cc:model").text("🤖 切换引擎", "show:agent")
    keyboard.row().text("🔄 刷新", "show:model").text("⬅️ 主菜单", "show:menu")
    const hidden =
      entries.length > models.length ? `\n_另有 ${entries.length - models.length} 个模型未显示，可用 \`/model 简称\` 直接切换。_` : ""
    const text =
      `🧠 *OpenCode 模型*\n\n当前：*${escapeMarkdown(current.label)}*` +
      `${currentInfo ? `\n_${escapeMarkdown(currentInfo.desc)}_` : ""}\n\n` +
      `点击下方按钮切换，或发送 \`/model 简称\`（\`/model default\` 恢复默认）。\n切换后会重置当前会话上下文。${hidden}`
    return { text, keyboard }
  }


}
