import { InlineKeyboard } from "grammy"
import type { Opencode } from "./opencode.js"
import { escapeMarkdown, type Panel } from "./messages.js"
import { INBOX_RETENTION_MS } from "./attachments.js"
import {
  archiveLiveSession,
  deleteArchivedSession,
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
    return archiveLiveSession(this.#deps.store, this.#deps.archive, this.#deps.oc, key, title)
  }

  /** `/new`: the reply says the old session can be brought back. */
  async newSession(key: string, title?: string): Promise<string> {
    const archived = await this.archiveCurrent(key, title)
    const label = escapeMarkdown(this.#deps.engineLabel(this.#deps.store.getEngine(key)))
    return archived
      ? `✨ *已开启新会话* (当前 Agent: ${label})。\n原会话已存入历史，发送 /sessions 可随时切回。`
      : `✨ *已开启新会话* (当前 Agent: ${label})，对话上下文已清空。`
  }

  panel(key: string, page = 1): Panel {
    const entries = this.#deps.archive.list(key)
    const keyboard = new InlineKeyboard()
    if (entries.length === 0) {
      return {
        text: "🗂 *历史会话*\n\n还没有历史会话。发送 /new 开启新会话时，当前会话会存到这里，之后可以随时切回。",
        keyboard,
      }
    }
    const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE))
    const current = Math.min(Math.max(1, page), pages)
    const slice = entries.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
    const lines = slice.map((entry, index) => {
      const n = (current - 1) * PAGE_SIZE + index + 1
      const title = escapeMarkdown(entry.title ?? "（未命名会话）")
      const model = this.#modelOf(entry)
      const meta = [this.#deps.engineLabel(entry.engine), model, this.#deps.formatTime(entry.archivedAt)]
        .filter(Boolean)
        .map((part) => escapeMarkdown(String(part)))
        .join(" · ")
      return `*${n}.* ${title}\n    _${meta}_`
    })
    for (const [index, entry] of slice.entries()) {
      const n = (current - 1) * PAGE_SIZE + index + 1
      keyboard.text(`↩️ 切回 ${n}`, `sesresume:${entry.id}`).text("🗑", `sesdel:${entry.id}`).row()
    }
    if (pages > 1) {
      if (current > 1) keyboard.text("◀️", `show:sessions:${current - 1}`)
      keyboard.text(`${current}/${pages}`, "noop:sessions")
      if (current < pages) keyboard.text("▶️", `show:sessions:${current + 1}`)
      keyboard.row()
    }
    return {
      text:
        `🗂 *历史会话*（${entries.length}/20）\n切回后接着聊，Agent 记得之前的上下文；当前会话会存入历史。\n\n` +
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
    const { target, parked } = switched
    const model = this.#modelOf(target)
    const stale = staleAttachmentNotice(target, INBOX_RETENTION_MS)
    return {
      ok: true,
      message:
        `↩️ *已切回会话*：${escapeMarkdown(target.title ?? "未命名会话")}\n` +
        `• Agent：${escapeMarkdown(this.#deps.engineLabel(target.engine))}` +
        (model ? `\n• 模型：${escapeMarkdown(model)}` : "") +
        (parked ? "\n刚才的会话已存入历史，发送 /sessions 可切回。" : "") +
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
    const match = /^ses(resume|del):([0-9a-f]{12})$/.exec(data)
    if (!match) return false
    const [, verb, id] = match
    if (verb === "resume") {
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
    return deleteArchivedSession(this.#deps.archive, this.#deps.oc, key, id)
  }

  #modelOf(entry: ArchivedSession): string | undefined {
    return entry.model?.label ?? (entry.cliModel ? this.#deps.modelLabel(entry.engine, entry.cliModel) : undefined)
  }
}
