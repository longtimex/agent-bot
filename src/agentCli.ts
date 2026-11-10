import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join, resolve, sep } from "node:path"
import process from "node:process"
import { StringDecoder } from "node:string_decoder"
import { childEnv, extendedPath } from "./binPath.js"
import { redactSecrets, stripAnsi } from "./ccswitch.js"
import { EXIT_DRAIN_MS, terminateProcess, terminateProcesses } from "./childKill.js"
import type { Logger } from "./logger.js"
import { clip, clipTail } from "./messages.js"
import type { SessionStore } from "./store.js"

const DEFAULT_TIMEOUT_MS = 600_000
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024
const ENGINE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/
/**
 * A model id reaches the CLI as its own argv token, so a leading `-` would be
 * parsed as another flag and could override the profile's safety switches, and
 * control characters cannot appear in an option value. Anything else is left
 * alone: custom profiles legitimately declare ids with spaces or non-ASCII text.
 */
const MODEL_ARG_RE = /^(?!-)[^\x00-\x1F\x7F]{1,120}$/
/**
 * Session ids reach argv too (after `--resume`, or positionally for codex), and
 * they are read back from the tool's own output or from the data file, so a value
 * that starts with `-` would inject a flag the same way a model id could.
 */
const SESSION_ARG_RE = /^(?!-)[^\x00-\x1F\x7F]{1,128}$/
/**
 * Progress lines are only recognised once they end, but a spinner writing `\r`
 * forever would otherwise hold an unbounded tail of the 8 MB output buffer.
 */
const MAX_PROGRESS_LINE_CHARS = 64_000

/** Last `max` characters, without leaving half of a surrogate pair at the cut. */
const capTail = clipTail

function isSafeSessionId(value: string | undefined): value is string {
  return value !== undefined && SESSION_ARG_RE.test(value)
}

export type CliParseMode = "text" | "json-result" | "jsonl-result" | "claude-json" | "codex-jsonl" | "gemini-stream"

export type CliSessionMode = "preassign" | "capture" | "stateless"

export interface AgentCliModel {
  id: string
  label: string
  desc?: string
  aliases?: string[]
}

export type AgentInstallMethod = "npm" | "pip"

/** Only curated package-manager installs are executable from Telegram. */
export interface AgentInstallSpec {
  method: AgentInstallMethod
  package: string
}

export interface AgentCliArgs {
  /** Always placed first. */
  base?: string[]
  /** Replaces `base` when resuming a session. */
  resumeBase?: string[]
  newSession?: string[]
  resumeSession?: string[]
  cwd?: string[]
  model?: string[]
  prompt?: string[]
}

export interface AgentCliProfile {
  id: string
  label: string
  bin: string
  aliases?: string[]
  desc: string
  /** Human-readable install hint (may be a URL or manual command). */
  install?: string
  installSpec?: AgentInstallSpec
  sessionMode: CliSessionMode
  parse?: CliParseMode
  supportsModel?: boolean
  strictModels?: boolean
  modelHint?: string
  models?: AgentCliModel[]
  args: AgentCliArgs
  resumeErrorPattern?: string
  env?: Record<string, string>
  experimental?: boolean
}

export interface AgentCliRegistryOptions {
  path?: string
  log?: Logger
}

interface ProfileFile {
  agents?: unknown
}

export { BUILTIN_AGENT_PROFILES } from "./agentProfiles.js"
import { BUILTIN_AGENT_PROFILES } from "./agentProfiles.js"

/** Default lookup PATH also covers the per-user global bin directories where the Bot installs CLIs. */
export function whichSync(bin: string, envPath = extendedPath()): string | undefined {
  const expanded = bin === "~" || bin.startsWith("~/") ? join(homedir(), bin.slice(1)) : bin
  const candidates =
    isAbsolute(expanded) || expanded.includes("/")
      ? [resolve(expanded)]
      : envPath.split(delimiter).filter(Boolean).map((dir) => join(dir, expanded))
  for (const candidate of candidates) {
    try {
      const info = statSync(candidate)
      if (!info.isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return undefined
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_.-]+/g, "")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === "string")
  return items.length === value.length ? items : undefined
}

function sanitizeModels(value: unknown): AgentCliModel[] | undefined {
  if (Array.isArray(value)) {
    const models: AgentCliModel[] = []
    for (const item of value) {
      const record = asRecord(item)
      if (!record) continue
      const id = typeof record.id === "string" ? record.id.trim() : ""
      if (!id) continue
      models.push({
        id,
        label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : id,
        desc: typeof record.desc === "string" ? record.desc : undefined,
        aliases: stringArray(record.aliases),
      })
    }
    return models
  }

  const record = asRecord(value)
  if (!record) return undefined
  const models: AgentCliModel[] = []
  for (const [id, raw] of Object.entries(record)) {
    if (typeof raw === "string") {
      models.push({ id, label: raw })
      continue
    }
    const info = asRecord(raw)
    if (!info) continue
    models.push({
      id,
      label: typeof info.label === "string" && info.label.trim() ? info.label.trim() : id,
      desc: typeof info.desc === "string" ? info.desc : undefined,
      aliases: stringArray(info.aliases),
    })
  }
  return models
}

function validateTemplate(template: string[] | undefined, label: string, field: string): string[] | undefined {
  if (!template) return undefined
  for (const token of template) {
    for (const match of token.matchAll(/\{([^}]+)\}/g)) {
      if (!["workDir", "sessionId", "model", "prompt"].includes(match[1] ?? "")) {
        throw new Error(`${label}.args.${field} 包含未知占位符 {${match[1]}}`)
      }
    }
  }
  return template
}

function parseArgs(value: unknown, label: string): AgentCliArgs | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const args: AgentCliArgs = {}
  const mapping: Array<[keyof AgentCliArgs, string[]]> = [
    ["base", ["base"]],
    ["resumeBase", ["resumeBase", "resume_base"]],
    ["newSession", ["newSession", "new_session", "new"]],
    ["resumeSession", ["resumeSession", "resume_session", "resume"]],
    ["cwd", ["cwd", "workDir", "work_dir"]],
    ["model", ["model"]],
    ["prompt", ["prompt"]],
  ]
  for (const [target, keys] of mapping) {
    for (const key of keys) {
      if (!(key in record)) continue
      const parsed = stringArray(record[key])
      if (!parsed) throw new Error(`${label}.args.${key} 必须是字符串数组`)
      args[target] = validateTemplate(parsed, label, key)
      break
    }
  }
  return args
}

const PACKAGE_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/

function sanitizeInstallSpec(value: unknown, label: string): AgentInstallSpec | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const method = record.method
  if (method !== "npm" && method !== "pip") throw new Error(`${label}.installSpec.method 必须是 npm 或 pip`)
  const pkg = typeof record.package === "string" ? record.package.trim() : ""
  if (!PACKAGE_RE.test(pkg)) throw new Error(`${label}.installSpec.package 不是合法的包名`)
  return { method, package: pkg }
}

function sanitizeEnv(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const env: Record<string, string> = {}
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw !== "string") continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    env[key] = raw
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function mergeProfile(id: string, raw: Record<string, unknown>, base?: AgentCliProfile): AgentCliProfile {
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : (base?.label ?? id)
  const bin = typeof raw.bin === "string" && raw.bin.trim() ? raw.bin.trim() : base?.bin
  if (!bin) throw new Error(`${label} 缺少 bin`)
  const sessionModeRaw = typeof raw.sessionMode === "string" ? raw.sessionMode : undefined
  const sessionMode: CliSessionMode = ["preassign", "capture", "stateless"].includes(sessionModeRaw ?? "")
    ? (sessionModeRaw as CliSessionMode)
    : (base?.sessionMode ?? "stateless")
  const parseRaw = typeof raw.parse === "string" ? raw.parse : undefined
  const parse: CliParseMode = ["text", "json-result", "jsonl-result", "claude-json", "codex-jsonl", "gemini-stream"].includes(
    parseRaw ?? "",
  )
    ? (parseRaw as CliParseMode)
    : (base?.parse ?? "text")

  const models = "models" in raw ? sanitizeModels(raw.models) : base?.models
  const supportsModel =
    typeof raw.supportsModel === "boolean" ? raw.supportsModel : (base?.supportsModel ?? (models?.length ?? 0) > 0)
  const strictModels = typeof raw.strictModels === "boolean" ? raw.strictModels : (base?.strictModels ?? false)

  const args = parseArgs(raw.args, label) ?? {}
  const mergedArgs: AgentCliArgs = { ...base?.args, ...args }

  const resumeErrorPattern =
    typeof raw.resumeErrorPattern === "string" ? raw.resumeErrorPattern : base?.resumeErrorPattern
  if (resumeErrorPattern) {
    try {
      new RegExp(resumeErrorPattern)
    } catch {
      throw new Error(`${label} 的 resumeErrorPattern 不是合法正则`)
    }
  }

  return {
    id,
    label,
    bin,
    aliases: "aliases" in raw ? (stringArray(raw.aliases) ?? []) : base?.aliases,
    desc: typeof raw.desc === "string" && raw.desc.trim() ? raw.desc.trim() : (base?.desc ?? "自定义 Agent CLI"),
    install: typeof raw.install === "string" ? raw.install : base?.install,
    installSpec: "installSpec" in raw ? sanitizeInstallSpec(raw.installSpec, label) : base?.installSpec,
    sessionMode,
    parse,
    supportsModel,
    strictModels,
    modelHint: typeof raw.modelHint === "string" ? raw.modelHint : base?.modelHint,
    models,
    args: mergedArgs,
    resumeErrorPattern,
    env: "env" in raw ? sanitizeEnv(raw.env) : base?.env,
    experimental: typeof raw.experimental === "boolean" ? raw.experimental : base?.experimental,
  }
}

export class AgentCliRegistry {
  readonly #path?: string
  readonly #log?: Logger
  #stamp = ""
  #profiles = new Map<string, AgentCliProfile>()

  constructor(options: AgentCliRegistryOptions = {}) {
    this.#path = options.path
    this.#log = options.log
    this.reload(true)
  }

  reload(force = false): void {
    let stamp = "missing"
    if (this.#path) {
      try {
        const info = statSync(this.#path)
        stamp = `${info.mtimeMs}:${info.size}`
      } catch {
        // custom profile file is optional
      }
    }
    if (!force && stamp === this.#stamp) return
    this.#stamp = stamp

    const profiles = new Map<string, AgentCliProfile>()
    for (const profile of BUILTIN_AGENT_PROFILES) profiles.set(profile.id, profile)

    if (stamp !== "missing" && this.#path) {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(this.#path, "utf8")) as ProfileFile
      } catch (err) {
        this.#log?.warn(`failed to read agent profiles ${this.#path}:`, (err as Error).message)
      }
      const root = asRecord(parsed)
      const rawAgents = root?.agents ?? parsed
      const entries: Array<[string, unknown]> = Array.isArray(rawAgents)
        ? rawAgents
            .map((item) => {
              const record = asRecord(item)
              const id = typeof record?.id === "string" ? record.id : ""
              return [id, record] as [string, unknown]
            })
            .filter(([id]) => Boolean(id))
        : Object.entries(asRecord(rawAgents) ?? {})

      for (const [rawId, rawProfile] of entries) {
        const id = rawId.trim().toLowerCase()
        if (!ENGINE_ID_RE.test(id) || id === "opencode") {
          this.#log?.warn(`ignored invalid agent profile id: ${rawId}`)
          continue
        }
        const record = asRecord(rawProfile)
        if (!record) continue
        try {
          profiles.set(id, mergeProfile(id, record, profiles.get(id)))
        } catch (err) {
          this.#log?.warn(`ignored agent profile ${id}:`, (err as Error).message)
        }
      }
    }

    this.#profiles = profiles
  }

  list(): AgentCliProfile[] {
    this.reload()
    return [...this.#profiles.values()]
  }

  get(id: string): AgentCliProfile | undefined {
    this.reload()
    return this.#profiles.get(id.trim().toLowerCase())
  }

  resolve(raw: string): string | undefined {
    this.reload()
    const value = raw.trim()
    if (!value) return undefined
    const lower = value.toLowerCase()
    const normalized = norm(value)
    for (const profile of this.#profiles.values()) {
      if (profile.id === lower || profile.bin.toLowerCase() === lower || profile.label.toLowerCase() === lower) {
        return profile.id
      }
      if (profile.aliases?.some((alias) => alias.toLowerCase() === lower)) return profile.id
    }
    for (const profile of this.#profiles.values()) {
      if (norm(profile.id) === normalized || norm(profile.bin) === normalized || norm(profile.label) === normalized) {
        return profile.id
      }
      if (profile.aliases?.some((alias) => norm(alias) === normalized)) return profile.id
    }
    return undefined
  }

  resolveEngine(raw: string): string | undefined {
    const value = raw.trim().toLowerCase()
    if (!value) return undefined
    if (["opencode", "open-code", "oc", "open"].includes(value)) return "opencode"
    return this.resolve(value)
  }

  label(id: string): string {
    if (id === "opencode") return "OpenCode"
    return this.get(id)?.label ?? id
  }

  binPath(profile: AgentCliProfile): string | undefined {
    return whichSync(profile.bin)
  }

  resolveModel(engine: string, raw: string): string | undefined {
    const profile = this.get(engine)
    if (!profile || !profile.supportsModel) return undefined
    const value = raw.trim()
    if (!value) return undefined
    const lower = value.toLowerCase()
    const normalized = norm(value)
    for (const model of profile.models ?? []) {
      if (model.id.toLowerCase() === lower || model.label.toLowerCase() === lower) return model.id
      if (model.aliases?.some((alias) => alias.toLowerCase() === lower)) return model.id
    }
    for (const model of profile.models ?? []) {
      if (norm(model.id) === normalized || norm(model.label) === normalized) return model.id
      if (model.aliases?.some((alias) => norm(alias) === normalized)) return model.id
    }
    return profile.strictModels || !MODEL_ARG_RE.test(value) ? undefined : value
  }

  /**
   * Whether the engine lists this word as one of its own models. A profile without
   * `strictModels` accepts any string, so without this check `/model default` would set
   * a model literally named "default" instead of dropping the session's selection.
   */
  declaresModel(engine: string, raw: string): boolean {
    const profile = this.get(engine)
    if (!profile) return false
    const value = raw.trim().toLowerCase()
    if (!value) return false
    return (profile.models ?? []).some(
      (model) =>
        model.id.toLowerCase() === value ||
        model.label.toLowerCase() === value ||
        (model.aliases ?? []).some((alias) => alias.toLowerCase() === value),
    )
  }

  modelLabel(engine: string, model: string): string {
    const profile = this.get(engine)
    const match = profile?.models?.find((item) => item.id === model)
    return match?.label ?? model
  }

}

export interface CliParseResult {
  text: string
  sessionId?: string
  error?: string
}

function parseJson(raw: string): unknown {
  const text = raw.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    // fall through to line scanning
  }
  for (const line of text.split("\n").reverse()) {
    const candidate = line.trim()
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // keep scanning
    }
  }
  return undefined
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

function pickSessionId(record: Record<string, unknown>): string | undefined {
  return pickString(record, ["session_id", "sessionId", "thread_id", "threadId", "conversation_id"])
}

function pickText(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined
  if (typeof value === "string") return value.trim() || undefined
  const record = asRecord(value)
  if (!record) return undefined
  const direct = pickString(record, ["result", "response", "content", "text", "message", "output", "answer", "completion"])
  if (direct) return direct
  const data = record.data ?? record.item ?? record.delta
  return pickText(data, depth + 1)
}

function pickError(record: Record<string, unknown>): string | undefined {
  const error = record.error
  if (typeof error === "string" && error.trim()) return error
  const nested = asRecord(error)
  const message = nested ? pickString(nested, ["message", "detail", "error"]) : undefined
  if (message) return message
  if (record.is_error === true || record.success === false || record.status === "error") {
    return pickText(record) ?? "CLI 返回错误"
  }
  return undefined
}

function appendAssistant(current: string, content: string, delta: boolean | undefined): string {
  if (!current) return content
  if (delta) return current + content
  if (content === current) return current
  if (content.startsWith(current)) return content
  if (current.startsWith(content)) return current
  return current + content
}

function parseJsonl(mode: CliParseMode, raw: string): CliParseResult {
  let sessionId: string | undefined
  let error: string | undefined
  const chunks: string[] = []
  let lastText: string | undefined

  for (const line of raw.split("\n")) {
    const candidate = line.trim()
    if (!candidate.startsWith("{")) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const record = asRecord(parsed)
    if (!record) continue
    sessionId ??= pickSessionId(record)
    const type = typeof record.type === "string" ? record.type : ""

    if (mode === "codex-jsonl") {
      if (type === "thread.started") {
        sessionId ??= pickSessionId(record)
      } else if (type === "item.completed") {
        const item = asRecord(record.item)
        if (item?.type === "agent_message") {
          const text = pickString(item, ["text", "content", "message"])
          if (text) chunks.push(text)
        } else if (item?.type === "error") {
          error ??= pickString(item, ["message", "text"]) ?? "Codex 返回错误"
        }
      } else if (type === "error" || type === "turn.failed") {
        error ??= pickString(record, ["message", "error"]) ?? pickError(record) ?? "Codex 返回错误"
      }
      // A typeless record is a plain JSON result object, not a Codex event
      if (type) continue
    }

    if (mode === "gemini-stream") {
      if (type === "init") {
        sessionId ??= pickSessionId(record)
      } else if (type === "message") {
        const role = typeof record.role === "string" ? record.role : ""
        if (role === "assistant" || role === "model") {
          const content = pickString(record, ["content", "text"])
          if (content) {
            const merged = appendAssistant(chunks.join(""), content, record.delta === true)
            chunks.length = 0
            chunks.push(merged)
          }
        }
      } else if (type === "result") {
        if (record.status === "error") error ??= pickError(record) ?? "Gemini 返回错误"
      } else if (type === "error") {
        error ??= pickError(record) ?? "Gemini 返回错误"
      }
      // A typeless record is a plain JSON result object, not a Gemini event
      if (type) continue
    }

    if (type.includes("error") || record.error) {
      error ??= pickError(record) ?? pickString(record, ["message"]) ?? "CLI 返回错误"
    }
    const text = pickText(record)
    if (text) lastText = text
  }

  let text = chunks.join("").trim()
  if (!text && lastText) text = lastText
  return { text, sessionId, error }
}

export function parseCliOutput(mode: CliParseMode | undefined, raw: string): CliParseResult {
  const clean = stripAnsi(raw)
  if (!mode || mode === "text") return { text: clean.trim() }

  if (mode === "codex-jsonl" || mode === "gemini-stream" || mode === "jsonl-result") {
    const result = parseJsonl(mode, clean)
    if (result.text || result.error || result.sessionId) return result
    // Some CLIs print a single JSON object even when the profile expects JSONL
    const fallback = parseJson(clean)
    const record = asRecord(fallback)
    if (record) {
      return {
        text: pickText(record) ?? "",
        sessionId: pickSessionId(record),
        error: pickError(record),
      }
    }
    return { text: clean.trim() }
  }

  const parsed = parseJson(clean)
  const record = asRecord(parsed)
  if (!record) {
    const looksLikeJson = clean.trim().startsWith("{")
    return { text: clean.trim(), error: looksLikeJson ? "无法解析 CLI 返回的 JSON" : undefined }
  }
  return {
    text: pickText(record) ?? "",
    sessionId: pickSessionId(record),
    error: pickError(record),
  }
}

function progressFromLine(mode: CliParseMode | undefined, line: string): string | undefined {
  const text = stripAnsi(line).trim()
  if (!text) return undefined
  if (!mode || mode === "text") return clip(text, 80)

  if (!text.startsWith("{")) return clip(text, 80)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const record = asRecord(parsed)
  if (!record) return undefined
  const type = typeof record.type === "string" ? record.type : ""
  const role = typeof record.role === "string" ? record.role : ""

  if (mode === "codex-jsonl") {
    if (type === "thread.started") return "会话已建立…"
    if (type === "turn.started") return "正在思考…"
    if (type === "turn.completed") return "正在收尾…"
    if (type === "item.started") {
      const item = asRecord(record.item)
      if (item?.type === "command_execution") {
        const command = pickString(item, ["command"])
        if (command) return `执行: ${clip(command, 60)}`
      }
    }
    if (type === "item.completed") {
      const item = asRecord(record.item)
      if (item?.type === "agent_message") return clip(pickString(item, ["text", "content"]), 80)
      if (item?.type === "command_execution") return "命令执行完成"
    }
    return undefined
  }

  if (mode === "gemini-stream") {
    if (type === "init") return "会话已建立…"
    if (type === "message" && (role === "assistant" || role === "model")) {
      return clip(pickString(record, ["content", "text"]), 80)
    }
    if (type === "tool_call" || type === "tool_result") return "正在调用工具…"
    if (type === "result") return "正在收尾…"
    return undefined
  }

  if (role === "user" || type === "user_message") return undefined
  const progress = pickString(record, ["status", "message", "summary", "text", "content"])
  return clip(progress, 80)
}

/**
 * These CLIs receive the prompt as one argv token. Linux caps a single argument at
 * MAX_ARG_STRLEN (128 KiB) and the whole vector plus environment at ARG_MAX (~2 MiB),
 * so a long message or inlined attachment text would otherwise die as an opaque
 * "spawn E2BIG". Fail before spawning with what to do instead.
 */
const ARGV_SINGLE_LIMIT_BYTES = 120 * 1024
const ARGV_TOTAL_LIMIT_BYTES = 1024 * 1024

export function argvBudgetError(label: string, args: string[]): string | undefined {
  let total = 0
  let longest = 0
  for (const token of args) {
    const size = Buffer.byteLength(token)
    total += size + 1
    if (size > longest) longest = size
  }
  if (longest <= ARGV_SINGLE_LIMIT_BYTES && total <= ARGV_TOTAL_LIMIT_BYTES) return undefined
  const kb = (bytes: number): string => `${Math.round(bytes / 1024)}KB`
  return (
    `${label} 通过命令行参数接收提示，单条上限 ${kb(ARGV_SINGLE_LIMIT_BYTES)}、总上限 ${kb(ARGV_TOTAL_LIMIT_BYTES)}` +
    `（本次最长 ${kb(longest)}，合计 ${kb(total)}）。` +
    "请缩短内容，或切换到 OpenCode 引擎（/agent opencode）以支持长提示与附件。"
  )
}

export function buildCliArgs(
  profile: AgentCliProfile,
  vars: { workDir: string; sessionId?: string; model?: string; prompt: string },
  isNew: boolean,
): string[] {
  // A model id reaching argv as `-something` would be parsed as its own flag
  const model = vars.model && MODEL_ARG_RE.test(vars.model) ? vars.model : undefined
  // A session id is read back from the tool's output or from the data file, so it
  // gets the same treatment; an unusable id is dropped, which starts a fresh
  // session and lets the next capture overwrite the bad value
  const sessionId = isSafeSessionId(vars.sessionId) ? vars.sessionId : undefined
  // Same hazard for the prompt, which is usually the last positional token: a
  // message that starts with `-` (a pasted bullet list, `--version`) would be
  // parsed as a flag, overriding the profile's switches or resuming another
  // session. A leading space keeps the token a value for every parser
  // (commander, yargs, argparse) and is invisible to the model.
  const prompt = vars.prompt.startsWith("-") ? ` ${vars.prompt}` : vars.prompt
  const render = (template: string[] | undefined): string[] => {
    if (!template) return []
    const values: Record<string, string> = {
      workDir: vars.workDir,
      sessionId: sessionId ?? "",
      model: model ?? "",
      prompt,
    }
    // Single pass: placeholders appearing inside substituted values stay literal
    return template.map((token) =>
      token.replace(/\{(workDir|sessionId|model|prompt)\}/g, (_, key: string) => values[key] ?? ""),
    )
  }

  const args: string[] = []
  // Only a real session resume may use resumeBase; stateless runs have no sessionId
  const resuming = !isNew && Boolean(sessionId)
  args.push(...render(resuming ? (profile.args.resumeBase ?? profile.args.base) : profile.args.base))
  if (sessionId) {
    args.push(...render(isNew ? profile.args.newSession : profile.args.resumeSession))
  }
  args.push(...render(profile.args.cwd))
  if (model) args.push(...render(profile.args.model))
  args.push(...render(profile.args.prompt ?? ["{prompt}"]))
  return args
}

const MAX_WORK_DIR_CHARS = 512

/**
 * Normalizes a requested working directory: `~` expansion, relative paths against
 * the Bot's own directory and a shape check. Existence is verified by the caller so
 * it can tell "no such directory" apart from "not a directory".
 */
export function normalizeWorkDirInput(raw: string, cwd: string, home: string): string | undefined {
  const text = raw.trim().replace(/^["']|["']$/g, "").replace(/[/\\]+$/, "")
  if (!text || text.length > MAX_WORK_DIR_CHARS || /[\u0000-\u001f\u007f]/.test(text)) return undefined
  const expanded = text === "~" ? home : text.startsWith("~/") ? join(home, text.slice(2)) : text
  const absolute = resolve(cwd, expanded)
  // An agent that skips permission checks must never be handed the filesystem root
  if (absolute === sep || absolute === "") return undefined
  return absolute
}

function describeDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`
  return `${Math.max(1, Math.round(ms / 1_000))} 秒`
}

export class AgentCliService {
  readonly registry: AgentCliRegistry
  /** Directory used when a chat has not chosen its own with `/dir`. */
  readonly defaultWorkDir: string
  readonly #store: SessionStore
  readonly #log: Logger
  readonly #timeoutMs: number
  readonly #maxTimeoutMs: number
  readonly #proxyEnv?: () => Record<string, string>
  readonly #active = new Set<ChildProcess>()

  constructor(
    workDir: string,
    store: SessionStore,
    log: Logger,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTimeoutMs = timeoutMs,
    proxyEnv?: () => Record<string, string>,
    registry?: AgentCliRegistry,
  ) {
    this.defaultWorkDir = workDir
    this.#store = store
    this.#log = log
    this.#timeoutMs = timeoutMs
    this.#maxTimeoutMs = Math.max(maxTimeoutMs, timeoutMs)
    this.#proxyEnv = proxyEnv
    this.registry = registry ?? new AgentCliRegistry({ log })
  }

  dispose(): void
  dispose(graceMs: number): Promise<void>
  dispose(graceMs?: number): void | Promise<void> {
    if (graceMs === undefined) {
      for (const child of this.#active) this.#terminate(child)
      this.#active.clear()
      return
    }
    const children = [...this.#active]
    this.#active.clear()
    return terminateProcesses(children, graceMs)
  }

  /** The directory a CLI run for this chat actually starts in. */
  workDir(key: string): string {
    return this.#resolveWorkDir(key, false)
  }

  /**
   * `/dir` lets a chat point its CLI engine at another project. A directory that
   * disappeared (unmounted volume, deleted repo) must not stall the task, so the
   * Bot's own working directory is used instead.
   */
  #resolveWorkDir(key: string, announce = true): string {
    const custom = this.#store.getDir(key)
    if (!custom) return this.defaultWorkDir
    try {
      if (statSync(custom).isDirectory()) return custom
    } catch {
      // fall through
    }
    if (announce) this.#log.warn(`work dir ${custom} for ${key} is unavailable, using ${this.defaultWorkDir}`)
    return this.defaultWorkDir
  }

  async prompt(
    key: string,
    engine: string,
    query: string,
    modelOverride?: string,
    onProgress?: (summary: string) => void,
    signal?: AbortSignal,
    attempt = 0,
  ): Promise<string> {
    const profile = this.registry.get(engine)
    if (!profile) throw new Error(`未知的 Agent 引擎：${engine}`)

    const binPath = this.registry.binPath(profile)
    if (!binPath) {
      const install = profile.install ? `\n安装：${profile.install}` : ""
      throw new Error(`未找到 ${profile.bin} 可执行文件，请先安装 ${profile.label}。${install}`)
    }

    // Checked before a session id is spent: an oversized prompt never reaches the CLI,
    // so it must not consume or rewrite the chat's session either
    const earlyBudget = argvBudgetError(profile.label, [query])
    if (earlyBudget) throw new Error(earlyBudget)

    let sessionId: string | undefined
    let isNew = false
    if (profile.sessionMode !== "stateless") {
      sessionId = this.#store.getCliSession(key, profile.id)
      isNew = !sessionId
      if (profile.sessionMode === "preassign" && !sessionId) {
        sessionId = randomUUID()
        this.#store.setCliSession(key, profile.id, sessionId)
      }
    }

    // An omitted model is deliberate: the CLI's own configuration decides. Never
    // inject a project default here, because it would override the user's choice.
    const model = profile.supportsModel
      ? (modelOverride ?? this.#store.getCliModel(key, profile.id))
      : undefined
    const workDir = this.#resolveWorkDir(key)
    const args = buildCliArgs(profile, { workDir, sessionId, model, prompt: query }, isNew)
    const budget = argvBudgetError(profile.label, args)
    if (budget) throw new Error(budget)
    this.#log.debug(
      `spawning ${profile.id} (${binPath}, isNew=${isNew}, session=${sessionId ?? "none"}, model=${model ?? "engine config"}, cwd=${workDir})`,
    )

    return new Promise((resolve, reject) => {
      const child = spawn(binPath, args, {
        cwd: workDir,
        env: childEnv({ ...process.env, ...profile.env, ...this.#proxyEnv?.() }),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      })
      this.#active.add(child)

      let stdout = ""
      let stderr = ""
      let progressBuffer = ""
      // Each data event can split a multi-byte character in half, so the streams
      // are decoded incrementally instead of per chunk: CLIs here emit CJK text
      const outDecoder = new StringDecoder("utf8")
      const errDecoder = new StringDecoder("utf8")
      let idleTimer: NodeJS.Timeout | null = null
      let hardTimer: NodeJS.Timeout | null = null
      let drainTimer: NodeJS.Timeout | null = null
      // Set once the process itself is gone; the pipes may still be held by a helper
      let exitedWith: number | null | undefined
      let settled = false

      const stopTimers = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        if (hardTimer) clearTimeout(hardTimer)
        if (drainTimer) clearTimeout(drainTimer)
      }
      const cleanup = (): void => {
        stopTimers()
        signal?.removeEventListener("abort", onAbort)
      }
      const finish = (): boolean => {
        if (settled) return false
        settled = true
        cleanup()
        return true
      }
      const fail = (message: string): void => {
        if (!finish()) return
        this.#terminate(child)
        reject(new Error(message))
      }
      const onAbort = (): void => fail("已取消当前任务。")

      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })
      }

      const outputTail = (): string => stripAnsi(redactSecrets(clipTail(stdout, 500))).trim()
      const resetIdle = (): void => {
        // Buffered output can still arrive after the promise settled; arming a
        // timer then would keep a stray 10-minute handle alive per chunk
        if (settled) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          fail(
            `${profile.label} 执行超时：已超过 ${describeDuration(this.#timeoutMs)}无任何输出活动。已输出:\n${outputTail()}`,
          )
        }, this.#timeoutMs)
      }
      resetIdle()
      hardTimer = setTimeout(() => {
        fail(
          `${profile.label} 执行超时：任务总耗时已达到 ${describeDuration(this.#maxTimeoutMs)}上限。已输出:\n${outputTail()}`,
        )
      }, this.#maxTimeoutMs)

      const feedProgress = (chunk: string, flush = false): void => {
        if (!onProgress) return
        progressBuffer += chunk
        // Spinners emit only \r, so splitting on \n alone would hold the whole run
        // in the buffer and never report a line
        const lines = progressBuffer.split(/[\r\n]/)
        progressBuffer = flush ? "" : (lines.pop() ?? "")
        if (progressBuffer.length > MAX_PROGRESS_LINE_CHARS) {
          progressBuffer = progressBuffer.slice(progressBuffer.length - MAX_PROGRESS_LINE_CHARS)
        }
        for (const line of lines) {
          const summary = progressFromLine(profile.parse, line)
          if (summary) onProgress(summary)
        }
      }

      // Trimming to the cap on every chunk past it would rebuild an 8 MB string
      // per data event (O(n²) over a long run): grow up to 2× the cap, then cut
      // back once, which keeps the retained tail within [cap, 2·cap)
      const trimOutput = (text: string): string =>
        text.length > MAX_OUTPUT_CHARS * 2 ? capTail(text, MAX_OUTPUT_CHARS) : text
      const appendStdout = (text: string): void => {
        stdout += text
        stdout = trimOutput(stdout)
      }
      const appendStderr = (text: string): void => {
        stderr += text
        stderr = trimOutput(stderr)
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        resetIdle()
        armDrain()
        const text = outDecoder.write(chunk)
        if (!text) return
        appendStdout(text)
        feedProgress(text)
      })

      child.stderr?.on("data", (chunk: Buffer) => {
        resetIdle()
        armDrain()
        appendStderr(errDecoder.write(chunk))
      })

      // Settles the run: reached from `close`, or from the exit drain below when a
      // helper process keeps the pipes open and `close` therefore never arrives.
      const settle = (code: number | null): void => {
        this.#active.delete(child)
        if (!finish()) return
        // A truncated sequence can still sit in the decoder when the process exits
        const outTail = outDecoder.end()
        const errTail = errDecoder.end()
        if (outTail) appendStdout(outTail)
        if (errTail) appendStderr(errTail)
        feedProgress(outTail, true)

        const parsed = parseCliOutput(profile.parse, stdout)
        const errText = redactSecrets((parsed.error ? `${parsed.error}\n` : "") + (stderr.trim() || stdout.trim())).slice(
          0,
          2_000,
        )

        if (code === 0 && !parsed.error) {
          if (profile.sessionMode === "capture" && parsed.sessionId) {
            if (isSafeSessionId(parsed.sessionId)) this.#store.setCliSession(key, profile.id, parsed.sessionId)
            else this.#log.warn(`${profile.id} reported an unusable session id; it was not persisted`)
          }
          const reply = parsed.text.trim()
          resolve(reply || `${profile.label} 已执行完毕，无文本返回。`)
          return
        }

        if (
          !isNew &&
          sessionId &&
          attempt < 1 &&
          profile.resumeErrorPattern &&
          new RegExp(profile.resumeErrorPattern, "i").test(errText)
        ) {
          this.#log.warn(`${profile.id} session ${sessionId} failed to resume, retrying with a fresh session`)
          this.#store.clearCliSession(key, profile.id)
          this.prompt(key, engine, query, modelOverride, onProgress, signal, attempt + 1).then(resolve, reject)
          return
        }

        reject(new Error(`${profile.label} 退出错误 (代码 ${code ?? "null"}): ${errText || "无输出"}`))
      }

      const armDrain = (): void => {
        if (settled || exitedWith === undefined) return
        if (drainTimer) clearTimeout(drainTimer)
        // Output that keeps arriving means the pipe is draining, so the window restarts
        drainTimer = setTimeout(() => {
          settle(exitedWith ?? null)
          // The leader is gone, so anything left in its process group is an orphan holding
          // the inherited pipes; signalling it delivers `close` instead of leaking it
          this.#terminate(child)
        }, EXIT_DRAIN_MS)
        drainTimer.unref()
      }

      child.on("close", (code) => {
        exitedWith = code
        settle(code)
      })

      child.once("exit", (code) => {
        exitedWith = code
        armDrain()
      })

      child.on("error", (err) => {
        this.#active.delete(child)
        if (!finish()) return
        reject(new Error(`无法启动 ${profile.label} 进程: ${err.message}`))
      })
    })
  }

  #terminate(child: ChildProcess): void {
    terminateProcess(child)
  }
}
