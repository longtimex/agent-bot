import { randomBytes } from "node:crypto"
import { redactSecrets } from "./ccswitch.js"
import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import type { Logger } from "./logger.js"

export type ApprovalMode = "auto" | "strict" | "off"
export type ApprovalDecision = "once" | "always" | "reject"
export type ApprovalSource = "opencode" | "guard"

export interface PendingApprovalView {
  id: string
  key: string
  source: ApprovalSource
  title: string
  detail: string
  patternKey: string
  createdAt: number
  expiresAt: number
}

export interface RiskAssessment {
  patternKey: string
  title: string
  reason: string
  snippet: string
  strictOnly?: boolean
}

interface PendingEntry extends PendingApprovalView {
  resolve: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
  abortCleanup?: () => void
}

interface ApprovalConfigFile {
  mode?: ApprovalMode
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000

const HIGH_RISK_RULES: Array<{
  patternKey: string
  title: string
  reason: string
  re: RegExp
  strictOnly?: boolean
}> = [
  {
    patternKey: "guard:rm-rf",
    title: "递归强制删除文件",
    reason: "包含 rm -rf / rm -fr 等不可逆删除指令",
    re: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+|--recursive|--force)/i,
  },
  {
    patternKey: "guard:git-destructive",
    title: "破坏性 Git 历史/工作区操作",
    reason: "包含 git push --force / git reset --hard / git clean -f",
    re: /\bgit\s+(?:push\s+(?:--force|-f|--force-with-lease)|reset\s+--hard|clean\s+-[a-zA-Z]*f)/i,
  },
  {
    patternKey: "guard:sql-destructive",
    title: "数据库破坏性 DDL/DML",
    reason: "包含 DROP TABLE / DROP DATABASE / TRUNCATE TABLE",
    re: /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i,
  },
  {
    patternKey: "guard:disk-format",
    title: "磁盘底层写入或格式化",
    reason: "包含 mkfs / dd if= / fdisk / parted 等高危系统指令",
    re: /\b(?:mkfs(?:\.[a-z0-9]+)?|dd\s+if=|fdisk|parted|wipefs)\b/i,
  },
  {
    patternKey: "guard:pipe-shell",
    title: "远程脚本管道直接执行",
    reason: "通过 curl/wget 直接管道交给 sh/bash 执行",
    re: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i,
  },
  {
    patternKey: "guard:chmod-777",
    title: "全权递归修改目录权限",
    reason: "包含 chmod -R 777 等宽放权限操作",
    re: /\bchmod\s+-R\s+0?777\b/i,
  },
  {
    patternKey: "guard:system-power",
    title: "系统关机/重启或停服",
    reason: "包含 shutdown / reboot / poweroff / kill -9 1",
    re: /\b(?:shutdown|reboot|poweroff|halt|kill\s+-9\s+1\b)\b/i,
  },
  {
    patternKey: "guard:env-overwrite",
    title: "直接删除或覆盖 .env 密钥文件",
    reason: "操作指向 .env 敏感配置文件",
    re: /(?:>\s*\.env\b|\brm\s+[^\n]*\.env\b)/i,
  },
  // Strict-mode extra checks
  {
    patternKey: "strict:sudo",
    title: "提权命令 (sudo)",
    reason: "严格模式下需审批 sudo 提权操作",
    re: /\bsudo\s+\S+/i,
    strictOnly: true,
  },
  {
    patternKey: "strict:deploy-publish",
    title: "发布或远程变更操作",
    reason: "严格模式下需审批 npm publish / docker rm / kubectl delete / git push",
    re: /\b(?:npm\s+publish|docker\s+(?:rm|rmi|system\s+prune)|kubectl\s+delete|git\s+push)\b/i,
    strictOnly: true,
  },
]

export function parseApprovalMode(raw: unknown): ApprovalMode | undefined {
  if (typeof raw !== "string") return undefined
  const v = raw.trim().toLowerCase()
  if (v === "auto" || v === "strict" || v === "off") return v
  return undefined
}

export function assessHighRisk(text: string, mode: ApprovalMode = "auto"): RiskAssessment | undefined {
  if (mode === "off" || !text.trim()) return undefined
  for (const rule of HIGH_RISK_RULES) {
    if (rule.strictOnly && mode !== "strict") continue
    const match = rule.re.exec(text)
    if (!match) continue
    const start = Math.max(0, match.index - 24)
    const end = Math.min(text.length, match.index + match[0].length + 60)
    const snippet = redactSecrets(text.slice(start, end).replace(/\s+/g, " ").trim())
    return {
      patternKey: rule.patternKey,
      title: rule.title,
      reason: rule.reason,
      snippet,
      strictOnly: rule.strictOnly,
    }
  }
  return undefined
}

/**
 * Coordinates interactive high-risk approval requests across Telegram/Feishu cards
 * and the Android App. A task pauses until the operator approves once, approves
 * for the remainder of the session, rejects, or times out.
 */
export class ApprovalManager {
  readonly #path: string
  readonly #log: Logger
  #mode: ApprovalMode = "auto"
  readonly #pending = new Map<string, PendingEntry>()
  readonly #sessionAllows = new Map<string, Set<string>>()
  readonly #listeners = new Set<(item: PendingApprovalView) => void>()

  constructor(path: string, log: Logger, env: NodeJS.ProcessEnv = process.env) {
    this.#path = path
    this.#log = log
    this.#load(env)
  }

  get mode(): ApprovalMode {
    return this.#mode
  }

  setMode(mode: ApprovalMode): void {
    this.#mode = mode
    this.#save()
  }

  /** Subscribes to newly created pending approval items (e.g. to send Telegram cards & App notices). */
  onRequest(listener: (item: PendingApprovalView) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  listPending(): PendingApprovalView[] {
    return [...this.#pending.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ resolve: _r, timer: _t, abortCleanup: _a, ...view }) => view)
  }

  clearSessionAllows(key: string): void {
    this.#sessionAllows.delete(key)
  }

  /** Rejects all pending approvals (used on graceful shutdown). */
  rejectAll(): void {
    for (const id of this.#pending.keys()) {
      this.decide(id, "reject")
    }
  }

  /**
   * Inspects a prompt before handing it to an engine. Throws if the user rejects
   * or the approval times out.
   */
  async guardPrompt(key: string, text: string, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    const risk = assessHighRisk(text, this.#mode)
    if (!risk) return
    const decision = await this.requestApproval({
      key,
      source: "guard",
      title: risk.title,
      detail: `${risk.reason}\n片段：${risk.snippet}`,
      patternKey: risk.patternKey,
      signal,
      timeoutMs,
    })
    if (decision === "reject") {
      throw new Error(`高危操作「${risk.title}」未获批准（已拒绝或审批超时），已取消执行。`)
    }
  }

  requestApproval(opts: {
    key: string
    source: ApprovalSource
    title: string
    detail: string
    patternKey: string
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<ApprovalDecision> {
    if (this.#mode === "off") return Promise.resolve("once")
    if (this.#sessionAllows.get(opts.key)?.has(opts.patternKey)) return Promise.resolve("once")
    if (opts.signal?.aborted) return Promise.resolve("reject")

    const id = randomBytes(5).toString("hex")
    const createdAt = Date.now()
    const timeoutMs = Math.max(1_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const expiresAt = createdAt + timeoutMs

    return new Promise<ApprovalDecision>((resolve) => {
      const finish = (decision: ApprovalDecision): void => {
        const current = this.#pending.get(id)
        if (!current) return
        this.#pending.delete(id)
        clearTimeout(current.timer)
        current.abortCleanup?.()
        if (decision === "always") {
          const allowed = this.#sessionAllows.get(opts.key) ?? new Set<string>()
          allowed.add(opts.patternKey)
          this.#sessionAllows.set(opts.key, allowed)
        }
        resolve(decision)
      }

      const timer = setTimeout(() => finish("reject"), timeoutMs)
      timer.unref()

      let abortCleanup: (() => void) | undefined
      if (opts.signal) {
        const onAbort = (): void => finish("reject")
        opts.signal.addEventListener("abort", onAbort, { once: true })
        abortCleanup = () => opts.signal?.removeEventListener("abort", onAbort)
      }

      const entry: PendingEntry = {
        id,
        key: opts.key,
        source: opts.source,
        title: redactSecrets(opts.title).slice(0, 120),
        detail: redactSecrets(opts.detail).slice(0, 600),
        patternKey: opts.patternKey,
        createdAt,
        expiresAt,
        resolve: finish,
        timer,
        abortCleanup,
      }
      this.#pending.set(id, entry)

      const view: PendingApprovalView = {
        id: entry.id,
        key: entry.key,
        source: entry.source,
        title: entry.title,
        detail: entry.detail,
        patternKey: entry.patternKey,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      }
      for (const listener of this.#listeners) {
        try {
          listener(view)
        } catch (err) {
          this.#log.warn("approval listener failed:", err instanceof Error ? err.message : String(err))
        }
      }
    })
  }

  decide(id: string, decision: ApprovalDecision): { ok: boolean; message: string; item?: PendingApprovalView } {
    const entry = this.#pending.get(id)
    if (!entry) return { ok: false, message: "该审批请求已处理或已过期" }
    const view: PendingApprovalView = {
      id: entry.id,
      key: entry.key,
      source: entry.source,
      title: entry.title,
      detail: entry.detail,
      patternKey: entry.patternKey,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    }
    entry.resolve(decision)
    const label = decision === "once" ? "已允许本次执行" : decision === "always" ? "已在本会话内放行此类操作" : "已拒绝该高危操作"
    return { ok: true, message: `${label}：${view.title}`, item: view }
  }

  #load(env: NodeJS.ProcessEnv): void {
    const parsed = readJsonObject(this.#path, (msg) => this.#log.warn(msg)) as ApprovalConfigFile | undefined
    const fileMode = parseApprovalMode(parsed?.mode)
    if (fileMode) {
      this.#mode = fileMode
      return
    }
    const envMode = parseApprovalMode(env.APPROVAL_MODE)
    if (envMode) this.#mode = envMode
  }

  #save(): void {
    try {
      writePrivateAtomic(this.#path, `${JSON.stringify({ mode: this.#mode }, null, 2)}\n`)
    } catch (err) {
      this.#log.warn("failed to persist approval config:", (err as Error).message)
    }
  }
}

let activeManager: ApprovalManager | undefined

export function configureApprovalManager(manager: ApprovalManager | undefined): void {
  activeManager = manager
}

export function activeApprovalManager(): ApprovalManager | undefined {
  return activeManager
}
