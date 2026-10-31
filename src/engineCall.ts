import type { AgentCliService } from "./agentCli.js"
import type { ModelRef } from "./config.js"
import type { Logger } from "./logger.js"
import { AVAILABLE_MODELS } from "./models.js"
import { Opencode, OpencodeError, type PromptFile } from "./opencode.js"
import type { SessionStore } from "./store.js"

export interface ResolvedModel {
  providerID: string
  modelID: string
  label: string
}

export interface EngineCallDeps {
  oc: Opencode
  agents: AgentCliService
  store: SessionStore
  log: Logger
  /** OPENCODE_AGENT: the .opencode agent that handles prompts on the server. */
  opencodeAgent: string
  /** Configured default model, used when the chat has no explicit selection. */
  opencodeModel?: ModelRef
  taskTimeoutMs: number
  taskMaxTimeoutMs: number
}

export interface EngineCallOptions {
  key: string
  engine: string
  text: string
  files?: PromptFile[]
  /** OpenCode model selection; resolved from the session/config when omitted. */
  model?: ResolvedModel
  /** CLI model override; the per-session preference applies when omitted. */
  cliModel?: string
  signal?: AbortSignal
  onProgress?: (summary: string) => void
}

/**
 * The engine dispatch shared by Telegram jobs and the HTTP API: CLI engines
 * spawn through AgentCliService, OpenCode reuses the stored session and
 * transparently recovers when the server lost it (404).
 */
export async function callEngine(deps: EngineCallDeps, opts: EngineCallOptions): Promise<string> {
  if (opts.engine !== "opencode") {
    return deps.agents.prompt(opts.key, opts.engine, opts.text, opts.cliModel, opts.onProgress, opts.signal)
  }

  const model = opts.model ?? defaultOpencodeModel(deps.opencodeModel)
  let sessionID = await ensureSession(deps, opts.key)
  let unsubscribe: (() => void) | undefined
  let touch: (() => void) | undefined
  const promptOnce = (): Promise<string> =>
    deps.oc.prompt(sessionID, opts.text, {
      agent: deps.opencodeAgent,
      model: { providerID: model.providerID, modelID: model.modelID },
      idleTimeoutMs: deps.taskTimeoutMs,
      maxTimeoutMs: deps.taskMaxTimeoutMs,
      onActivityHook: (hook) => {
        touch = hook
      },
      signal: opts.signal,
      files: opts.files,
    })
  const listen = (): void => {
    unsubscribe = deps.oc.subscribeSession(sessionID, (status) => {
      touch?.()
      opts.onProgress?.(status)
    })
  }

  try {
    listen()
    try {
      return await promptOnce()
    } catch (err) {
      const missing = err instanceof OpencodeError && err.status === 404
      if (!missing) throw err
      deps.log.warn(`session ${sessionID} is gone, creating a new one`)
      deps.store.clearSession(opts.key)
      sessionID = await ensureSession(deps, opts.key)
      unsubscribe?.()
      listen()
      return await promptOnce()
    }
  } finally {
    unsubscribe?.()
  }
}

/** The stored selection wins, then the configured default, then the builtin fallback. */
export function resolveOpencodeModel(
  store: SessionStore,
  configured: ModelRef | undefined,
  key: string,
): ResolvedModel {
  const saved = store.getModel(key)
  if (saved) return saved
  if (configured) {
    return { providerID: configured.providerID, modelID: configured.modelID, label: configured.modelID }
  }
  return defaultOpencodeModel()
}

export function defaultOpencodeModel(configured?: ModelRef): ResolvedModel {
  if (configured) {
    return { providerID: configured.providerID, modelID: configured.modelID, label: configured.modelID }
  }
  const fallback = AVAILABLE_MODELS.gemini
  if (!fallback) throw new Error("内置模型表缺少默认模型，请检查 models.ts")
  return { providerID: fallback.providerID, modelID: fallback.modelID, label: fallback.label }
}

async function ensureSession(deps: EngineCallDeps, key: string): Promise<string> {
  const existing = deps.store.get(key)
  if (existing) return existing

  const sessionID = await deps.oc.createSession(`Telegram ${key}`)
  deps.store.set(key, sessionID)
  return sessionID
}
