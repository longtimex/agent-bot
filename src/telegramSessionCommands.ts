import { InlineKeyboard } from "grammy"
import type { Opencode } from "./opencode.js"
import { escapeMarkdown, type Panel } from "./messages.js"
import { INBOX_RETENTION_MS } from "./attachments.js"
import {
  deleteArchivedSession,
  startNewConversation,
  updateArchivedSession,
  resumeArchivedSession,
  staleAttachmentNotice,
  type ArchivedSession,
  type SessionArchiveStore,
} from "./sessionArchive.js"
import type { SessionStore } from "./store.js"

/**
 * `/new` parks the chat's session instead of deleting it, and `/sessions` switches back, the
 * same way 历史会话 does in the App. Both ends share data/session-archive.json, but each chat
 * only ever sees and resumes its own key's entries.
 */
export interface SessionCommandDeps {
  store: SessionStore
  archive: SessionArchiveStore
  oc: Opencode
  engineLabel: (engine: string) => string
  modelLabel: (engine: string, model: string) => string
  /** True while this chat has a task running or queued: switching then would split its context. */
  busy: (key: string) => boolean
  formatTime: (at: number) => string
}

const PAGE_SIZE = 10

export class TelegramSessionCommands {
  readonly #deps: SessionCommandDeps

  constructor(deps: SessionCommandDeps) {
    this.#deps = deps
  }

  /** Parks the live session; undefined when there was no context to keep. */
  archiveCurrent(key: string, title?: string): Promise<ArchivedSession | undefined> {
    return startNewConversation(this.#deps.store, this.#deps.archive, this.#deps.oc, key, title)
  }

  /** `/new`: the reply says the old session can be brought back. */
  async newSession(key: string, title?: string): Promise<string> {
    const archived = await this.archiveCurrent(key, title)
    const label = escapeMarkdown(this.#deps.engineLabel(this.#deps.store.getEngine(key)))
    return archived
      ? `✨ *已开启新会话* (当前 Agent: ${label})。\n原会话已存入历史，发送 /sessions 可随时切回。`
      : `✨ *已开启新会话* (当前 Agent: ${label})，对话上下文已清空。`
  }

  /** `/sessions`, `/sessions <关键词>` (title search) and `/sessions rename <序号> <名称>`. */
  command(key: string, arg: string): Panel {
    const text = arg.trim()
    const rename = /^(?:rename|改名|重命名)\s+(\d+)\s+(.+)$/i.exec(text)
    if (!rename) return this.panel(key, 1, text || undefined)
    const entry = this.#deps.archive.list(key)[Number(rename[1]) - 1]
    if (!entry) {
      const panel = this.panel(key)
      return { ...panel, text: `⚠️ 没有第 ${rename[1]} 个历史会话。\n\n${panel.text}` }
    }
    const updated = updateArchivedSession(this.#deps.store, this.#deps.archive, key, entry.id, { title: rename[2]! })
    const panel = this.panel(key)
    return { ...panel, text: `✅ 已重命名为「${escapeMarkdown(updated?.title ?? rename[2]!)}」\n\n${panel.text}` }
  }

  panel(key: string, page = 1, query?: string): Panel {
    const all = this.#deps.archive.list(key)
    const keyboard = new InlineKeyboard()
    if (all.length === 0) {
      return {
        text: "🗂 *历史会话*\n\n还没有历史会话。发送 /new 开启新会话时，当前会话会存到这里，之后可以随时切回。",
        keyboard,
      }
    }
    const needle = query?.toLowerCase()
    const entries = needle
      ? all.filter((entry) =>
          [entry.title, this.#deps.engineLabel(entry.engine), this.#modelOf(entry)].some((part) =>
            part?.toLowerCase().includes(needle),
          ),
        )
      : all
    if (entries.length === 0) {
      return { text: `🔎 没有标题包含「${escapeMarkdown(query ?? "")}」的历史会话。发送 /sessions 查看全部。`, keyboard }
    }
    // A search shows its first page only: paging would need the keyword in every button
    const pages = needle ? 1 : Math.max(1, Math.ceil(entries.length / PAGE_SIZE))
    const current = Math.min(Math.max(1, page), pages)
    const slice = entries.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
    const live = this.#deps.store.getArchiveId(key)
    // Numbered by place in the full list, so `/sessions rename N` means the same entry everywhere
    const numberOf = (entry: ArchivedSession): number => all.indexOf(entry) + 1
    const lines = slice.map((entry) => {
      const title =
        (entry.pinned ? "📌 " : "") + escapeMarkdown(entry.title ?? "（未命名会话）") + (live === entry.id ? " ✅ 当前" : "")
      const meta = [this.#deps.engineLabel(entry.engine), this.#modelOf(entry), this.#deps.formatTime(entry.archivedAt)]
        .filter(Boolean)
        .map((part) => escapeMarkdown(String(part)))
        .join(" · ")
      return `*${numberOf(entry)}.* ${title}\n    _${meta}_`
    })
    for (const entry of slice) {
      const n = numberOf(entry)
      if (live === entry.id) keyboard.text(`✅ ${n} 当前`, "noop:sessions")
      else keyboard.text(`↩️ 切回 ${n}`, `sesresume:${entry.id}`)
      keyboard.text(entry.pinned ? "📍 取消置顶" : "📌", `sespin:${entry.id}`)
      keyboard.text("🗑", `sesdel:${entry.id}`).row()
    }
    if (pages > 1) {
      if (current > 1) keyboard.text("◀️", `show:sessions:${current - 1}`)
      keyboard.text(`${current}/${pages}`, "noop:sessions")
      if (current < pages) keyboard.text("▶️", `show:sessions:${current + 1}`)
      keyboard.row()
    }
    const heading = needle
      ? `🔎 *历史会话搜索*「${escapeMarkdown(query ?? "")}」：${entries.length} 个`
      : `🗂 *历史会话*（${all.length}/20）`
    return {
      text:
        `${heading}\n切回后接着聊；📌 置顶的不会被自动清理。\n` +
        "改名：`/sessions rename 序号 新名称` · 搜索：`/sessions 关键词`\n\n" +
        lines.join("\n"),
      keyboard,
    }
  }

  /** Switches back; the open session is parked in its place so neither side is lost. */
  async resume(key: string, id: string): Promise<{ ok: boolean; message: string }> {
    if (this.#deps.busy(key)) return { ok: false, message: "任务执行中，请先 /stop 再切换会话" }
    const { store, archive, oc } = this.#deps
    const switched = await resumeArchivedSession(store, archive, oc, key, id)
    if (!switched) return { ok: false, message: "该历史会话已不存在" }
    const { target, parked, alreadyCurrent } = switched
    if (alreadyCurrent) return { ok: false, message: "这就是当前会话" }
    const model = this.#modelOf(target)
    const stale = staleAttachmentNotice(target, INBOX_RETENTION_MS)
    return {
      ok: true,
      message:
        `↩️ *已切回会话*：${escapeMarkdown(target.title ?? "未命名会话")}\n` +
        `• Agent：${escapeMarkdown(this.#deps.engineLabel(target.engine))}` +
        (model ? `\n• 模型：${escapeMarkdown(model)}` : "") +
        (parked ? "\n刚才的会话已存入历史，发送 /sessions 可切回。" : "") +
        (target.sessionID ? "" : "\n该会话当时没有保存上下文，Agent 会从头开始。") +
        (stale ? `\n📎 ${escapeMarkdown(stale)}` : ""),
    }
  }

  /** `sesresume:<id>` / `sesdel:<id>` from the panel; false when the data is not ours. */
  async callback(
    data: string,
    key: string,
    answer: (text?: string) => Promise<void>,
    send: (text: string) => Promise<unknown>,
    refresh: (panel: Panel) => Promise<void>,
  ): Promise<boolean> {
    const match = /^ses(resume|del|pin):([0-9a-f]{12})$/.exec(data)
    if (!match) return false
    const [, verb, id] = match
    if (verb === "pin") {
      const entry = this.#deps.archive.get(key, id!)
      const updated = entry && updateArchivedSession(this.#deps.store, this.#deps.archive, key, id!, { pinned: !entry.pinned })
      await answer(!updated ? "该历史会话已不存在" : updated.pinned ? "已置顶" : "已取消置顶")
    } else if (verb === "resume") {
      const result = await this.resume(key, id!)
      await answer(result.ok ? "已切回" : result.message)
      if (result.ok) await send(result.message)
    } else {
      await answer((await this.remove(key, id!)) ? "已删除历史会话" : "该历史会话已不存在")
    }
    await refresh(this.panel(key))
    return true
  }

  remove(key: string, id: string): Promise<boolean> {
    return deleteArchivedSession(this.#deps.archive, this.#deps.oc, key, id, this.#deps.store)
  }

  #modelOf(entry: ArchivedSession): string | undefined {
    return entry.model?.label ?? (entry.cliModel ? this.#deps.modelLabel(entry.engine, entry.cliModel) : undefined)
  }
}
