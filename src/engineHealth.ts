import type { Logger } from "./logger.js"

/**
 * Tells the owner when an engine stops working, before the next message fails on it.
 *
 * Until now a stopped OpenCode server, a CLI that vanished after an upgrade, or a relay whose key
 * expired only showed up as a failed reply, often hours later. Every few minutes the engines the
 * chats actually use are checked: OpenCode answers its health probe (unless it is on-demand,
 * where a stopped server is normal), each CLI binary is still on disk, and the last few runs of an
 * engine did not all fail the same way. One message goes out when a problem appears and one when
 * it clears; an unchanged problem is never repeated.
 */
export interface EngineOutcome {
  at: number
  outcome: string
  errorCode?: string
}

export interface EngineHealthDeps {
  /** Engines worth watching: the default plus every engine a chat picked. */
  engines: () => string[]
  label: (engine: string) => string
  opencodeOnDemand: boolean
  opencodeHealthy: () => Promise<boolean>
  /** false when the CLI's binary is missing; undefined for an engine the registry does not know. */
  cliInstalled: (engine: string) => boolean | undefined
  /** Recent finished runs of one engine across every chat, any order. */
  recentOutcomes: (engine: string) => EngineOutcome[]
  send: (text: string) => Promise<void>
  log: Logger
  intervalMs?: number
  firstCheckMs?: number
}

const STREAK = 3
const STREAK_REASONS: Record<string, string> = {
  AUTH_FAILED: "认证失败（API Key、登录状态或中转站额度可能有问题）",
  ENGINE_UNAVAILABLE: "引擎不可用（服务没运行或 CLI 无法启动）",
  MODEL_UNAVAILABLE: "模型不可用（模型名有误或已下线）",
  CLI_ARGUMENT_INVALID: "CLI 参数不兼容（CLI 升级后参数变了，可在 /agents 更新）",
}

export class EngineHealthMonitor {
  readonly #deps: EngineHealthDeps
  /** engine → the problem last reported for it */
  readonly #reported = new Map<string, string>()
  #timer?: NodeJS.Timeout
  #first?: NodeJS.Timeout
  #checking = false

  constructor(deps: EngineHealthDeps) {
    this.#deps = deps
  }

  start(): void {
    if (this.#timer) return
    // Give a just-started OpenCode server time to come up before the first probe
    this.#first = setTimeout(() => void this.check(), this.#deps.firstCheckMs ?? 120_000)
    this.#first.unref()
    this.#timer = setInterval(() => void this.check(), this.#deps.intervalMs ?? 5 * 60_000)
    this.#timer.unref()
  }

  dispose(): void {
    if (this.#first) clearTimeout(this.#first)
    if (this.#timer) clearInterval(this.#timer)
    this.#first = undefined
    this.#timer = undefined
  }

  /** Runs one round; resolves with the text it sent (tests), or undefined when nothing changed. */
  async check(): Promise<string | undefined> {
    if (this.#checking) return undefined
    this.#checking = true
    try {
      const engines = [...new Set(this.#deps.engines().filter(Boolean))]
      const problems = new Map<string, string>()
      for (const engine of engines) {
        const problem = await this.#problemOf(engine)
        if (problem) problems.set(engine, problem)
      }
      const appeared = [...problems].filter(([engine, problem]) => this.#reported.get(engine) !== problem)
      // An engine nobody uses any more is dropped silently rather than reported as recovered
      const cleared = [...this.#reported.keys()].filter((engine) => !problems.has(engine) && engines.includes(engine))
      // Collect before deleting: mutating a Map while iterating it skips entries
      const stale = [...this.#reported.keys()].filter((engine) => !engines.includes(engine))
      for (const engine of stale) this.#reported.delete(engine)
      if (appeared.length === 0 && cleared.length === 0) return undefined

      const lines: string[] = []
      if (appeared.length > 0) {
        lines.push("⚠️ 引擎异常提醒")
        for (const [engine, problem] of appeared) lines.push(`• ${this.#deps.label(engine)}：${problem}`)
      }
      if (cleared.length > 0) {
        if (lines.length > 0) lines.push("")
        lines.push(`✅ 已恢复：${cleared.map((engine) => this.#deps.label(engine)).join("、")}`)
      }
      if (appeared.length > 0) lines.push("", "发送 /agents 查看引擎状态，或用 /agent 临时换一个引擎。")
      const text = lines.join("\n")
      try {
        await this.#deps.send(text)
      } catch (err) {
        // Not marked as reported: the next round tries again
        this.#deps.log.warn("engine health alert could not be delivered:", (err as Error).message)
        return undefined
      }
      for (const [engine, problem] of appeared) this.#reported.set(engine, problem)
      for (const engine of cleared) this.#reported.delete(engine)
      return text
    } catch (err) {
      this.#deps.log.warn("engine health check failed:", (err as Error).message)
      return undefined
    } finally {
      this.#checking = false
    }
  }

  async #problemOf(engine: string): Promise<string | undefined> {
    if (engine === "opencode") {
      if (!this.#deps.opencodeOnDemand && !(await this.#deps.opencodeHealthy().catch(() => false))) {
        return "OpenCode 服务无法连接（可发送 /service 启动，或检查 OPENCODE_URL）"
      }
    } else if (this.#deps.cliInstalled(engine) === false) {
      return "找不到 CLI 可执行文件（可能被卸载或升级后路径变了，可在 /agents 重新安装）"
    }
    const recent = this.#deps
      .recentOutcomes(engine)
      .sort((a, b) => b.at - a.at)
      .slice(0, STREAK)
    if (recent.length < STREAK) return undefined
    const code = recent[0]!.errorCode
    if (!code || !STREAK_REASONS[code]) return undefined
    if (recent.every((run) => run.outcome === "failed" && run.errorCode === code)) {
      return `最近 ${STREAK} 次任务都${STREAK_REASONS[code]}`
    }
    return undefined
  }
}
