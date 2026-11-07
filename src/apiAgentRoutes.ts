import type { AgentCliProfile, AgentCliService } from "./agentCli.js"
import type { AgentCliInstaller } from "./agentInstaller.js"
import { ApiError, type ApiRequestContext } from "./apiCore.js"
import { redactSecrets } from "./ccswitch.js"
import type { Logger } from "./logger.js"
import type { SessionStore } from "./store.js"

export interface AgentRouteDeps {
  agents: AgentCliService
  installer?: AgentCliInstaller
  store: SessionStore
  log: Logger
  appKey: string
  agentView: (profile: AgentCliProfile) => unknown
  json: (res: ApiRequestContext["res"], status: number, body: unknown) => void
}

export class ApiAgentActions {
  readonly #deps: AgentRouteDeps
  #running = false

  constructor(deps: AgentRouteDeps) {
    this.#deps = deps
  }

  /** Install/update/uninstall an Agent CLI; the app confirms before calling. */
  async route(ctx: ApiRequestContext, rawId: string, action: string | undefined): Promise<void> {
    const verbs: Record<string, string> = { install: "安装", update: "更新", uninstall: "卸载" }
    const verb = action ? verbs[action] : undefined
    if (!action || !verb) throw new ApiError(404, "未知的 Agent 管理操作")
    const engine = this.#deps.agents.registry.resolveEngine(rawId)
    const profile = engine && engine !== "opencode" ? this.#deps.agents.registry.get(engine) : undefined
    if (!engine || !profile) throw new ApiError(404, `未识别的 Agent CLI：${rawId}`)
    const installer = this.#deps.installer
    if (!installer) throw new ApiError(409, "当前运行环境不支持安装管理")

    if (action === "install") {
      const existing = this.#deps.agents.registry.binPath(profile)
      if (existing) throw new ApiError(409, `${profile.label} 已安装：${existing}`)
      if (!installer.installCommand(profile)) {
        throw new ApiError(400, `${profile.label} 暂不支持自动安装${profile.install ? `，请手动安装：${profile.install}` : ""}`)
      }
    } else {
      if (!installer.isManaged(engine)) {
        throw new ApiError(409, `${profile.label} 不是由 Bot 安装的，无法自动${verb}`)
      }
      if (action === "uninstall" && this.#deps.store.getEngine(this.#deps.appKey) === engine) {
        throw new ApiError(409, `当前正在使用 ${profile.label}，请先切换到 OpenCode 再卸载`)
      }
    }
    if (this.#running) throw new ApiError(409, "已有安装/卸载任务在执行，请稍后再试")

    this.#running = true
    try {
      const result =
        action === "install"
          ? await installer.install(engine)
          : action === "update"
            ? await installer.update(engine)
            : await installer.uninstall(engine)
      this.#deps.log.info(`api agent ${action} ${engine}: ${result.ok ? "ok" : "failed"}`)
      this.#deps.json(ctx.res, 200, {
        ok: result.ok,
        message: redactSecrets(result.message),
        // npm/pip print the reason for a failure at the end, so the tail is what the App needs
        output: result.output ? redactSecrets(result.output).slice(-20_000) : undefined,
        agent: this.#deps.agentView(profile),
      })
    } finally {
      this.#running = false
    }
  }

}
