import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import type { Logger } from "./logger.js"

/**
 * Operator preferences that are neither secrets nor per-session state.
 *
 * Today just the engine a new conversation starts on. It lives in `data/settings.json` rather
 * than `.env` so the App can change it, and it is read on every access because the bridge and
 * the API each hold a store of their own.
 */
export interface Settings {
  /** Engine for a key with no explicit choice; absent means "the first one installed". */
  defaultEngine?: string
  /** Where the OpenCode server listens; absent means "whatever OPENCODE_URL says". */
  opencodeUrl?: string
  /** Push a summary to the paired Telegram/Feishu chat when an App task settles. */
  notifyChatOnAppTask?: boolean
}

export class SettingsStore {
  readonly #path: string
  readonly #log: Logger

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
  }

  get defaultEngine(): string | undefined {
    return this.#load().defaultEngine
  }

  get opencodeUrl(): string | undefined {
    return this.#load().opencodeUrl
  }

  get notifyChatOnAppTask(): boolean {
    return this.#load().notifyChatOnAppTask === true
  }

  setNotifyChatOnAppTask(enabled: boolean): void {
    const next: Settings = { ...this.#load() }
    if (enabled) next.notifyChatOnAppTask = true
    else delete next.notifyChatOnAppTask
    writePrivateAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`)
  }

  /** Passing undefined restores the address from OPENCODE_URL. */
  setOpencodeUrl(url: string | undefined): void {
    const next: Settings = { ...this.#load() }
    if (url) next.opencodeUrl = url
    else delete next.opencodeUrl
    writePrivateAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`)
  }

  /** Passing undefined clears the choice and falls back to "first installed". */
  setDefaultEngine(engine: string | undefined): void {
    const next: Settings = { ...this.#load() }
    if (engine) next.defaultEngine = engine
    else delete next.defaultEngine
    writePrivateAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`)
  }

  #load(): Settings {
    const raw = readJsonObject(this.#path, (message) => this.#log.warn(message))
    return {
      defaultEngine: typeof raw?.defaultEngine === "string" && raw.defaultEngine ? raw.defaultEngine : undefined,
      opencodeUrl: typeof raw?.opencodeUrl === "string" && raw.opencodeUrl ? raw.opencodeUrl : undefined,
      notifyChatOnAppTask: raw?.notifyChatOnAppTask === true ? true : undefined,
    }
  }
}
