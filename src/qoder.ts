import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import type { Logger } from "./logger.js"
import type { SessionStore } from "./store.js"

const DEFAULT_TIMEOUT_MS = 600_000

function describeDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`
  return `${Math.max(1, Math.round(ms / 1_000))} 秒`
}

export class QoderService {
  readonly #workDir: string
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
  ) {
    this.#workDir = workDir
    this.#store = store
    this.#log = log
    this.#timeoutMs = timeoutMs
    this.#maxTimeoutMs = Math.max(maxTimeoutMs, timeoutMs)
    this.#proxyEnv = proxyEnv
  }

  dispose(): void {
    for (const child of this.#active) this.#terminate(child)
    this.#active.clear()
  }

  async prompt(
    key: string,
    query: string,
    modelOverride?: string,
    onProgress?: (summary: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    let qoderSessionID = this.#store.getQoderSessionID(key)
    const isNew = !qoderSessionID

    if (!qoderSessionID) {
      qoderSessionID = randomUUID()
      this.#store.setQoderSessionID(key, qoderSessionID)
    }

    const qoderArgs: string[] = ["-p"]

    if (isNew) {
      qoderArgs.push("--session-id", qoderSessionID)
    } else {
      qoderArgs.push("-r", qoderSessionID)
    }

    qoderArgs.push("--dangerously-skip-permissions", "-w", this.#workDir)

    const model = modelOverride || this.#store.getQoderModel(key)
    if (model) {
      qoderArgs.push("-m", model)
    }

    qoderArgs.push(query)

    this.#log.debug(`spawning qoder (isNew=${isNew}, sid=${qoderSessionID}): qoder ${qoderArgs.join(" ")}`)

    return new Promise((resolve, reject) => {
      const child = spawn("qoder", qoderArgs, {
        cwd: this.#workDir,
        env: { ...process.env, ...this.#proxyEnv?.() },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      })
      this.#active.add(child)

      let stdout = ""
      let stderr = ""
      let idleTimer: NodeJS.Timeout | null = null
      let hardTimer: NodeJS.Timeout | null = null
      let settled = false

      const stopTimers = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        if (hardTimer) clearTimeout(hardTimer)
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

      const onAbort = (): void => {
        fail("已取消当前任务。")
      }

      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })
      }

      const resetIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          fail(
            `Qoder 执行超时：已超过 ${describeDuration(this.#timeoutMs)}无任何输出活动。已输出:\n${stdout.slice(0, 500)}`,
          )
        }, this.#timeoutMs)
      }
      resetIdle()

      hardTimer = setTimeout(() => {
        fail(
          `Qoder 执行超时：任务总耗时已达到 ${describeDuration(this.#maxTimeoutMs)}上限。已输出:\n${stdout.slice(0, 500)}`,
        )
      }, this.#maxTimeoutMs)

      child.stdout!.on("data", (chunk) => {
        resetIdle()
        const text = chunk.toString()
        stdout += text
        if (onProgress) {
          const lines = text.split("\n").map((l: string) => l.trim()).filter(Boolean)
          const lastLine = lines[lines.length - 1]
          if (lastLine) {
            onProgress(lastLine.slice(0, 50))
          }
        }
      })

      child.stderr!.on("data", (chunk) => {
        resetIdle()
        stderr += chunk.toString()
      })

      child.on("close", (code) => {
        this.#active.delete(child)
        if (!finish()) return
        if (code === 0) {
          resolve(stdout.trim() || "Qoder 已执行完毕，无文本返回。")
        } else {
          // If session resume failed, reset and try once as fresh
          const errText = stderr.trim() || stdout.trim()
          if (!isNew && (errText.includes("Invalid session identifier") || errText.includes("already in use"))) {
            this.#log.warn(`qoder session ${qoderSessionID} failed to resume, resetting session...`)
            this.#store.setQoderSessionID(key, "")
            return this.prompt(key, query, modelOverride, onProgress, signal).then(resolve, reject)
          }
          reject(new Error(`Qoder 退出错误 (代码 ${code}): ${errText}`))
        }
      })

      child.on("error", (err) => {
        this.#active.delete(child)
        if (!finish()) return
        reject(new Error(`无法启动 Qoder 进程: ${err.message}`))
      })
    })
  }

  #terminate(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      // Children are spawned detached, so kill the whole process group
      if (child.pid) process.kill(-child.pid, "SIGTERM")
      else child.kill("SIGTERM")
    } catch {
      try {
        child.kill("SIGTERM")
      } catch {
        // already gone
      }
    }
  }
}
