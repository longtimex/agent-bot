import { randomBytes } from "node:crypto"
import type { Context } from "grammy"
import { InlineKeyboard } from "grammy"
import { escapeMarkdown, clip, pruneChatState, type Panel } from "./messages.js"
import { AVAILABLE_MODELS, reloadCustomModels } from "./models.js"
import { CC_HELP } from "./help.js"
import { CcSwitchService, CC_LONG_TIMEOUT_MS, redactSecrets, stripAnsi, type CcSwitchProvider, type CcSwitchProviderDraft, type CcSwitchSpeedtest } from "./ccswitch.js"
import type { ModelAdmin } from "./modelAdmin.js"
import type { Logger } from "./logger.js"
import type { SessionStore } from "./store.js"
import type { BotConfig } from "./config.js"

interface PendingCcAction {
  /** Confirmation tokens are only valid in the chat that requested them. */
  chatId: number
  args: string[]
  label: string
  bare?: boolean
  pty?: boolean
  appendArgs?: string[]
  timeoutMs?: number
  kind?: "provider-use" | "model-delete"
  providerId?: string
  modelKey?: string
  modelForce?: boolean
  createdAt: number
}

const CC_GROUPS = new Set([
  "provider",
  "mcp",
  "prompts",
  "prompt",
  "skills",
  "config",
  "proxy",
  "failover",
  "sessions",
  "auth",
  "daemon",
  "env",
  "settings",
  "deeplink",
  "update",
  "hermes",
])

const CC_DEFAULTS: Record<string, string[]> = {
  provider: ["provider", "list"],
  mcp: ["mcp", "list"],
  prompts: ["prompts", "list"],
  skills: ["skills", "list"],
  config: ["config", "path"],
  proxy: ["proxy", "show"],
  failover: ["failover", "show"],
  sessions: ["sessions", "list"],
  auth: ["auth", "status"],
  daemon: ["daemon", "status"],
  env: ["env", "tools"],
  settings: ["settings", "show"],
  hermes: ["hermes", "help"],
}

function tokenizeCcArgs(text: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of text.matchAll(re)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "")
  }
  return tokens.filter((token) => token.length > 0)
}

const PROVIDER_ADD_USAGE =
  "用法：`/cc provider add <名称> [id=…] [template=…] [base=https://…] [key=…] [model=…] [fmt=…] [config={…}]`\n" +
  "含空格的值请用引号包住；`config=` 传 settings JSON。也可直接写 cc-switch 原生参数（`--name` 等）。"

export function parseProviderAdd(tokens: string[]): CcSwitchProviderDraft | string {
  const [name, ...pairs] = tokens
  if (!name) return PROVIDER_ADD_USAGE
  const draft: CcSwitchProviderDraft = { name }
  for (const token of pairs) {
    const eq = token.indexOf("=")
    const key = eq > 0 ? token.slice(0, eq).toLowerCase() : ""
    const value = eq > 0 ? token.slice(eq + 1) : ""
    if (!key || !value) return `无法解析参数 \`${token}\`，请按 \`键=值\` 书写（值不能为空）。`
    switch (key) {
      case "id":
        draft.id = value
        break
      case "template":
      case "tpl":
        draft.template = value
        break
      case "base":
      case "base-url":
      case "url":
        draft.baseUrl = value
        break
      case "key":
      case "api-key":
        draft.apiKey = value
        break
      case "model":
        draft.model = value
        break
      case "fmt":
      case "format":
      case "api-format":
        draft.apiFormat = value
        break
      case "config":
        draft.config = value
        break
      default:
        return `未知参数 \`${key}\`，可用：id、template、base、key、model、fmt、config。`
    }
  }
  return draft
}

const CC_UPDATE_TIMEOUT_MS = 180_000

const CC_SUB_ALIASES: Record<string, [string, string]> = {
  "provider del": ["provider", "delete"],
  "provider rm": ["provider", "delete"],
  "mcp del": ["mcp", "delete"],
  "mcp rm": ["mcp", "delete"],
  "prompts use": ["prompts", "activate"],
  "prompts off": ["prompts", "deactivate"],
  "prompts stop": ["prompts", "deactivate"],
  "prompts del": ["prompts", "delete"],
  "prompts rm": ["prompts", "delete"],
  "skills del": ["skills", "uninstall"],
  "skills repo": ["skills", "repos"],
  "sessions del": ["sessions", "delete"],
  "auth del": ["auth", "remove"],
}

const CC_CONFIRM_TTL_MS = 5 * 60_000

/**
 * Everything the cc command family needs from the Telegram bridge: message
 * delivery and the two model/session helpers only the bridge can provide.
 */
export interface CcHost {
  sendTextMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean>
  sendPanel(chatId: number, panel: Panel): Promise<void>
  editPanel(ctx: Context, panel: Panel): Promise<void>
  applyOpenCodeModel(key: string, target: { providerID: string; modelID: string; label: string }): Promise<void>
  store: SessionStore
  cfg: BotConfig
}

/**
 * The /cc command family, extracted from TelegramBridge: provider switching and
 * speed tests, MCP/prompt/env output, cc-switch model management and the generic
 * confirmed /cc run dispatcher. Owns its per-chat provider cache, speed-test
 * set and confirmation tokens.
 */
export class CcCommands {
  readonly #host: CcHost
  readonly #cc: CcSwitchService
  readonly #models: ModelAdmin
  readonly #log: Logger
  readonly #ccProviders = new Map<number, string[]>()
  readonly #ccTesting = new Set<string>()
  readonly #ccPending = new Map<string, PendingCcAction>()

  constructor(host: CcHost, cc: CcSwitchService, models: ModelAdmin, log: Logger) {
    this.#host = host
    this.#cc = cc
    this.#models = models
    this.#log = log
  }

  clearPending(): void {
    this.#ccPending.clear()
  }

  clearProviders(): void {
    this.#ccProviders.clear()
  }

  pruneProviders(isActive: (chatId: number) => boolean, limit: number): number {
    return pruneChatState(this.#ccProviders, isActive, limit)
  }

  async panel(chatId: number, notice?: string): Promise<Panel> {
    const keyboard = new InlineKeyboard()
    const header = notice ? `${notice}\n\n` : ""

    if (!this.#cc.available) {
      keyboard.text("🧠 模型管理", "cc:model").row().text("🔄 刷新", "cc:refresh").text("⬅️ 主菜单", "show:menu")
      return {
        text:
          `${header}🔌 *cc-switch 集成*\n\n` +
          `未检测到 \`cc-switch\` 可执行文件。\n\n` +
          `• 安装：\`npm run cc-switch:install\`\n` +
          `• 或设置 \`CC_SWITCH_BIN\` 指向已有二进制\n` +
          `• 自动查找：\`./bin/cc-switch\` → \`PATH\` → 用户级全局 bin 目录（如 \`~/.npm-global/bin\`、\`~/.local/bin\`）\n\n` +
          `模型管理（\`/cc model\`）不依赖 cc-switch，可直接使用。`,
        keyboard,
      }
    }

    let providers: CcSwitchProvider[] = []
    let error: string | undefined
    try {
      providers = await this.#cc.listProviders()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    this.#ccProviders.set(chatId, providers.map((provider) => provider.id))

    const version = await this.#cc.version()
    const lines = [
      `${header}🔌 *cc-switch 集成*`,
      `应用：\`${this.#cc.app}\`${version ? ` · ${escapeMarkdown(version)}` : ""}`,
    ]

    if (error) {
      lines.push(`\n⚠️ 读取 Provider 失败：${escapeMarkdown(clip(error, 300) ?? "")}`)
    } else if (providers.length === 0) {
      lines.push("\n暂无 Provider。可在 cc-switch TUI 或 \`cc-switch provider add\` 中添加。")
    } else {
      const current = providers.find((provider) => provider.current)
      lines.push(`当前：*${escapeMarkdown(current?.name || current?.id || "未设置")}*`)
      lines.push(`\n*Providers（${providers.length}）*`)
      const shown = providers.slice(0, 20)
      shown.forEach((provider, index) => {
        const mark = provider.current ? "✅" : "•"
        lines.push(`${mark} \`${escapeMarkdown(provider.id)}\` ${escapeMarkdown(provider.name)}`)
        keyboard
          .text(clip(`${mark} ${provider.name || provider.id}`, 28) ?? mark, `cc:use:${index}`)
          .text("⚡", `cc:test:${index}`)
          .row()
      })
      if (providers.length > shown.length) {
        lines.push(`_另有 ${providers.length - shown.length} 个未显示，可用 \`/cc use <id>\` 切换。_`)
      }
    }

    keyboard
      .text("🔄 刷新", "cc:refresh")
      .text("⚡ 测速当前", "cc:testcur")
      .row()
      .text("📡 MCP 列表", "cc:mcp")
      .text("📡 MCP 同步", "cc:msync")
      .row()
      .text("📝 提示词", "cc:prompts")
      .text("🧪 环境", "cc:env")
      .row()
      .text("🌐 代理", "cc:proxy")
      .text("⚙️ 配置", "cc:config")
      .row()
      .text("👥 会话", "cc:sessions")
      .text("🔑 认证", "cc:auth")
      .row()
      .text("🛠 技能", "cc:skills")
      .text("🔁 故障转移", "cc:failover")
      .row()
      .text("🧠 模型管理", "cc:model")
      .text("📋 全部命令", "cc:cchelp")
      .row()
      .text("⬅️ 主菜单", "show:menu")

    lines.push(
      "\n*更多*：`/cc help` 查看全部命令；`/cc run <参数>` 可执行任意非交互命令；切换 Provider、删除/导入等操作会先请求确认。",
    )
    return { text: lines.join("\n"), keyboard }
  }

  #ccModelPanel(): Panel {
    reloadCustomModels()
    const custom = this.#models.listCustomModels()
    const keys = Object.keys(custom).sort()
    const total = Object.keys(AVAILABLE_MODELS).length
    const agents = this.#models.listAgents()

    const lines = ["🧠 *模型管理*", `内置模型：${total - keys.length} 个 · 自定义：${keys.length} 个`]
    // Telegram rejects messages over 4096 chars; cap the dynamic sections and leave room for the fixed block below
    let used = lines.join("\n").length
    const push = (line: string): boolean => {
      if (used + line.length + 1 > 3_200) return false
      lines.push(line)
      used += line.length + 1
      return true
    }
    if (keys.length === 0) {
      lines.push("\n暂无自定义模型。")
    } else {
      lines.push("")
      let shownKeys = 0
      for (const key of keys.slice(0, 30)) {
        const model = custom[key]!
        if (!push(`• \`${escapeMarkdown(key)}\` → \`${escapeMarkdown(`${model.providerID}/${model.modelID}`)}\` — ${escapeMarkdown(model.label)}`)) break
        shownKeys += 1
      }
      if (shownKeys < keys.length) lines.push(`_另有 ${keys.length - shownKeys} 个未显示。_`)
    }

    if (agents.length > 0) {
      lines.push("\n*Agent 绑定*")
      let shownAgents = 0
      for (const agent of agents) {
        if (!push(`• \`${escapeMarkdown(agent.name)}\` → ${agent.model ? `\`${escapeMarkdown(agent.model)}\`` : "_未设置_"}`)) break
        shownAgents += 1
      }
      if (shownAgents < agents.length) {
        lines.push(`_另有 ${agents.length - shownAgents} 个 agent 未显示；完整列表见 \`/cc model agents\`。_`)
      }
    }

    lines.push(
      "\n*命令*",
      "`/cc model add <简称> <provider>/<modelID> [显示名] [--attachment] [--context N] [--output N]`",
      "`/cc model del <简称> [force]`（需确认）",
      "`/cc model assign <agent|self> <简称|provider/modelID>`",
      "`/cc model agents` · `/cc model list`",
      "\nAI 也可在 bash 中运行 `npm run models -- ...`；改动无需重启。",
    )

    const keyboard = new InlineKeyboard()
      .text("👥 Agents", "cc:magents")
      .text("🔄 刷新", "cc:model")
      .row()
      .text("🧠 切换会话模型", "show:model")
      .text("🔌 cc 面板", "cc:refresh")
      .row()
      .text("⬅️ 主菜单", "show:menu")
    return { text: lines.join("\n"), keyboard }
  }

  #agentsText(): string {
    const agents = this.#models.listAgents()
    if (agents.length === 0) return "👥 *Agent 绑定*\n\n未找到 `.opencode/agent/*.md`。"
    const lines = ["👥 *Agent 模型绑定*", ""]
    // Leave headroom under Telegram's 4096-char limit for long descriptions across many agents
    let used = lines.join("\n").length
    let shown = 0
    for (const agent of agents) {
      const mode = agent.mode ? ` [${escapeMarkdown(agent.mode)}]` : ""
      const head = `• *${escapeMarkdown(agent.name)}*${mode} → ${agent.model ? `\`${escapeMarkdown(agent.model)}\`` : "_未设置_"}`
      const description = agent.description
        ? `\n  _${escapeMarkdown(clip(agent.description, 80) ?? "")}_`
        : ""
      if (used + head.length + description.length + 1 > 3_000) break
      lines.push(head + description)
      used += head.length + description.length + 1
      shown += 1
    }
    if (shown < agents.length) {
      lines.push(`\n_另有 ${agents.length - shown} 个 agent 未显示；完整列表见 \`npm run models -- agents\`。_`)
    }
    return lines.join("\n")
  }

  #ccProviderId(chatId: number, index: number): string | undefined {
    if (!Number.isInteger(index) || index < 0) return undefined
    return this.#ccProviders.get(chatId)?.[index]
  }

  /**
   * Resolves a panel index against a fresh provider list. Provider ids are cached by
   * position when the panel renders, so a provider added, deleted or reordered since
   * then would otherwise make `cc:use:<index>` target a different provider than the
   * one the user just confirmed.
   */
  async #ccProviderAt(chatId: number, index: number): Promise<string | undefined> {
    const cached = this.#ccProviderId(chatId, index)
    if (cached === undefined) return undefined
    let fresh: string[]
    try {
      fresh = (await this.#cc.listProviders()).map((provider) => provider.id)
    } catch {
      // Cannot re-check: act on the cached id rather than blocking the button
      return cached
    }
    this.#ccProviders.set(chatId, fresh)
    return fresh[index] === cached ? cached : undefined
  }

  async #currentCcProvider(): Promise<string | undefined> {
    const providers = await this.#cc.listProviders()
    return providers.find((provider) => provider.current)?.id ?? providers[0]?.id
  }

  #speedtestText(id: string, result: CcSwitchSpeedtest): string {
    const status = result.ok
      ? `✅ 测速成功${result.latencyMs !== undefined ? `（${result.latencyMs} ms）` : ""}`
      : "❌ 测速失败"
    const details: string[] = []
    if (result.endpoint) details.push(`• 端点：\`${escapeMarkdown(result.endpoint)}\``)
    if (result.status) details.push(`• 状态：${escapeMarkdown(result.status)}`)
    return `⚡ *Provider 测速*：\`${escapeMarkdown(id)}\`\n\n${status}${details.length ? `\n${details.join("\n")}` : ""}`
  }

  async #sendCcOutput(chatId: number, title: string, body: string): Promise<void> {
    const cleaned = redactSecrets(stripAnsi(body).trim() || "（无输出）")
    const clipped = cleaned.length > 3200 ? `${clip(cleaned, 3200) ?? ""}\n…（已截断）` : cleaned
    await this.#host.sendTextMessage(chatId, `${title}\n\`\`\`\n${clipped.replace(/```/g, "'''")}\n\`\`\``)
  }

  async handleCallback(
    ctx: Context,
    chatId: number,
    rest: string,
    answer: (text?: string) => Promise<void>,
  ): Promise<void> {
    const [action = "", rawIndex] = rest.split(":", 2)
    const index = Number(rawIndex)

    try {
      if (action === "cfm" || action === "cnl") {
        await answer()
        const token = rawIndex ?? ""
        const pending = this.#ccPending.get(token)
        if (!pending || Date.now() - pending.createdAt > CC_CONFIRM_TTL_MS) {
          this.#ccPending.delete(token)
          await this.#host.sendTextMessage(chatId, "⌛ 操作已过期，请重新发起。")
          return
        }
        if (pending.chatId !== chatId) {
          await this.#host.sendTextMessage(chatId, "⌛ 该确认按钮不属于当前会话。")
          return
        }
        this.#ccPending.delete(token)
        if (action === "cnl") {
          await this.#host.sendTextMessage(chatId, "已取消。")
          return
        }
        try {
          let args = pending.args
          for (const extra of pending.appendArgs ?? []) {
            if (!args.includes(extra)) args = [...args, extra]
          }
          if (pending.kind === "provider-use") {
            const id = pending.providerId ?? ""
            await this.#cc.useProvider(id)
            this.#log.info(`cc-switch provider switched -> ${id}`)
            await this.#host.sendTextMessage(
              chatId,
              `✅ 已将 cc-switch 全局配置切换到 Provider \`${escapeMarkdown(id)}\`。\n` +
                "_注意：项目 opencode.json 的 Provider 配置仍然优先；Bot 的模型通过 `/model` 控制。_",
            )
            return
          }
          if (pending.kind === "model-delete") {
            const key = pending.modelKey ?? ""
            const removed = this.#models.remove(key, pending.modelForce === true)
            if (!removed) throw new Error(`模型不存在或不是自定义模型：${key}`)
            await this.#host.sendTextMessage(
              chatId,
              `🗑 *已删除模型* \`${escapeMarkdown(removed.key)}\`（${escapeMarkdown(`${removed.entry.providerID}/${removed.entry.modelID}`)}）` +
                (removed.providerUpdated ? "\n已从项目 `opencode.json` 中移除。" : "") +
                (removed.references.length > 0
                  ? `\n⚠️ 强制删除，以下引用仍存在：${escapeMarkdown(removed.references.join("、"))}`
                  : "") +
                (removed.resetAgents.length > 0
                  ? `\n已清除 ${removed.resetAgents.length} 个 Agent 的模型绑定：${escapeMarkdown(removed.resetAgents.join("、"))}，它们将使用引擎默认模型。`
                  : "") +
                (removed.resetChats.length > 0
                  ? `\n已重置 ${removed.resetChats.length} 个会话的模型选择，它们将使用引擎默认模型。`
                  : ""),
            )
            return
          }
          await this.#executeCc(chatId, args, {
            bare: pending.bare,
            pty: pending.pty,
            timeoutMs: pending.timeoutMs,
            label: pending.label,
          })
        } catch (err) {
          const message = redactSecrets(err instanceof Error ? err.message : String(err))
          await this.#host.sendTextMessage(chatId, `❌ ${escapeMarkdown(clip(message, 600) ?? "")}`)
        }
        return
      }

      if (action === "refresh") {
        await answer()
        await this.#host.editPanel(ctx, await this.panel(chatId))
        return
      }

      if (action === "use") {
        const id = await this.#ccProviderAt(chatId, index)
        if (!id) {
          await answer("列表已过期，请重新发送 /cc")
          return
        }
        await answer("请确认切换")
        await this.#requestCcConfirm(chatId, {
          args: ["use", id],
          label: `切换 Provider 到 \`${id}\`（修改 cc-switch 全局配置）`,
          kind: "provider-use",
          providerId: id,
        })
        return
      }

      if (action === "test" || action === "testcur") {
        let id = action === "test" ? await this.#ccProviderAt(chatId, index) : undefined
        if (action === "testcur") id = await this.#currentCcProvider()
        if (!id) {
          await answer("未找到 Provider，请重新打开 /cc")
          return
        }
        if (this.#ccTesting.has(id)) {
          await answer("该 Provider 正在测速中…")
          return
        }
        this.#ccTesting.add(id)
        void this.#backgroundSpeedtest(chatId, id)
        await answer("正在测速，结果稍后发送…")
        return
      }

      if (action === "mcp") {
        await answer()
        await this.#sendCcOutput(chatId, "📡 *MCP 服务器*", await this.#cc.listMcp())
        return
      }

      if (action === "msync") {
        await answer("正在同步 MCP…")
        await this.#sendCcOutput(chatId, "📡 *MCP 同步*", await this.#cc.syncMcp())
        return
      }

      if (action === "prompts") {
        await answer()
        await this.#sendCcOutput(chatId, "📝 *提示词预设*", await this.#cc.listPrompts())
        return
      }

      if (action === "env") {
        await answer()
        await this.#sendCcOutput(chatId, "🧪 *本地 CLI 工具*", await this.#cc.envTools())
        return
      }

      if (action === "proxy") {
        await answer()
        await this.#sendCcOutput(chatId, "🌐 *cc-switch 本地代理*", await this.#cc.proxyShow())
        return
      }

      if (action === "model") {
        await answer()
        await this.#host.editPanel(ctx, this.#ccModelPanel())
        return
      }

      if (action === "magents") {
        await answer()
        await this.#host.sendTextMessage(
          chatId,
          this.#agentsText(),
          new InlineKeyboard().text("🔌 cc 面板", "cc:refresh").text("⬅️ 主菜单", "show:menu"),
        )
        return
      }

      if (action === "cchelp") {
        await answer()
        await this.#host.sendTextMessage(
          chatId,
          CC_HELP,
          new InlineKeyboard().text("🔌 cc 面板", "cc:refresh").text("⬅️ 主菜单", "show:menu"),
        )
        return
      }

      const panels: Record<string, { args: string[]; label: string }> = {
        failover: { args: ["failover", "show"], label: "Failover" },
        sessions: { args: ["sessions", "list"], label: "Sessions" },
        auth: { args: ["auth", "status"], label: "Auth" },
        skills: { args: ["skills", "list"], label: "Skills" },
        config: { args: ["config", "path"], label: "Config 路径" },
      }
      // Own-property lookup: an inherited name such as "constructor" would otherwise
      // resolve to a prototype value and reach #executeCc with no arguments
      const panel = Object.hasOwn(panels, action) ? panels[action] : undefined
      if (panel) {
        await answer()
        try {
          await this.#executeCc(chatId, panel.args, { label: panel.label })
        } catch (err) {
          const message = redactSecrets(err instanceof Error ? err.message : String(err))
          await this.#host.sendTextMessage(chatId, `❌ ${escapeMarkdown(clip(message, 600) ?? "")}`)
        }
        return
      }

      await answer("未知操作")
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : String(err))
      await answer(clip(message, 180) ?? "")
      await this.#host.sendTextMessage(chatId, `❌ ${escapeMarkdown(clip(message, 600) ?? "")}`)
    }
  }

  async #backgroundSpeedtest(chatId: number, id: string): Promise<void> {
    try {
      const result = await this.#cc.speedtest(id)
      await this.#host.sendTextMessage(chatId, this.#speedtestText(id, result))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.#host.sendTextMessage(chatId, `❌ Provider \`${escapeMarkdown(id)}\` 测速失败：${escapeMarkdown(clip(message, 300) ?? "")}`)
    } finally {
      this.#ccTesting.delete(id)
    }
  }

  async handleCommand(chatId: number, key: string, arg: string): Promise<void> {
    const trimmed = arg.trim()
    const head = /^(\S+)\s*([\s\S]*)$/.exec(trimmed)
    const action = (head?.[1] ?? "").toLowerCase()
    const restRaw = head?.[2]?.trim() ?? ""
    const rest = tokenizeCcArgs(restRaw)

    if (!action) {
      await this.#host.sendPanel(chatId, await this.panel(chatId))
      return
    }

    try {
      if (action === "help") {
        await this.#host.sendTextMessage(chatId, CC_HELP)
        return
      }

      if (action === "run" || action === "raw") {
        await this.#runCcGeneric(chatId, rest)
        return
      }

      if (CC_GROUPS.has(action)) {
        await this.#handleCcGroup(chatId, key, action, restRaw)
        return
      }

      if (action === "use" || action === "switch") {
        const id = rest[0]
        if (!id) {
          await this.#host.sendTextMessage(chatId, "用法：`/cc use <provider-id>`（ID 见 `/cc` 面板）")
          return
        }
        await this.#requestCcConfirm(chatId, {
          args: ["use", id],
          label: `切换 Provider 到 \`${id}\`（修改 cc-switch 全局配置）`,
          kind: "provider-use",
          providerId: id,
        })
        return
      }

      if (action === "current") {
        const result = await this.#cc.run(["provider", "current"])
        await this.#sendCcOutput(chatId, "🔌 *当前 Provider*", result.stdout || result.stderr)
        return
      }

      if (action === "test" || action === "speedtest") {
        const id = rest[0] ?? (await this.#currentCcProvider())
        if (!id) throw new Error("未找到 Provider，请先发送 `/cc use <id>` 或指定 ID。")
        await this.#host.sendTextMessage(chatId, `⚡ 正在测速 \`${escapeMarkdown(id)}\`，请稍候…`)
        const result = await this.#cc.speedtest(id)
        await this.#host.sendTextMessage(chatId, this.#speedtestText(id, result))
        return
      }

      if (action === "stream") {
        const id = rest[0]
        if (!id) throw new Error("用法：`/cc stream <provider-id>`")
        await this.#host.sendTextMessage(chatId, `📡 正在检查 \`${escapeMarkdown(id)}\` 的流式连通性…`)
        await this.#sendCcOutput(chatId, "📡 *Stream Check*", await this.#cc.streamCheck(id))
        return
      }

      if (action === "models" || action === "fetch-models") {
        const id = rest[0]
        if (!id) throw new Error("用法：`/cc models <provider-id>`")
        await this.#sendCcOutput(chatId, "🧾 *可用模型*", await this.#cc.fetchModels(id))
        return
      }

      if (action === "quota") {
        const id = rest[0]
        if (!id) throw new Error("用法：`/cc quota <provider-id> [--json]`")
        await this.#dispatchCc(chatId, ["provider", "quota", ...rest])
        return
      }

      if (action === "model") {
        await this.#handleCcModel(chatId, key, rest)
        return
      }

      if (action === "version") {
        const version = (await this.#cc.version()) ?? "未安装"
        await this.#host.sendTextMessage(chatId, `🔌 cc-switch：${escapeMarkdown(version)}\n应用：\`${this.#cc.app}\``)
        return
      }

      await this.#host.sendTextMessage(
        chatId,
        "未知指令。发送 `/cc help` 查看全部命令，或使用 `/cc run <参数>` 执行任意非交互命令。",
      )
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : String(err))
      await this.#host.sendTextMessage(chatId, `❌ ${escapeMarkdown(clip(message, 600) ?? "")}`)
    }
  }

  async #handleCcGroup(chatId: number, key: string, group: string, restRaw: string): Promise<void> {
    const normalized = group === "prompt" ? "prompts" : group
    const subMatch = /^(\S+)\s*([\s\S]*)$/.exec(restRaw)
    const sub = (subMatch?.[1] ?? "").toLowerCase()
    const tailRaw = subMatch?.[2]?.trim() ?? ""
    const tail = tokenizeCcArgs(tailRaw)

    if (normalized === "deeplink") {
      await this.#requestCcDeeplinkImport(chatId, restRaw.trim())
      return
    }

    if (normalized === "update") {
      if (sub === "--check" || sub === "check" || tail.includes("--check")) {
        const args = ["update", "--check", ...tail.filter((token) => token !== "--check")]
        await this.#executeCc(chatId, args, { label: "检查 cc-switch 更新", timeoutMs: CC_LONG_TIMEOUT_MS })
        return
      }
      await this.#requestCcConfirm(chatId, {
        args: ["update", ...(sub ? [sub] : []), ...tail],
        label: "升级 cc-switch 二进制到最新版本",
        pty: true,
        timeoutMs: CC_UPDATE_TIMEOUT_MS,
      })
      return
    }

    if (normalized === "mcp" && sub === "add") {
      if (!tailRaw) {
        await this.#host.sendTextMessage(
          chatId,
          "用法：`/cc mcp add {\"mcpServers\":{\"id\":{\"command\":\"npx\",\"args\":[\"-y\",\"pkg\"]}}}`\n" +
            "可省略外层，直接发送服务器映射 JSON。",
        )
        return
      }
      await this.#host.sendTextMessage(chatId, "📡 正在导入 MCP 配置…")
      await this.#sendCcOutput(chatId, "📡 *MCP 导入*", await this.#cc.importMcp(tailRaw))
      return
    }

    if (normalized === "prompts" && (sub === "new" || sub === "create")) {
      const parsed = /^(\S+)\s*([\s\S]*)$/.exec(tailRaw)
      const name = parsed?.[1]
      const content = parsed?.[2]?.trim() ?? ""
      if (!name || !content) {
        await this.#host.sendTextMessage(chatId, "用法：`/cc prompts new <名称> <提示词内容>`")
        return
      }
      await this.#host.sendTextMessage(chatId, "📝 正在创建提示词预设…")
      await this.#sendCcOutput(chatId, "📝 *提示词已创建*", await this.#cc.importPrompt(name, content))
      return
    }

    // `provider add 名称 键=值` is the app form's twin; a leading flag means the
    // user typed native cc-switch arguments, which keep going through unchanged
    if (normalized === "provider" && sub === "add" && tail[0] && !tail[0].startsWith("-")) {
      const parsed = parseProviderAdd(tail)
      if (typeof parsed === "string") {
        await this.#host.sendTextMessage(chatId, parsed)
        return
      }
      await this.#host.sendTextMessage(chatId, `🧩 正在创建 Provider \`${escapeMarkdown(parsed.name)}\`…`)
      const result = await this.#cc.addProvider(parsed)
      await this.#sendCcOutput(
        chatId,
        result.code === 0 ? "🧩 *Provider 已创建*" : `❌ *Provider 创建失败（退出码 ${result.code}）*`,
        result.stdout || result.stderr,
      )
      if (parsed.apiKey) {
        await this.#host.sendTextMessage(chatId, "⚠️ API Key 会留在聊天记录里；App 的「＋ 新建」表单不会回显，或删除本条消息。")
      }
      return
    }

    const alias = CC_SUB_ALIASES[`${normalized} ${sub}`]
    const args = alias
      ? [...alias, ...tail]
      : sub
        ? [normalized, sub, ...tail]
        : [...(CC_DEFAULTS[normalized] ?? [normalized])]
    await this.#dispatchCc(chatId, args)
  }

  async #runCcGeneric(chatId: number, args: string[]): Promise<void> {
    if (args.length === 0) {
      await this.#host.sendTextMessage(chatId, "用法：`/cc run provider list`、`/cc run mcp enable foo --apps opencode` 等。")
      return
    }
    if (args.includes("--app") || args.includes("-a")) {
      throw new Error("不要在 /cc run 中传 --app；应用类型由 CC_SWITCH_APP 固定。")
    }
    if (args[0] === "deeplink") {
      await this.#requestCcDeeplinkImport(chatId, args[1] ?? "")
      return
    }
    await this.#dispatchCc(chatId, args)
  }

  async #dispatchCc(chatId: number, args: string[]): Promise<void> {
    // Every cc-switch command accepts -a/--app; letting one through would retarget
    // another app's config, so the flag is rejected in all its spellings
    if (args.some((token) => /^(-a|--app)(=|$)/.test(token))) {
      throw new Error("不要在 /cc 命令中传 --app；应用类型由 CC_SWITCH_APP 固定。")
    }

    const blocked = this.#ccBlockedReason(args)
    if (blocked) {
      await this.#host.sendTextMessage(chatId, blocked)
      return
    }

    const risk = this.#ccConfirmReason(args)
    if (risk) {
      await this.#requestCcConfirm(chatId, { args, ...risk })
      return
    }

    await this.#executeCc(chatId, args, { label: args.slice(0, 3).join(" ") })
  }

  #ccBlockedReason(args: string[]): string | undefined {
    const [group = "", sub = ""] = args
    const key = `${group} ${sub}`.trim().toLowerCase()
    const blocked = new Map<string, string>([
      ["interactive", "交互式 TUI 无法在 Telegram 中使用；请使用 `/cc help` 查看可用命令。"],
      ["completions", "shell 补全命令与聊天无关，已跳过。"],
      ["start", "`start` 会启动交互式 CLI，无法在 Telegram 中运行。"],
      ["proxy serve", "`proxy serve` 是前台常驻进程，无法在 Telegram 中运行；请用 `proxy enable`。"],
      ["auth login", "OAuth 登录需要在终端完成设备授权，无法在 Telegram 中运行。"],
      ["sessions resume", "恢复会话会启动交互式 CLI，无法在 Telegram 中运行。"],
      ["provider edit", "`provider edit` 依赖交互式 TUI；可先用 `provider add` 新建，或在服务器上编辑。"],
      ["mcp edit", "`mcp edit` 依赖交互式 TUI；可删除后用 `/cc mcp add <JSON>` 重建。"],
      ["mcp add", "原生 `mcp add` 是交互式的；请用 `/cc mcp add <JSON>` 导入。"],
      ["prompts edit", "`prompts edit` 依赖外部编辑器；可用 `/cc prompts new` 新建预设。"],
      ["prompts create", "原生 `prompts create` 依赖外部编辑器；请用 `/cc prompts new <名称> <内容>`。"],
      ["config restore", "`config restore` 需要在备份列表中交互选择，无法在 Telegram 中运行。"],
    ])
    if (blocked.has(key)) return blocked.get(key)
    if (group === "daemon" && sub === "start" && !args.includes("--detach")) {
      return "前台 `daemon start` 会阻塞；请使用 `/cc daemon start --detach`。"
    }
    return undefined
  }

  #ccConfirmReason(
    args: string[],
  ): Omit<PendingCcAction, "args" | "createdAt" | "label" | "chatId"> & { label: string } | undefined {
    const [group = "", sub = ""] = args
    const key = `${group} ${sub}`.trim().toLowerCase()
    switch (key) {
      case "provider use":
        return {
          label: `切换 Provider 到 \`${args[2] ?? "?"}\``,
          kind: "provider-use",
          providerId: args[2] ?? "",
        }
      // Canonical spelling of `use`; /cc provider switch and /cc run bypass the
      // /cc use shortcut, so the same confirmation has to cover it here
      case "provider switch":
        return {
          label: `切换 Provider 到 \`${args[2] ?? "?"}\`（修改 cc-switch 全局配置）`,
          kind: "provider-use",
          providerId: args[2] ?? "",
        }
      case "use":
        return {
          label: `切换 Provider 到 \`${args[1] ?? "?"}\``,
          kind: "provider-use",
          providerId: args[1] ?? "",
        }
      case "provider delete":
        return { label: `删除 Provider \`${args[2] ?? "?"}\``, pty: true }
      case "mcp delete":
        return { label: `删除 MCP 服务器 \`${args[2] ?? "?"}\``, pty: true }
      case "prompts delete":
        return { label: `删除提示词预设 \`${args[2] ?? "?"}\``, pty: true }
      case "skills uninstall":
        return { label: `卸载技能 \`${args[2] ?? "?"}\``, pty: true }
      case "auth remove":
        return { label: `移除 ChatGPT 账号 \`${args[2] ?? "?"}\``, pty: true }
      case "auth logout":
        return { label: "登出并清除所有 ChatGPT OAuth 数据", pty: true }
      // Without --confirm cc-switch only runs a dry run; with it a banked reset
      // credit is burned, which deserves the same gate as `provider quota --reset`
      case "auth reset-quota":
        return args.includes("--confirm") ? { label: "消耗一次 Codex 配额重置额度" } : undefined
      case "config import":
        return { label: `导入配置 \`${args[2] ?? "?"}\`（会覆盖当前数据库）`, pty: true }
      case "config reset":
        return { label: "重置 cc-switch 配置为默认值", pty: true }
      case "sessions delete":
        return { label: `删除会话 \`${args[2] ?? "?"}\``, appendArgs: ["--yes"] }
      case "failover clear":
        return { label: "清空故障转移队列", appendArgs: ["--yes"] }
      case "failover enable":
        return { label: "启用自动故障转移（可能同时开启代理路由）", pty: true }
      case "provider quota":
        if (args.includes("--reset")) {
          return { label: "消耗一次配额重置额度", appendArgs: ["--confirm"] }
        }
        return undefined
      default:
        if (group === "update" && !args.includes("--check")) {
          return { label: "升级 cc-switch 二进制到最新版本", pty: true, timeoutMs: CC_UPDATE_TIMEOUT_MS }
        }
        return undefined
    }
  }

  /** cc-switch deep links overwrite provider/MCP/prompt config, so they always confirm. */
  async #requestCcDeeplinkImport(chatId: number, rawUrl: string): Promise<void> {
    const url = rawUrl.trim()
    if (!url) throw new Error("用法：`/cc deeplink <ccswitch://v1/import?...>`")
    if (!/^ccswitch:\/\/v1\/import\?/i.test(url)) throw new Error("只接受 ccswitch://v1/import?... 形式的链接。")
    if (url.length > 8192) throw new Error("Deep Link 过长。")
    // clip: a hard cut between surrogate halves makes Telegram reject the whole
    // confirmation message, so the import could never be approved
    const shownUrl = clip(url, 120) ?? ""
    await this.#requestCcConfirm(chatId, {
      args: ["deeplink", url],
      bare: true,
      label:
        `导入 Deep Link（会新增或覆盖 Provider、MCP、提示词等配置）\n` +
        `\`${shownUrl}${url.length > shownUrl.length ? "…" : ""}\``,
    })
  }

  async #requestCcConfirm(
    chatId: number,
    action: Omit<PendingCcAction, "createdAt" | "chatId">,
  ): Promise<void> {
    const now = Date.now()
    for (const [token, pending] of this.#ccPending) {
      if (now - pending.createdAt > CC_CONFIRM_TTL_MS) this.#ccPending.delete(token)
    }
    const token = randomBytes(6).toString("hex")
    this.#ccPending.set(token, { ...action, chatId, createdAt: now })
    const keyboard = new InlineKeyboard()
      .text("✅ 确认执行", `cc:cfm:${token}`)
      .text("❌ 取消", `cc:cnl:${token}`)
    await this.#host.sendTextMessage(
      chatId,
      `⚠️ *需要确认*\n\n即将执行：${escapeMarkdown(action.label)}\n\n_5 分钟内有效，点击下方按钮继续。_`,
      keyboard,
    )
  }

  #isLongCcCommand(args: string[]): boolean {
    const [group = "", sub = ""] = args
    if (group === "update" || group === "deeplink") return true
    if (group === "provider" && ["speedtest", "stream-check", "fetch-models", "quota"].includes(sub)) return true
    if (group === "sessions" && sub === "search") return true
    if (group === "config" && ["import", "export", "backup"].includes(sub)) return true
    if (group === "skills" && ["install", "market", "update", "check-updates", "discover", "sync"].includes(sub)) return true
    if (group === "daemon" && sub === "start") return true
    return false
  }

  async #executeCc(
    chatId: number,
    args: string[],
    options: { bare?: boolean; pty?: boolean; timeoutMs?: number; label?: string } = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? (this.#isLongCcCommand(args) ? CC_LONG_TIMEOUT_MS : undefined)
    // The echoed preview can quote a token typed into the command (an API URL, a
    // password flag value), so it gets the same redaction as command output; long
    // tokens are clipped so escaping cannot push the line past the message limit
    const preview = args
      .slice(0, 3)
      .map((token) => escapeMarkdown(clip(redactSecrets(token), 80) ?? ""))
      .join(" ")
    await this.#host.sendTextMessage(chatId, `⏳ 正在执行 \`${preview || "cc-switch"}\`…`)

    const result = options.bare
      ? await this.#cc.runBare(args, timeoutMs)
      : options.pty
        ? await this.#cc.runWithConfirm(args, timeoutMs)
        : await this.#cc.run(args, timeoutMs)

    this.#log.info(`cc-switch ${args[0] ?? ""} ${args[1] ?? ""} [ok]`)
    const title = options.label ? `🔌 *${escapeMarkdown(options.label)}*` : "🔌 *cc-switch*"
    await this.#sendCcOutput(chatId, title, result.stdout || result.stderr)
  }

  async #handleCcModel(chatId: number, key: string, rest: string[]): Promise<void> {
    const sub = (rest[0] ?? "list").toLowerCase()
    const args = rest.slice(1)

    if (sub === "list" || sub === "panel") {
      await this.#host.sendPanel(chatId, this.#ccModelPanel())
      return
    }

    if (sub === "agents" || sub === "agent") {
      await this.#host.sendTextMessage(chatId, this.#agentsText())
      return
    }

    if (sub === "add") {
      const key = args[0]
      const ref = args[1]
      if (!key || !ref) {
        await this.#host.sendTextMessage(
          chatId,
          "用法：`/cc model add <简称> <provider>/<modelID> [显示名称] [参数]`\n" +
            "例如：`/cc model add argon2 custom/gemini-4-argon-high Gemini 4 Argon`\n" +
            "参数：`--attachment` 声明支持图片，`--context 200000` 上下文窗口，`--output 64000` 输出上限。",
        )
        return
      }
      const slash = ref.indexOf("/")
      if (slash <= 0 || slash === ref.length - 1) {
        throw new Error(`模型请使用 provider/modelID 形式（收到：${ref}）`)
      }

      const labelParts: string[] = []
      let attachment: boolean | undefined
      let contextWindow: number | undefined
      let outputLimit: number | undefined
      const readLimit = (flag: string, raw: string | undefined): number => {
        const value = Number(raw)
        if (!raw || !Number.isInteger(value) || value <= 0) {
          throw new Error(`${flag} 需要一个正整数，例如 \`${flag} 200000\`。`)
        }
        return value
      }
      for (let i = 2; i < args.length; i += 1) {
        const token = args[i]!
        const eq = token.indexOf("=")
        const name = eq > 0 ? token.slice(0, eq) : token
        const inline = eq > 0 ? token.slice(eq + 1) : undefined
        if (name === "--attachment" || name === "--vision" || name === "-a") {
          attachment = true
        } else if (name === "--context" || name === "--ctx") {
          contextWindow = readLimit(name, inline ?? args[++i])
        } else if (name === "--output" || name === "--max-output") {
          outputLimit = readLimit(name, inline ?? args[++i])
        } else if (name.startsWith("-")) {
          throw new Error(`未知参数：${token}`)
        } else {
          labelParts.push(token)
        }
      }

      const label = labelParts.join(" ")
      const result = this.#models.add({
        key,
        providerID: ref.slice(0, slash),
        modelID: ref.slice(slash + 1),
        label: label || undefined,
        desc: "由 Telegram 添加的自定义模型",
        attachment,
        contextWindow,
        outputLimit,
      })
      const capabilities = [
        attachment ? "支持图片输入" : "",
        contextWindow ? `上下文 ${contextWindow}` : "",
        outputLimit ? `输出上限 ${outputLimit}` : "",
      ].filter(Boolean)
      const capabilityNote =
        capabilities.length === 0
          ? ""
          : result.providerUpdated
            ? `\n已写入模型能力：${capabilities.join("、")}。`
            : `\n⚠️ 模型能力参数（${capabilities.join("、")}）未写入：Provider 不在项目 \`opencode.json\` 中。`
      await this.#host.sendTextMessage(
        chatId,
        `✅ *已添加模型* \`${escapeMarkdown(result.key)}\` → \`${escapeMarkdown(`${result.entry.providerID}/${result.entry.modelID}`)}\`（${escapeMarkdown(result.entry.label)}）\n` +
          (result.providerUpdated
            ? "已同步到项目 `opencode.json`，现在可用 `/model` 选择。"
            : "Provider 不在项目 `opencode.json` 中，仅登记到 `data/models.json`。") +
          capabilityNote,
      )
      return
    }

    if (sub === "del" || sub === "delete" || sub === "rm") {
      const key = args[0]
      if (!key) {
        await this.#host.sendTextMessage(chatId, "用法：`/cc model del <简称> [force]`")
        return
      }
      const force = args.slice(1).some((token) => token.toLowerCase() === "force" || token === "--force")
      await this.#requestCcConfirm(chatId, {
        args: ["model", "delete", key],
        kind: "model-delete",
        modelKey: key,
        modelForce: force || undefined,
        label: force
          ? `强制删除模型 \`${key}\`（会删除项目配置中的条目，并清除引用它的 Agent 与会话绑定）`
          : `删除模型 \`${key}\``,
      })
      return
    }

    if (sub === "assign") {
      const agent = args[0]
      const selection = args.slice(1).join(" ")
      if (!agent || !selection) {
        await this.#host.sendTextMessage(
          chatId,
          "用法：`/cc model assign <agent|self> <简称|provider/modelID>`\n例如：`/cc model assign assistant argon`",
        )
        return
      }
      const result = this.#models.assignAgent(agent, selection)
      let extra = ""
      const selfAgent = this.#host.cfg.opencode.agent ?? "assistant"
      if (result.agent === selfAgent && this.#host.store.getEngine(key) === "opencode") {
        const target = this.#models.resolveModel(selection)
        await this.#host.applyOpenCodeModel(key, target)
        extra = "\n当前会话也已切换到该模型（上下文已重置）。"
      }
      await this.#host.sendTextMessage(
        chatId,
        `✅ 已将 Agent *${escapeMarkdown(result.agent)}* 的模型设置为 \`${escapeMarkdown(result.model)}\`（${escapeMarkdown(result.label)}）。${extra}`,
      )
      return
    }

    throw new Error("用法：`/cc model list|agents|add|del|assign`")
  }
}
