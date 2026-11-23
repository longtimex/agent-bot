import type { AgentCliService } from "./agentCli.js"
import type { Logger } from "./logger.js"
import { Opencode, OpencodeError, type PromptFile } from "./opencode.js"
import { activeOpencodeSupervisor } from "./opencodeSupervisor.js"
import type { SessionStore } from "./store.js"
import { snapshotWorkspace, workspaceChanges } from "./workspaceChanges.js"
import { activeSecretVault } from "./secretVault.js"

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
  /** OpenCode only: the answer so far, for clients that render it while it is written. */
  onDraft?: (text: string) => void
}

/**
 * The engine dispatch shared by Telegram jobs and the HTTP API: CLI engines
 * spawn through AgentCliService, OpenCode reuses the stored session and
 * transparently recovers when the server lost it (404).
 */
export async function callEngine(deps: EngineCallDeps, opts: EngineCallOptions): Promise<string> {
  // Secrets given through a 安全输入 card exist as files only while this chat's task runs
  const removeSecrets = activeSecretVault()?.materialize(opts.key)
  try {
    return await runEngine(deps, opts)
  } finally {
    removeSecrets?.()
  }
}

async function runEngine(deps: EngineCallDeps, opts: EngineCallOptions): Promise<string> {
  if (opts.engine !== "opencode") {
    const notice = cliAttachmentNotice(opts.files)
    // The CLI edits files where it runs: snapshot the repository so the reply can list what
    // changed and /undo can take it back. Outside a git repository this is a no-op.
    const workDir = deps.agents.workDir?.(opts.key)
    const snapshot = workDir ? snapshotWorkspace(workDir) : undefined
    const reply = await deps.agents.prompt(
      opts.key,
      opts.engine,
      notice ? `${opts.text}\n\n${notice}` : opts.text,
      opts.cliModel,
      opts.onProgress,
      opts.signal,
    )
    const changes = snapshot ? workspaceChanges.finish(opts.key, snapshot) : undefined
    return changes ? `${reply}\n\n${changes}` : reply
  }

  // The server may be stopped between tasks; bring it back before the first request and keep
  // the idle timer from reclaiming it while this task runs.
  const runtime = activeOpencodeSupervisor()
  const release = runtime?.track()
  try {
    if (runtime && !(await runtime.ensureRunning())) {
      throw new OpencodeError(
        "OpenCode 未运行，且无法自动启动；请安装 opencode-ai，或在 /agent 切换到其他引擎。",
      )
    }

    const model = opts.model
    let sessionID = await ensureSession(deps, opts.key)
    let unsubscribe: (() => void) | undefined
    let touch: (() => void) | undefined
    const promptOnce = (): Promise<string> =>
      deps.oc.prompt(sessionID, opts.text, {
        agent: deps.opencodeAgent,
        ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
        idleTimeoutMs: deps.taskTimeoutMs,
        maxTimeoutMs: deps.taskMaxTimeoutMs,
        onActivityHook: (hook) => {
          touch = hook
        },
        signal: opts.signal,
        files: opts.files,
      })
    const listen = (): void => {
      unsubscribe = deps.oc.subscribeSession(
        sessionID,
        (status) => {
          touch?.()
          opts.onProgress?.(status)
        },
        opts.onDraft
          ? (text) => {
              touch?.()
              opts.onDraft?.(text)
            }
          : undefined,
      )
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
        // Recovery is silent otherwise, and a session resumed from 历史会话 that the server has
        // since dropped would look restored while the Agent remembers nothing of it
        return `${LOST_SESSION_NOTICE}\n\n${await promptOnce()}`
      }
    } finally {
      unsubscribe?.()
    }
  } finally {
    release?.()
  }
}

/**
 * CLI profiles pass the prompt as one argv string and declare no attachment flags, so a
 * binary part cannot reach them at all. The manifest built upstream already names each
 * saved file's absolute path, which a CLI can open with its own tools; what it cannot do
 * is see a picture, so say that instead of letting the agent guess.
 */
export function cliAttachmentNotice(files?: PromptFile[]): string | undefined {
  if (!files || files.length === 0) return undefined
  const names = files.map((file) => file.filename).join("、")
  return `[二进制附件] ${names} 未随本次请求传给 CLI 引擎，只能用附件清单里的绝对路径自行读取；图片、音频、视频和扫描件请切换到 OpenCode 引擎。`
}

/** Prefixed to a reply that ran in a fresh session because OpenCode no longer had the old one. */
export const LOST_SESSION_NOTICE = "⚠️ 原会话在 OpenCode 服务端已不存在，已自动开启新会话，之前的上下文没有带过来。"

/** Only an explicit per-session selection is returned; the engine owns the default model. */
export function resolveOpencodeModel(
  store: SessionStore,
  key: string,
): ResolvedModel | undefined {
  return store.getModel(key)
}

async function ensureSession(deps: EngineCallDeps, key: string): Promise<string> {
  const existing = deps.store.get(key)
  if (existing) return existing

  const sessionID = await deps.oc.createSession(`Telegram ${key}`)
  deps.store.set(key, sessionID)
  return sessionID
}
