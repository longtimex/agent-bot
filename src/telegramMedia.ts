import { InputFile, type Bot, type InlineKeyboard } from "grammy"
import { Agent, fetch as undiciFetch } from "undici"
import { redactSecrets } from "./ccswitch.js"
import type { BotConfig } from "./config.js"
import type { Logger } from "./logger.js"
import {
  assertUrlAllowed,
  mediaLabel,
  parseReply,
  pinnedLookup,
  resolveMedia,
  safeMediaTarget,
  type ReplyPart,
} from "./media.js"
import { escapeMarkdown, splitMessage } from "./messages.js"
import type { ProxyService } from "./proxy.js"
import type { Job } from "./telegram.js"
import { sleep } from "./telegramSupport.js"

const CHUNK_DELAY_MS = 250
const TELEGRAM_MAX_TEXT = 4000

export interface MediaSenderDeps {
  bot: Bot
  cfg: BotConfig
  proxies: ProxyService
  log: Logger
  sendText: (chatId: number, text: string, keyboard?: InlineKeyboard) => Promise<unknown>
}

export class TelegramMediaSender {
  readonly #deps: MediaSenderDeps

  constructor(deps: MediaSenderDeps) {
    this.#deps = deps
  }

  async sendReply(job: Job, reply: string): Promise<void> {
    const { parts, dropped } = parseReply(reply || "")
    if (dropped > 0) {
      this.#deps.log.warn(`ignored ${dropped} media directive(s) [${job.key}]`)
    }
    if (parts.length === 0) {
      parts.push({ type: "text", text: "（模型没有返回内容）" })
    }

    for (const part of parts) {
      if (part.type === "text") {
        const chunks = splitMessage(part.text, Math.min(this.#deps.cfg.maxReplyLength, TELEGRAM_MAX_TEXT))
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i] as string
          if (!(await this.#deps.sendText(job.chatId, chunk))) {
            await sleep(500)
            if (!(await this.#deps.sendText(job.chatId, chunk))) {
              this.#deps.log.warn(`failed to deliver reply chunk ${i + 1}/${chunks.length} [${job.key}]`)
            }
          }
          if (i < chunks.length - 1) await sleep(CHUNK_DELAY_MS)
        }
      } else {
        await this.sendMediaPart(job, part)
      }
      await sleep(CHUNK_DELAY_MS)
    }
  }

  async sendMediaPart(job: Job, part: Extract<ReplyPart, { type: "media" }>): Promise<void> {
    try {
      const media = resolveMedia(part.kind, part.target, this.#deps.cfg.outboxDir, this.#deps.cfg.maxMediaBytes)
      const size = media.size > 0 ? ` ${Math.round(media.size / 1024)}KB` : ""
      this.#deps.log.info(`media [${job.key}] ${part.kind} ${media.name}${size}`)

      let buffer: Buffer | undefined
      if (media.isUrl) {
        buffer = await this.fetchRemoteMedia(media.target)
      }

      if (part.kind === "image") {
        try {
          if (buffer) {
            await this.#deps.bot.api.sendPhoto(job.chatId, new InputFile(buffer, media.name))
          } else if (media.hostPath) {
            await this.#deps.bot.api.sendPhoto(job.chatId, new InputFile(media.hostPath))
          }
        } catch (photoErr) {
          this.#deps.log.warn(`sendPhoto failed (${(photoErr as Error).message}), falling back to sendDocument`)
          if (buffer) {
            await this.#deps.bot.api.sendDocument(job.chatId, new InputFile(buffer, media.name))
          } else if (media.hostPath) {
            await this.#deps.bot.api.sendDocument(job.chatId, new InputFile(media.hostPath, media.name))
          }
        }
      } else if (part.kind === "voice") {
        try {
          if (buffer) {
            await this.#deps.bot.api.sendVoice(job.chatId, new InputFile(buffer, media.name))
          } else if (media.hostPath) {
            await this.#deps.bot.api.sendVoice(job.chatId, new InputFile(media.hostPath))
          }
        } catch (voiceErr) {
          this.#deps.log.warn(`sendVoice failed (${(voiceErr as Error).message}), falling back to sendDocument`)
          if (buffer) {
            await this.#deps.bot.api.sendDocument(job.chatId, new InputFile(buffer, media.name))
          } else if (media.hostPath) {
            await this.#deps.bot.api.sendDocument(job.chatId, new InputFile(media.hostPath, media.name))
          }
        }
      } else if (part.kind === "video") {
        try {
          if (buffer) {
            await this.#deps.bot.api.sendVideo(job.chatId, new InputFile(buffer, media.name))
          } else if (media.hostPath) {
            await this.#deps.bot.api.sendVideo(job.chatId, new InputFile(media.hostPath))
          }
        } catch (videoErr) {
          this.#deps.log.warn(`sendVideo failed (${(videoErr as Error).message}), falling back to sendDocument`)
          if (buffer) {
            await this.#deps.bot.api.sendDocument(job.chatId, new InputFile(buffer, media.name))
          } else if (media.hostPath) {
            await this.#deps.bot.api.sendDocument(job.chatId, new InputFile(media.hostPath, media.name))
          }
        }
      } else if (part.kind === "file") {
        if (buffer) {
          await this.#deps.bot.api.sendDocument(job.chatId, new InputFile(buffer, media.name))
        } else if (media.hostPath) {
          await this.#deps.bot.api.sendDocument(job.chatId, new InputFile(media.hostPath, media.name))
        }
      }
    } catch (err) {
      // The detail is CLI/HTTP text: it can carry Markdown markers and a signed URL
      const detail = escapeMarkdown(redactSecrets(err instanceof Error ? err.message : String(err)))
      this.#deps.log.error(`media failed [${job.key}] ${part.kind}:`, detail)
      await this.#deps.sendText(job.chatId, `⚠️ ${mediaLabel(part.kind)}发送失败：${detail}`)
    }
  }

  async fetchRemoteMedia(target: string): Promise<Buffer> {
    let current = target
    for (let hop = 0; ; hop++) {
      const { url, pins } = await assertUrlAllowed(current, this.#deps.cfg.mediaAllowPrivateUrls)
      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
      }
      // Re-resolving DNS here would allow a rebinding to an internal host, so a
      // validated hostname is pinned to the addresses that passed the check.
      // Pinning only applies to a direct connection: a proxy resolves the name
      // on its own network, so the private-address check above is the only guard
      // there and a proxy the bot cannot reach (e.g. someone else's) stays unsafe.
      const viaProxy = this.#deps.proxies.dispatcher()
      const pinned = viaProxy || pins.length === 0 ? undefined : new Agent({ connect: { lookup: pinnedLookup(url.hostname, pins) } })
      const dispatcher = viaProxy ?? pinned
      try {
        const res = dispatcher
          ? await undiciFetch(url, {
              headers,
              redirect: "manual",
              signal: AbortSignal.timeout(20_000),
              dispatcher,
            })
          : await fetch(url, {
              headers,
              redirect: "manual",
              signal: AbortSignal.timeout(20_000),
            })

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location")
          await res.body?.cancel().catch(() => {})
          if (!location || hop >= 3) throw new Error("媒体链接重定向次数过多")
          current = new URL(location, url).toString()
          continue
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {})
          throw new Error(`无法获取远程地址 (HTTP ${res.status}): ${safeMediaTarget(target)}`)
        }
        return await this.readCappedBody(res)
      } finally {
        if (pinned) await pinned.close().catch(() => {})
      }
    }
  }

  async readCappedBody(res: {
    headers: { get(name: string): string | null }
    body: {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>
        cancel(reason?: unknown): Promise<void>
        releaseLock(): void
      }
    } | null
  }): Promise<Buffer> {
    const limit = this.#deps.cfg.maxMediaBytes
    const declared = Number(res.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > limit) {
      throw new Error(`远程文件超过 ${Math.round(limit / 1024 / 1024)}MB 限制`)
    }
    if (!res.body) throw new Error("远程响应为空")

    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > limit) {
          await reader.cancel().catch(() => {})
          throw new Error(`远程文件超过 ${Math.round(limit / 1024 / 1024)}MB 限制`)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, total)
  }

}
