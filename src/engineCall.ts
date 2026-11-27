import type { AgentCliService } from "./agentCli.js"
import type { Logger } from "./logger.js"
import { Opencode, OpencodeError, type PromptFile } from "./opencode.js"
import { activeOpencodeSupervisor } from "./opencodeSupervisor.js"
import type { SessionStore } from "./store.js"
import { snapshotWorkspace, workspaceChanges } from "./workspaceChanges.js"
import { activeSecretVault } from "./secretVault.js"
import { activeApprovalManager } from "./approvals.js"
import type { TokenUsage } from "./tokenUsage.js"

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
  /** The answer so far, for clients that render it while it is written. */
  onDraft?: (text: string) => void
  /** Token/cost usage reported by OpenCode or supported CLI engines on completion. */
  onUsage?: (usage: TokenUsage) => void
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
  // Interactive high-risk approval gate before invoking either engine.
  const approvals = activeApprovalManager()
  if (approvals) await approvals.guardPrompt(opts.key, opts.text, opts.signal)

  // Snapshot the git workspace before either engine edits files, so /diff, /undo and /commit work for both.
  const workDir = deps.agents.workDir?.(opts.key)
  const snapshot = workDir ? snapshotWorkspace(workDir) : undefined

  if (opts.engine !== "opencode") {
    const notice = cliAttachmentNotice(opts.files)
    const reply = await deps.agents.prompt(
      opts.key,
      opts.engine,
      notice ? `${opts.text}\n\n${notice}` : opts.text,
      opts.cliModel,
      opts.onProgress,
      opts.signal,
      0,
      opts.onDraft,
      opts.onUsage,
    )
    const changes = snapshot ? workspaceChanges.finish(opts.key, snapshot, opts.engine) : undefined
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
        onUsage: opts.onUsage,
      })
    const handledPerms = new Set<string>()
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
        approvals
          ? (perm) => {
              if (handledPerms.has(perm.id)) return
              handledPerms.add(perm.id)
              touch?.()
              const detail = [perm.type ? `类型：${perm.type}` : "", perm.pattern ? `目标：${perm.pattern}` : ""]
                .filter(Boolean)
                .join("\n") || perm.title
              void approvals
                .requestApproval({
                  key: opts.key,
                  source: "opencode",
                  title: perm.title,
                  detail,
                  patternKey: `oc:${perm.type ?? "perm"}:${perm.pattern ?? perm.title}`,
                  signal: opts.signal,
                })
                .then((decision) => deps.oc.replyPermission(perm.sessionID, perm.id, decision))
                .catch((err: unknown) => {
                  deps.log.warn(`opencode permission reply failed (${perm.id}):`, err instanceof Error ? err.message : String(err))
                })
            }
          : undefined,
      )
    }

    try {
      listen()
      let reply: string
      try {
        reply = await promptOnce()
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
        reply = `${LOST_SESSION_NOTICE}\n\n${await promptOnce()}`
      }
      const changes = snapshot ? workspaceChanges.finish(opts.key, snapshot, "opencode") : undefined
      return changes ? `${reply}\n\n${changes}` : reply
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
