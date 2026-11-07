import { randomBytes } from "node:crypto"
import type { Context } from "grammy"
import { InlineKeyboard } from "grammy"
import { escapeMarkdown, clip, type Panel } from "./messages.js"
import { MAGPIE_HELP } from "./help.js"
import { magpieErrorText, type MagpieService } from "./magpie.js"
import { magpieBlockedReason, magpieConfirmPlan } from "./magpieGuards.js"
import {
  MAGPIE_EXEC,
  MAGPIE_VIEWS,
  assertMagpieArg,
  assertMagpieTarget,
  magpieExecPhrases,
  magpieViewPhrases,
} from "./apiMagpieSpecs.js"
import type { Logger } from "./logger.js"

export interface MagpieHost {
  sendText(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean>
  sendPanel(chatId: number, panel: Panel): Promise<void>
  editPanel(ctx: Context, panel: Panel): Promise<void>
}

interface PendingAction {
  chatId: number
  args: string[]
  label: string
  createdAt: number
}

/** Word a chat may type for a direct `magpie <agent> <model>`; mirrors magpie's own agents list. */
const AGENT_WORDS = new Set([
  "claude",
  "cc",
  "codex",
  "gemini",
  "opencode",
  "oc",
  "mimocode",
  "deveco",
  "pi",
  "goose",
  "cursor",
  "zed",
  "copilot",
  "crush",
  "aside",
])

const TEXT_LIMIT = 3400
const CONFIRM_TTL_MS = 5 * 60_000
const PENDING_LIMIT = 64

function tokenize(text: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of text.matchAll(re)) tokens.push(match[1] ?? match[2] ?? match[3] ?? "")
  return tokens.filter((token) => token.length > 0)
}

function viewNameOf(words: string[]): { name: string; rest: string[] } | undefined {
  for (const [phrase, name] of magpieViewPhrases()) {
    if (words.length >= phrase.length && phrase.every((word, index) => words[index]!.toLowerCase() === word)) {
      return { name, rest: words.slice(phrase.length) }
    }
  }
  return undefined
}

function execNameOf(words: string[]): { name: string; rest: string[] } | undefined {
  for (const [phrase, name] of magpieExecPhrases()) {
    if (words.length >= phrase.length && phrase.every((word, index) => words[index]!.toLowerCase() === word)) {
      return { name, rest: words.slice(phrase.length) }
    }
  }
  return undefined
}

/**
 * The `/magpie` console: a status panel plus the command table from apiMagpieSpecs.ts, so the
 * Telegram surface and the HTTP API can never drift apart. Destructive commands go through an
 * inline confirmation (a short-lived token, not the argv, in the callback data).
 */
export class MagpieCommands {
  readonly #magpie: MagpieService
  readonly #host: MagpieHost
  readonly #log: Logger
  readonly #pending = new Map<string, PendingAction>()

  constructor(host: MagpieHost, magpie: MagpieService, log: Logger) {
    this.#host = host
    this.#magpie = magpie
    this.#log = log
  }

  async panel(chatId: number, notice?: string): Promise<Panel> {
    const overview = await this.#magpie.overview()
    const lines = [
      "🧩 *magpie 模型网关*",
      "",
      overview.available ? `• 版本：\`${escapeMarkdown(overview.version ?? "未知")}\`` : "• 状态：_未安装_",
      `• 网关：${overview.healthy ? "✅ 可达" : "❌ 不可达"} \`${escapeMarkdown(overview.gatewayUrl)}\``,
    ]
    if (overview.available) lines.push(`• 可执行文件：\`${escapeMarkdown(overview.bin ?? "")}\``)
    else lines.push("安装：`curl -fsSL https://usemagpie.ai/install.sh | sh`")
    lines.push("", "选择要查看或执行的分组，或直接发送 `/magpie <命令>`：")
    if (notice) lines.push("", notice)

    const keyboard = new InlineKeyboard()
      .text("🧾 Provider", "magpie:view:providers")
      .text("📦 模板", "magpie:view:presets")
      .text("🤖 Agents", "magpie:view:agents")
      .row()
      .text("🧠 模型", "magpie:view:models")
      .text("🧭 路由组", "magpie:view:groups")
      .text("📊 配额", "magpie:view:quota")
      .row()
      .text("📈 用量", "magpie:view:usage")
      .text("⚙️ 设置", "magpie:view:settings")
      .text("💳 账号", "magpie:view:accounts")
      .row()
      .text("🔌 守护进程", "magpie:view:daemon")
      .text("🔄 同步", "magpie:exec:sync")
      .text("⬆️ 检查更新", "magpie:exec:update-check")
      .row()
      .text("⬅️ 主菜单", "show:menu")

    return { text: lines.join("\n"), keyboard }
  }

  async handleCommand(chatId: number, _key: string, arg: string): Promise<void> {
    const tokens = tokenize(arg)
    if (tokens.length === 0) {
      await this.#host.sendPanel(chatId, await this.panel(chatId))
      return
    }
    const first = tokens[0]!.toLowerCase()

    if (first === "help") {
      await this.#host.sendText(chatId, MAGPIE_HELP)
      return
    }
    if (first === "status" || first === "panel") {
      await this.#host.sendPanel(chatId, await this.panel(chatId))
      return
    }
    if (first === "run") {
      await this.#runRaw(chatId, tokens.slice(1))
      return
    }
    if (first === "agent") {
      await this.#agentCommand(chatId, tokens.slice(1))
      return
    }
    if (first === "group" && tokens[1]?.toLowerCase() === "add") {
      await this.#groupAdd(chatId, tokens.slice(2))
      return
    }
    if (first === "provider" && tokens[1]?.toLowerCase() === "add") {
      await this.#providerAdd(chatId, tokens.slice(2))
      return
    }

    const exec = execNameOf(tokens)
    if (exec) {
      await this.#runExec(chatId, exec.name, exec.rest.join(" "))
      return
    }
    const view = viewNameOf(tokens)
    if (view) {
      const spec = Object.hasOwn(MAGPIE_VIEWS, view.name) ? MAGPIE_VIEWS[view.name] : undefined
      // A view with no target label is a whole command on its own: `settings set …` must not
      // be read as the `settings` view with the rest as a target. Hand the line to the guarded
      // passthrough instead, which asks for confirmation where magpie needs it.
      if (view.rest.length > 0 && spec && !spec.targetLabel) {
        await this.#runRaw(chatId, tokens)
        return
      }
      await this.#runView(chatId, view.name, view.rest.join(" "))
      return
    }
    // `magpie <agent> <model>` — the command people type most after the panel.
    if (AGENT_WORDS.has(first)) {
      await this.#agentCommand(chatId, tokens)
      return
    }
    // Words we refuse (tui/web/serve/plugin…) get their explanation instead of "unknown".
    const blocked = magpieBlockedReason(tokens, "Telegram")
    if (blocked) {
      await this.#host.sendText(chatId, blocked)
      return
    }

    await this.#host.sendText(
      chatId,
      `未知的 magpie 命令：\`${escapeMarkdown(clip(tokens.join(" "), 120) ?? "")}\`\n查看 \`/magpie help\`，或发送 \`/magpie run <参数>\` 透传。`,
    )
  }

  async #agentCommand(chatId: number, tokens: string[]): Promise<void> {
    if (tokens.length === 0) {
      await this.#host.sendText(chatId, "用法：`/magpie agent <agent>` 或 `/magpie agent <agent> <provider/model>`")
      return
    }
    if (!this.#magpie.available) {
      await this.#unavailable(chatId)
      return
    }
    try {
      const agent = assertMagpieTarget(tokens[0]!, "Agent")
      if (tokens.length === 1) {
        const text = await this.#magpie.showAgent(agent)
        await this.#sendOutput(chatId, `🤖 *${escapeMarkdown(agent)}*`, text)
        return
      }
      const model = tokens.slice(1).join(" ")
      const text = await this.#magpie.setAgentModel(agent, model)
      await this.#host.sendText(
        chatId,
        `✅ 已把 *${escapeMarkdown(agent)}* 的模型设为 \`${escapeMarkdown(model)}\`` +
          (text ? `\n${escapeMarkdown(clip(text, 600) ?? "")}` : ""),
      )
    } catch (err) {
      await this.#host.sendText(chatId, `❌ ${escapeMarkdown(magpieErrorText(err))}`)
    }
  }

  async #providerAdd(chatId: number, tokens: string[]): Promise<void> {
    if (tokens.length < 2) {
      await this.#host.sendText(chatId, "用法：`/magpie provider add <预设> <API Key>`（预设见 `/magpie presets`）")
      return
    }
    if (!this.#magpie.available) {
      await this.#unavailable(chatId)
      return
    }
    try {
      const preset = tokens[0]!
      const key = tokens.slice(1).join(" ")
      const text = await this.#magpie.addProvider(preset, key)
      await this.#host.sendText(
        chatId,
        `✅ 已添加 Provider \`${escapeMarkdown(preset)}\`\n_密钥只上传不回显；建议删除本条消息。_` +
          (text ? `\n${escapeMarkdown(clip(text, 600) ?? "")}` : ""),
      )
    } catch (err) {
      await this.#host.sendText(chatId, `❌ ${escapeMarkdown(magpieErrorText(err))}`)
    }
  }

  async #groupAdd(chatId: number, tokens: string[]): Promise<void> {
    const [name, ...pairs] = tokens
    if (!name || pairs.length === 0) {
      await this.#host.sendText(
        chatId,
        "用法：`/magpie group add <名称> models=provider/model routing=smart`\n例如：`/magpie group add daily models=deepseek/deepseek-chat,kimi/kimi-k2 routing=smart`",
      )
      return
    }
    if (!this.#magpie.available) {
      await this.#unavailable(chatId)
      return
    }
    try {
      const text = await this.#magpie.addGroup(name, pairs)
      await this.#host.sendText(
        chatId,
        `✅ 已创建路由组 \`${escapeMarkdown(name)}\`${text ? `\n${escapeMarkdown(clip(text, 600) ?? "")}` : ""}`,
      )
    } catch (err) {
      await this.#host.sendText(chatId, `❌ ${escapeMarkdown(magpieErrorText(err))}`)
    }
  }

  async #runView(chatId: number, name: string, target: string): Promise<void> {
    const spec = Object.hasOwn(MAGPIE_VIEWS, name) ? MAGPIE_VIEWS[name] : undefined
    if (!spec) return
    if (!this.#magpie.available) {
      await this.#unavailable(chatId)
      return
    }
    try {
      const safe = target.trim() ? assertMagpieTarget(target, spec.targetLabel ?? "目标") : ""
      if (spec.needsTarget && !safe) {
        await this.#host.sendText(chatId, `「${spec.label}」需要${spec.targetLabel ?? "目标"}`)
        return
      }
      const text = await this.#magpie.runRaw(spec.args(safe))
      await this.#sendOutput(chatId, `🧩 *${escapeMarkdown(spec.label)}*`, text)
    } catch (err) {
      await this.#sendOutput(chatId, "❌ *magpie 失败*", magpieErrorText(err))
    }
  }

  async #runExec(chatId: number, name: string, target: string): Promise<void> {
    const spec = Object.hasOwn(MAGPIE_EXEC, name) ? MAGPIE_EXEC[name] : undefined
    if (!spec) return
    if (!this.#magpie.available) {
      await this.#unavailable(chatId)
      return
    }
    let safe = ""
    try {
      safe = target.trim() ? assertMagpieTarget(target, spec.targetLabel ?? "目标") : ""
    } catch (err) {
      await this.#host.sendText(chatId, `❌ ${escapeMarkdown(magpieErrorText(err))}`)
      return
    }
    if (spec.needsTarget && !safe) {
      await this.#host.sendText(chatId, `「${spec.label}」需要${spec.targetLabel ?? "目标"}`)
      return
    }
    const args = spec.args(safe)
    const blocked = magpieBlockedReason(args, "Telegram")
    if (blocked) {
      await this.#host.sendText(chatId, blocked)
      return
    }
    const plan = magpieConfirmPlan(args)
    if (plan && !(await this.#requestConfirm(chatId, args, plan.label))) return
    await this.#execute(chatId, spec.label, args)
  }

  async #runRaw(chatId: number, words: string[]): Promise<void> {
    if (words.length === 0) {
      await this.#host.sendText(chatId, "用法：`/magpie run <magpie 参数>`")
      return
    }
    if (!this.#magpie.available) {
      await this.#unavailable(chatId)
      return
    }
    let args: string[]
    try {
      args = words.map(assertMagpieArg)
    } catch (err) {
      await this.#host.sendText(chatId, `❌ ${escapeMarkdown(magpieErrorText(err))}`)
      return
    }
    const blocked = magpieBlockedReason(args, "Telegram")
    if (blocked) {
      await this.#host.sendText(chatId, blocked)
      return
    }
    const plan = magpieConfirmPlan(args)
    if (plan && !(await this.#requestConfirm(chatId, args, plan.label))) return
    await this.#execute(chatId, `magpie ${args.slice(0, 3).join(" ")}`, args)
  }

  /** True when the action may run now; false when a confirmation was sent instead. */
  async #requestConfirm(chatId: number, args: string[], label: string): Promise<boolean> {
    this.#prunePending()
    const token = randomBytes(6).toString("hex")
    this.#pending.set(token, { chatId, args, label, createdAt: Date.now() })
    const keyboard = new InlineKeyboard()
      .text("✅ 确认执行", `magpie:cfm:${token}`)
      .text("取消", `magpie:cnl:${token}`)
    await this.#host.sendText(
      chatId,
      `⚠️ *需要确认*\n\n${escapeMarkdown(label)}\n\`${escapeMarkdown(clip(args.join(" "), 200) ?? "")}\`\n\n_5 分钟内有效。_`,
      keyboard,
    )
    return false
  }

  async #execute(chatId: number, label: string, args: string[]): Promise<void> {
    try {
      const text = await this.#magpie.runRaw(args)
      await this.#sendOutput(chatId, `✅ *${escapeMarkdown(label)}*`, text || "（无输出）")
    } catch (err) {
      this.#log.warn(`magpie command failed: ${magpieErrorText(err)}`)
      await this.#sendOutput(chatId, "❌ *magpie 失败*", magpieErrorText(err))
    }
  }

  async #sendOutput(chatId: number, title: string, body: string): Promise<void> {
    const cleaned = body.trim() || "（无输出）"
    const clippedBody = cleaned.length > TEXT_LIMIT ? `${clip(cleaned, TEXT_LIMIT) ?? ""}\n…（已截断）` : cleaned
    await this.#host.sendText(
      chatId,
      `${title}\n\`\`\`\n${clippedBody.replace(/```/g, "'''")}\n\`\`\``,
      this.#backKeyboard(),
    )
  }

  async #unavailable(chatId: number): Promise<void> {
    await this.#host.sendText(
      chatId,
      "magpie 未安装。运行 `curl -fsSL https://usemagpie.ai/install.sh | sh`，或设置 `MAGPIE_BIN` 后重启 Bot。",
    )
  }

  async handleCallback(
    ctx: Context,
    chatId: number,
    rest: string,
    answer: (text?: string) => Promise<void>,
  ): Promise<void> {
    const [kind = "", token = ""] = rest.split(":", 2)
    if (kind === "cfm" || kind === "cnl") {
      await answer()
      const pending = this.#pending.get(token)
      this.#pending.delete(token)
      if (!pending || Date.now() - pending.createdAt > CONFIRM_TTL_MS) {
        await this.#host.sendText(chatId, "⌛ 操作已过期，请重新发起。")
        return
      }
      if (pending.chatId !== chatId) {
        await this.#host.sendText(chatId, "⌛ 该确认按钮不属于当前会话。")
        return
      }
      if (kind === "cnl") {
        await this.#host.sendText(chatId, "已取消。")
        return
      }
      await this.#execute(chatId, pending.label, pending.args)
      return
    }

    await answer()
    if (!kind || kind === "panel") {
      await this.#host.editPanel(ctx, await this.panel(chatId))
      return
    }
    if (kind === "view" && token) {
      await this.#runView(chatId, token, "")
      return
    }
    if (kind === "exec" && token) {
      await this.#runExec(chatId, token, "")
      return
    }
    await this.#host.editPanel(ctx, await this.panel(chatId))
  }

  #prunePending(): void {
    const now = Date.now()
    for (const [token, pending] of this.#pending) {
      if (now - pending.createdAt > CONFIRM_TTL_MS) this.#pending.delete(token)
    }
    while (this.#pending.size >= PENDING_LIMIT) {
      const oldest = this.#pending.keys().next().value
      if (oldest === undefined) break
      this.#pending.delete(oldest)
    }
  }

  #backKeyboard(): InlineKeyboard {
    return new InlineKeyboard().text("⬅️ magpie", "magpie:panel").text("主菜单", "show:menu")
  }
}
