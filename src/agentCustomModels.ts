import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import { asRecord } from "./util.js"
import type { Logger } from "./logger.js"

/**
 * Model ids an operator adds by hand for a CLI engine.
 *
 * A CLI takes the model name as a plain `--model` argument, so a provider that ships a new
 * model before this bot's built-in table knows about it can still be picked. Discovery results
 * win over a hand-written entry with the same value, because the CLI's own list is authoritative
 * about which names exist on that machine.
 */
export interface CustomAgentModel {
  /** What gets passed to the CLI; the only field that matters at run time. */
  value: string
  label: string
}

const MAX_PER_ENGINE = 40
const VALUE_MAX = 120
const LABEL_MAX = 60

export class AgentCustomModelStore {
  readonly #path: string
  readonly #log: Logger

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
  }

  all(): Record<string, CustomAgentModel[]> {
    return this.#load()
  }

  list(engine: string): CustomAgentModel[] {
    return this.#load()[engine] ?? []
  }

  add(engine: string, model: CustomAgentModel): CustomAgentModel[] {
    const value = model.value.trim().slice(0, VALUE_MAX)
    const label = model.label.trim().slice(0, LABEL_MAX) || value
    if (!value) throw new Error("模型 ID 不能为空")
    const data = this.#load()
    const current = data[engine] ?? []
    // Re-adding the same value updates its label instead of creating a duplicate entry
    const next = [...current.filter((entry) => entry.value !== value), { value, label }].slice(-MAX_PER_ENGINE)
    data[engine] = next
    this.#save(data)
    return next
  }

  remove(engine: string, value: string): boolean {
    const data = this.#load()
    const current = data[engine] ?? []
    const next = current.filter((entry) => entry.value !== value)
    if (next.length === current.length) return false
    if (next.length > 0) data[engine] = next
    else delete data[engine]
    this.#save(data)
    return true
  }

  #load(): Record<string, CustomAgentModel[]> {
    const raw = readJsonObject(this.#path, (message) => this.#log.warn(message))
    const engines = asRecord(raw?.engines)
    if (!engines) return {}
    const result: Record<string, CustomAgentModel[]> = {}
    for (const [engine, entries] of Object.entries(engines)) {
      if (!Array.isArray(entries)) continue
      const models: CustomAgentModel[] = []
      for (const entry of entries) {
        const record = asRecord(entry)
        const value = typeof record?.value === "string" ? record.value.trim() : ""
        if (!value) continue
        models.push({ value, label: typeof record?.label === "string" && record.label ? record.label : value })
      }
      if (models.length > 0) result[engine] = models.slice(-MAX_PER_ENGINE)
    }
    return result
  }

  #save(data: Record<string, CustomAgentModel[]>): void {
    writePrivateAtomic(
      this.#path,
      `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), engines: data }, null, 2)}\n`,
    )
  }
}
