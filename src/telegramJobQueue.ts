import type { AttachmentDescriptor } from "./attachments.js"
import { JobJournal, RESUME_MAX_AGE_MS, type JournalEntry } from "./jobJournal.js"
import type { Logger } from "./logger.js"
import { escapeMarkdown } from "./messages.js"
import { carriesInlineSecret } from "./telegramSecretInput.js"
import type { Job } from "./telegram.js"

/** What survives a restart: the job minus in-memory handles (generation, id, callbacks). */
export type StoredJob = Pick<Job, "key" | "text" | "chatId" | "userId" | "attachments" | "engine" | "model" | "cliModel" | "retryOf">

export interface QueueRecoveryHost {
  enqueue: (job: StoredJob) => void
  send: (chatId: number, text: string) => Promise<unknown>
  /** Makes /retry replay an interrupted task. */
  remember: (key: string, prompt: { text: string; attachments?: AttachmentDescriptor[] }) => void
}

const EXCERPT = 40

/** The Telegram/Feishu side of the queue journal; see jobJournal.ts for the policy. */
export class TelegramJobJournal {
  readonly #journal: JobJournal<StoredJob>
  readonly #log: Logger

  constructor(path: string, log: Logger) {
    this.#journal = new JobJournal<StoredJob>(path, log)
    this.#log = log
  }

  track(job: Job): void {
    // The scheduler re-runs its own prompts, and whoever waits on onOutcome is gone after a restart
    if (!job.id || job.scheduled || job.onOutcome) return
    // A command with a key in it (/cc provider add … key=…) must never be written to disk
    if (carriesInlineSecret(job.text)) return
    this.#journal.track(job.id, {
      key: job.key,
      text: job.text,
      chatId: job.chatId,
      userId: job.userId,
      ...(job.attachments?.length ? { attachments: job.attachments } : {}),
      ...(job.engine ? { engine: job.engine } : {}),
      ...(job.model ? { model: job.model } : {}),
      ...(job.cliModel ? { cliModel: job.cliModel } : {}),
      ...(job.retryOf ? { retryOf: job.retryOf } : {}),
    })
  }

  started(job: Job): void {
    if (job.id) this.#journal.started(job.id)
  }

  finished(job: Job): void {
    if (job.id) this.#journal.finished(job.id)
  }

  dropQueued(key: string): void {
    this.#journal.dropQueued((job) => job.key === key)
  }

  /** Runs once the bot can send: one notice per chat first, then the recent messages resume in order. */
  async recover(
    host: QueueRecoveryHost,
    now = Date.now(),
    match?: (job: StoredJob) => boolean,
  ): Promise<void> {
    const plan = this.#journal.peekRecovery(now, RESUME_MAX_AGE_MS, match)
    const chats = new Map<
      number,
      { resume: StoredJob[]; interrupted: StoredJob[]; expired: StoredJob[]; ids: string[] }
    >()
    const bucket = (job: StoredJob) => {
      let found = chats.get(job.chatId)
      if (!found) chats.set(job.chatId, (found = { resume: [], interrupted: [], expired: [], ids: [] }))
      return found
    }
    const each = (entries: JournalEntry<StoredJob>[], pick: "resume" | "interrupted" | "expired") => {
      for (const entry of entries) {
        const group = bucket(entry.payload)
        group[pick].push(entry.payload)
        group.ids.push(entry.id)
      }
    }
    each(plan.resume, "resume")
    each(plan.interrupted, "interrupted")
    each(plan.expired, "expired")
    if (chats.size === 0) return
    this.#log.info(
      `queue journal: ${plan.resume.length} resumed, ${plan.interrupted.length} interrupted, ${plan.expired.length} expired`,
    )

    for (const [chatId, found] of chats) {
      // The newest interrupted prompt becomes the /retry target; a command is not something to replay
      for (const job of found.interrupted) {
        const prompt = job.retryOf ?? { text: job.text, attachments: job.attachments }
        if (!prompt.text.startsWith("/") || prompt.attachments?.length) host.remember(job.key, prompt)
      }
      try {
        await host.send(chatId, recoveryNotice(found))
      } catch (err) {
        this.#log.warn("failed to send the queue recovery notice:", (err as Error).message)
      }
      // Enqueue (which tracks fresh entries on disk) BEFORE removing the previous-process
      // records, so a crash mid-recovery never loses resumed jobs.
      for (const job of found.resume) host.enqueue(job)
      this.#journal.completeRecovery(found.ids)
    }
  }
}

export function recoveryNotice(found: { resume: StoredJob[]; interrupted: StoredJob[]; expired: StoredJob[] }): string {
  const lines = ["🔄 服务刚刚重启。"]
  if (found.interrupted.length > 0) {
    lines.push(`• 重启时正在执行的任务被中断，没有自动重跑（可能已改过文件或产生费用）：${quote(found.interrupted.at(-1)!)}`)
    lines.push("  需要的话发送 /retry 重新执行。")
  }
  if (found.resume.length > 0) lines.push(`• 重启前排队的 ${found.resume.length} 条消息现在继续执行。`)
  if (found.expired.length > 0) {
    const minutes = Math.round(RESUME_MAX_AGE_MS / 60_000)
    lines.push(`• 排队超过 ${minutes} 分钟的 ${found.expired.length} 条消息没有自动执行，需要的话请重新发送：`)
    for (const job of found.expired.slice(0, 5)) lines.push(`  - ${quote(job)}`)
    if (found.expired.length > 5) lines.push(`  - …另有 ${found.expired.length - 5} 条`)
  }
  return lines.join("\n")
}

function quote(job: StoredJob): string {
  const source = job.retryOf?.text ?? job.text
  const plain = source.replace(/\s+/g, " ").trim()
  const text = plain.length > EXCERPT ? `${plain.slice(0, EXCERPT)}…` : plain
  if (text) return `「${escapeMarkdown(text)}」`
  return job.attachments?.length ? `（${job.attachments.length} 个附件）` : "（空消息）"
}

export interface QueueButtonDeps {
  key: string
  answer: (text?: string) => Promise<void>
  pending: Map<string, Job[]>
  generation?: Map<string, number>
  journal: TelegramJobJournal
}

/**
 * The queue panel's 取消这条 / 清空排队 buttons. Returns "edit" when the panel should be redrawn,
 * "done" when the button was handled without a change, undefined when it is not a queue button.
 */
export async function handleQueueButton(data: string, deps: QueueButtonDeps): Promise<"edit" | "done" | undefined> {
  const { key, answer, pending } = deps
  const queueDrop = /^qdrop:(q\d+)$/.exec(data)
  if (queueDrop) {
    const items = pending.get(key) ?? []
    const index = items.findIndex((job) => job.id === queueDrop[1])
    if (index < 0) {
      await answer("这条消息已开始执行，或已被取消")
      return "edit"
    }
    const [job] = items.splice(index, 1)
    if (job) {
      job.dropped = true
      deps.journal.finished(job)
    }
    if (items.length === 0) pending.delete(key)
    await answer(`已取消第 ${index + 1} 条`)
    return "edit"
  }
  if (data === "qclear") {
    const items = pending.get(key) ?? []
    const count = items.length
    if (count === 0) {
      await answer("队列已经是空的")
      return "done"
    }
    // Mark every queued job dropped instead of bumping generation so a running task
    // currently choosing its engine is not cancelled as stale.
    for (const job of items) job.dropped = true
    pending.delete(key)
    deps.journal.dropQueued(key)
    await answer(`已清空 ${count} 条排队消息`)
    return "edit"
  }
  return undefined
}
