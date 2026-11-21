import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import process from "node:process"
import { StringDecoder } from "node:string_decoder"
import { asRecord } from "./util.js"
import type { AgentCliProfile, AgentCliRegistry } from "./agentCli.js"
import type { AgentModelProbeFormat } from "./agentModelProbe.js"
import { childEnv } from "./binPath.js"
import { redactSecrets, stripAnsi } from "./ccswitch.js"
import { terminateProcess } from "./childKill.js"
import type { Logger } from "./logger.js"
import { clipTail } from "./messages.js"

const DEFAULT_PROBE_TIMEOUT_MS = 15_000
const DEFAULT_CACHE_TTL_MS = 60_000
// `codex debug models` includes megabytes of model instructions. capping at 512 KiB kept
// only that tail and cut off before the closing JSON, so raise the cap for that CLI.
const MAX_PROBE_OUTPUT = 4 * 1024 * 1024
const MAX_MODELS = 200

export interface AgentModelCatalogEntry {
  id: string
  label: string
  desc?: string
  aliases?: string[]
}

export interface AgentModelCatalogResult {
  models: AgentModelCatalogEntry[]
  /** Why no models could be listed, or that the CLI has no list command at all. */
  hint?: string
  source: "probe" | "configured" | "none"
  checkedAt?: string
  stale?: boolean
}

export interface AgentModelProbeResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
}

export interface AgentModelCatalogOptions {
  log?: Logger
  /** Test seam: returns the executable path for a profile, or undefined when absent. */
  which?: (profile: AgentCliProfile) => string | undefined
  /** Test seam: runs one fixed probe argv in a child process. */
  run?: (
    profile: AgentCliProfile,
    binPath: string,
    args: string[],
    timeoutMs: number,
    env: Record<string, string>,
  ) => Promise<AgentModelProbeResult>
  env?: () => Record<string, string>
  cacheTtlMs?: number
  now?: () => number
}

interface CacheEntry {
  at: number
  result: AgentModelCatalogResult
}

interface PendingProbe {
  promise: Promise<AgentModelCatalogResult>
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
  return items.length === value.length ? items.map((item) => item.trim()) : undefined
}

function dedupe(models: AgentModelCatalogEntry[]): AgentModelCatalogEntry[] {
  const seen = new Set<string>()
  const result: AgentModelCatalogEntry[] = []
  for (const model of models) {
    const id = model.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push({ ...model, id, label: model.label.trim() || id })
    if (result.length >= MAX_MODELS) break
  }
  return result
}

function entryFromRecord(record: Record<string, unknown>): AgentModelCatalogEntry | undefined {
  const id =
    textValue(record.id) ??
    textValue(record.slug) ??
    textValue(record.model) ??
    textValue(record.modelId) ??
    textValue(record.model_id) ??
    textValue(record.key) ??
    textValue(record.value)
  if (!id) return undefined
  const label =
    textValue(record.display_name) ??
    textValue(record.displayName) ??
    textValue(record.name) ??
    textValue(record.label) ??
    textValue(record.title) ??
    id
  return {
    id,
    label,
    desc: textValue(record.description) ?? textValue(record.desc),
    aliases: stringList(record.aliases),
  }
}

function hasModelId(record: Record<string, unknown>): boolean {
  return Boolean(
    textValue(record.id) ??
    textValue(record.slug) ??
    textValue(record.model) ??
    textValue(record.modelId) ??
    textValue(record.model_id),
  )
}

/** Parses the shapes emitted by Codex, Gemini, Qoder and common JSON model lists. */
export function parseAgentModelJson(raw: string): AgentModelCatalogEntry[] | undefined {
  const text = stripAnsi(raw).trim()
  if (!text) return undefined
  const candidates: unknown[] = []
  try {
    candidates.push(JSON.parse(text))
  } catch {
    for (const line of text.split("\n").reverse()) {
      const value = line.trim()
      if (!value.startsWith("{") && !value.startsWith("[")) continue
      try {
        candidates.push(JSON.parse(value))
        break
      } catch {
        // keep scanning
      }
    }
  }

  for (const candidate of candidates) {
    const record = asRecord(candidate)
    const direct = Array.isArray(candidate) ? candidate : undefined
    const list = direct
      ? direct
      : Array.isArray(record?.models)
        ? record.models
        : Array.isArray(record?.data)
          ? record.data
          : Array.isArray(record?.items)
            ? record.items
            : undefined
    if (!list) {
      // Some CLIs wrap a single model in an object instead of an array. Require an id-like
      // field so arbitrary JSON (errors, logs, a skill prompt inside a wrapper) is not a model.
      if (!record || !hasModelId(record)) continue
      const single = entryFromRecord(record)
      if (!single) continue
      return [single]
    }
    const models: AgentModelCatalogEntry[] = []
    for (const item of list) {
      if (typeof item === "string") {
        if (item.trim()) models.push({ id: item.trim(), label: item.trim() })
        continue
      }
      const row = asRecord(item)
      if (!row) continue
      const entry = entryFromRecord(row)
      if (!entry) continue
      // Only an explicit hide drops a row. Codex marks its internal models "hide", but other
      // CLIs use this field for their own vocabulary ("public", "default"…), and treating an
      // unknown word as hidden would empty the panel for an account that has models.
      const visibility = textValue(row.visibility)
      if (visibility && /^(hide|hidden)$/i.test(visibility)) continue
      models.push(entry)
    }
    return dedupe(models)
  }
  return undefined
}

/** One model per line; table/preamble lines are ignored rather than guessed at. */
export function parseAgentModelLines(raw: string): AgentModelCatalogEntry[] {
  const models: AgentModelCatalogEntry[] = []
  for (const original of stripAnsi(raw).split("\n")) {
    let line = original.trim()
    if (!line || /^warning\b/i.test(line) || /^error\b/i.test(line)) continue
    if (/^(available models|models|model( id)?|name|id)\b:?\s*$/i.test(line)) continue
    if (/^[-=]{3,}$/.test(line)) continue
    line = line.replace(/^[*•-]\s+/, "").replace(/^[✓✔✅]\s*/, "")
    const columns = line.split(/\s{2,}|\t+/).filter(Boolean)
    if (columns.length === 0) continue
    const id = columns[0]!.replace(/[`"']/g, "").trim()
    if (!id || id.length > 200 || /\s/.test(id)) continue
    if (/^(usage|description|context|provider|model)$/i.test(id)) continue
    models.push({ id, label: columns.length > 1 ? columns.slice(1).join(" ").trim() : id })
  }
  return dedupe(models)
}

export function parseAgentModelOutput(
  raw: string,
  format: AgentModelProbeFormat = "auto",
): AgentModelCatalogEntry[] | undefined {
  if (format !== "lines") {
    const json = parseAgentModelJson(raw)
    if (json) return json
  }
  if (format === "json") return undefined
  return parseAgentModelLines(raw)
}

function failureHint(result: AgentModelProbeResult, bin: string): string {
  if (result.timedOut) return `${bin} 查询模型超时。`
  const detail = redactSecrets(stripAnsi(`${result.stderr}\n${result.stdout}`)).trim()
  if (detail) return clipTail(detail.split("\n").slice(-3).join(" "), 500)
  if (result.code !== 0) return `${bin} 查询模型失败（退出码 ${result.code ?? "未知"}）。`
  return `${bin} 没有返回可识别的模型列表。`
}

function runProbe(
  binPath: string,
  args: string[],
  timeoutMs: number,
  env: Record<string, string>,
): Promise<AgentModelProbeResult> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    let drainTimer: NodeJS.Timeout | undefined
    let child: ChildProcess
    try {
      child = spawn(binPath, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true })
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) })
      return
    }
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ code, stdout, stderr, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminateProcess(child)
      finish(null)
    }, timeoutMs)
    const out = new StringDecoder("utf8")
    const err = new StringDecoder("utf8")
    const armDrain = (): void => {
      if (drainTimer) clearTimeout(drainTimer)
      drainTimer = setTimeout(() => finish(child.exitCode), 1_000)
      drainTimer.unref()
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = clipTail(stdout + out.write(chunk), MAX_PROBE_OUTPUT)
      armDrain()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = clipTail(stderr + err.write(chunk), MAX_PROBE_OUTPUT)
      armDrain()
    })
    child.once("error", (error) => {
      if (settled) return
      clearTimeout(timer)
      settled = true
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`.trim() })
    })
    child.once("exit", (code) => {
      armDrain()
      // A helper may keep the pipes open; the executable itself has exited.
      finish(code)
    })
  })
}

/** Same safety rule as AgentCliRegistry.resolveModel: never inject an argv flag. */
export function isSafeModelId(value: string): boolean {
  return /^(?!-)[^\x00-\x1F\x7F]{1,120}$/.test(value)
}

/**
 * Resolves the model list from the Agent itself. Built-in profiles carry only a fixed probe
 * command; their former hand-maintained lists are deliberately not used as a fallback because
 * they do not represent what the current account can actually run.
 */
export class AgentModelCatalog {
  readonly #registry: AgentCliRegistry
  readonly #log?: Logger
  readonly #which: (profile: AgentCliProfile) => string | undefined
  readonly #run: AgentModelCatalogOptions["run"]
  readonly #env: () => Record<string, string>
  readonly #cacheTtlMs: number
  readonly #now: () => number
  readonly #cache = new Map<string, CacheEntry>()
  readonly #pending = new Map<string, PendingProbe>()

  constructor(registry: AgentCliRegistry, options: AgentModelCatalogOptions = {}) {
    this.#registry = registry
    this.#log = options.log
    this.#which = options.which ?? ((profile) => registry.binPath(profile))
    this.#run = options.run
    this.#env = options.env ?? (() => childEnv(process.env) as Record<string, string>)
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.#now = options.now ?? (() => Date.now())
  }

  /** Live models for one profile, regardless of whether the command exists on this host. */
  async list(engine: string, force = false): Promise<AgentModelCatalogResult> {
    const profile = this.#registry.get(engine)
    if (!profile) return { models: [], source: "none", hint: `未知的 Agent 引擎：${engine}` }
    if (!profile.supportsModel) return { models: [], source: "none", hint: `${profile.label} 不支持切换模型。` }

    const cached = this.#cache.get(profile.id)
    if (!force && cached && this.#now() - cached.at < this.#cacheTtlMs) {
      return { ...cached.result, models: [...cached.result.models] }
    }
    const pending = this.#pending.get(profile.id)
    if (!force && pending) return pending.promise

    const promise = this.#discover(profile)
      .then((result) => {
        this.#cache.set(profile.id, { at: this.#now(), result })
        return result
      })
      .finally(() => this.#pending.delete(profile.id))
    this.#pending.set(profile.id, { promise })
    return promise
  }

  /** Synchronous label lookup, used only for a selection already stored in a session. */
  label(engine: string, model: string): string {
    const cached = this.#cache.get(engine)
    const configured = this.#registry.get(engine)?.models
    return cached?.result.models.find((item) => item.id === model)?.label
      ?? configured?.find((item) => item.id === model)?.label
      ?? model
  }

  /** Whether a word names a listed model (id, label or alias), case-insensitively. */
  declares(engine: string, raw: string): boolean {
    return Boolean(this.match(engine, raw))
  }

  /** Resolves a user word against the cached live list, falling back to a safe passthrough. */
  resolve(engine: string, raw: string): string | undefined {
    const match = this.match(engine, raw)
    if (match) return match.id
    const profile = this.#registry.get(engine)
    if (!profile || !profile.supportsModel) return undefined
    const value = raw.trim()
    if (!value) return undefined
    // A probe can legitimately have no rows (an account with no access), and a declared
    // list is only a shortcut, so an id the CLI understands is always allowed through.
    return isSafeModelId(value) ? value : undefined
  }

  /** Positional fallback for a callback drawn before ids fit in Telegram's data limit. */
  findIndex(engine: string, index: number): string | undefined {
    return this.#cache.get(engine)?.result.models[index]?.id
      ?? this.#registry.get(engine)?.models?.[index]?.id
  }

  /** Cached entry for a stored id. Never probes: panels and status lines stay synchronous. */
  find(engine: string, model: string): AgentModelCatalogEntry | undefined {
    const cached = this.#cache.get(engine)?.result.models.find((item) => item.id === model)
    if (cached) return cached
    return this.#registry.get(engine)?.models?.find((item) => item.id === model)
  }

  private match(engine: string, raw: string): AgentModelCatalogEntry | undefined {
    const value = raw.trim().toLowerCase()
    if (!value) return undefined
    const exact = (candidate: string): boolean => candidate.toLowerCase() === value
    const sources = [
      ...(this.#cache.get(engine)?.result.models ?? []),
      ...(this.#registry.get(engine)?.models ?? []),
    ]
    for (const model of sources) {
      if (exact(model.id) || exact(model.label)) return model
    }
    for (const model of sources) {
      if (model.aliases?.some(exact)) return model
    }
    return undefined
  }

  /** Drops cached catalogs (e.g. after an agent install/update). */
  clear(engine?: string): void {
    if (engine) this.#cache.delete(engine)
    else this.#cache.clear()
  }

  /**
   * Models a CLI declares in its own config file. `codex debug models` lists the vendor
   * catalogue, which never includes a model the operator pointed at a relay — that name only
   * exists in `~/.codex/config.toml`, so a probe alone would hide the one model in use.
   */
  #configModels(profile: AgentCliProfile): Array<{ id: string; label: string; desc?: string }> {
    if (profile.id !== "codex") return []
    const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")
    let text: string
    try {
      text = readFileSync(join(home, "config.toml"), "utf8")
    } catch {
      return []
    }
    const found: Array<{ id: string; label: string; desc?: string }> = []
    const push = (id: string, desc: string): void => {
      const value = id.trim()
      if (!value || found.some((entry) => entry.id === value)) return
      found.push({ id: value, label: value, desc })
    }
    const active = /^\s*model\s*=\s*"([^"]+)"/m.exec(text)
    if (active?.[1]) push(active[1], "来自 codex config.toml")
    // A named profile carries its own model; those are selectable with `codex -p <name>`
    for (const block of text.matchAll(/\[profiles\.([^\]]+)\]([\s\S]*?)(?=\n\[|$)/g)) {
      const name = block[1]?.trim()
      const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(block[2] ?? "")
      if (name && model?.[1]) push(model[1], `codex profile ${name}`)
    }
    return found
  }

  async #discover(profile: AgentCliProfile): Promise<AgentModelCatalogResult> {
    const binPath = this.#which(profile)
    // A custom profile without a usable probe owns its explicit catalogue. This also
    // covers a profile that declares both while its binary is not installed on this host.
    // Built-in profiles have no such list anymore, so this never resurrects a stale builtin.
    if ((!profile.modelProbe || !binPath) && profile.models?.length) {
      // The catalogue is the profile's own declaration, so it stays visible either way —
      // but a missing binary must say so, otherwise a tap can only fail at spawn time.
      const missing = binPath ? undefined : `未检测到 ${profile.bin}，以下模型来自 profile 配置，安装后才能使用。`
      return {
        models: profile.models,
        source: "configured",
        hint: [missing, profile.modelHint].filter(Boolean).join(" ") || undefined,
      }
    }
    if (!binPath) {
      return {
        models: [],
        source: "none",
        hint: `未检测到 ${profile.bin}，安装后才能查询可用模型。`,
      }
    }
    if (profile.modelProbe) {
      const args = profile.modelProbe.args
      const timeoutMs = profile.modelProbe.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
      const result = await (this.#run
        ? this.#run(profile, binPath, args, timeoutMs, this.#env())
        : runProbe(binPath, args, timeoutMs, this.#env()))
      const models = parseAgentModelOutput(result.stdout, profile.modelProbe.format)
      const fromConfig = this.#configModels(profile)
      const merged = models?.length
        ? [...fromConfig.filter((entry) => !models.some((model) => model.id === entry.id)), ...models]
        : models
      if (merged?.length) {
        this.#log?.info(`discovered ${merged.length} model(s) for ${profile.id} (${fromConfig.length} from config)`)
        // A full page means the CLI may have rows the panel cannot show; say so instead
        // of silently presenting a truncated list as the whole account catalogue.
        const hint = merged.length >= MAX_MODELS ? `模型较多，仅列出前 ${MAX_MODELS} 个。` : undefined
        return { models: merged, source: "probe", checkedAt: new Date(this.#now()).toISOString(), hint }
      }
      if (fromConfig.length > 0) {
        // The probe failed but the config file named a model: that one is still usable
        return {
          models: fromConfig,
          source: "configured",
          checkedAt: new Date(this.#now()).toISOString(),
          hint: `${profile.label} 的目录查询失败，以下模型来自其配置文件。`,
        }
      }
      const hint = models
        ? `${profile.label} 当前账号没有可用模型。`
        : failureHint(result, profile.bin)
      this.#log?.warn(`model discovery for ${profile.id} returned none: ${hint}`)
      return { models: [], source: "probe", hint, checkedAt: new Date(this.#now()).toISOString() }
    }
    return {
      models: [],
      source: "none",
      hint: profile.modelHint
        ? `该 Agent 没有提供模型查询接口；可直接发送 /model <模型 ID>（示例：${profile.modelHint}）。`
        : "该 Agent 没有提供模型查询接口；可直接发送 /model <模型 ID>。",
    }
  }
}

