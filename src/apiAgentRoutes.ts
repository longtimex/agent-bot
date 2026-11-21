import type { AgentCliProfile, AgentCliService } from "./agentCli.js"
import type { AgentCliInstaller } from "./agentInstaller.js"
import { whichSync } from "./agentCli.js"
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
    const confirmed = ["1", "true"].includes(ctx.url.searchParams.get("confirm") ?? "")
    const engine = this.#deps.agents.registry.resolveEngine(rawId)
    const profile = engine && engine !== "opencode" ? this.#deps.agents.registry.get(engine) : undefined
    // The built-in engine has no profile, but its npm package can still be removed
    if (engine === "opencode") {
      if (action !== "uninstall" && action !== "install") {
        throw new ApiError(400, "OpenCode 只支持安装与卸载，其余由安装脚本负责：bash scripts/install-cc-switch.sh")
      }
      if (action === "install") {
        const installerBin = this.#deps.installer
        if (!installerBin) throw new ApiError(409, "当前运行环境不支持安装管理")
        const existing = whichSync("opencode")
        if (existing) throw new ApiError(409, `OpenCode 已安装：${existing}`)
        if (this.#running) throw new ApiError(409, "已有安装/卸载任务在执行，请稍后再试")
        this.#running = true
        try {
          const result = await installerBin.installOpencode()
          this.#deps.log.info(`api agent install opencode: ${result.ok ? "ok" : "failed"}`)
          this.#deps.json(ctx.res, 200, {
            ok: result.ok,
            message: redactSecrets(result.message),
            output: result.output ? redactSecrets(result.output).slice(-20_000) : undefined,
            needsConfirm: false,
          })
        } finally {
          this.#running = false
        }
        return
      }
      if (this.#deps.store.getEngine(this.#deps.appKey) === "opencode") {
        throw new ApiError(409, "当前正在使用 OpenCode，请先切换到其他引擎再卸载")
      }
      const installerOk = this.#deps.installer
      if (!installerOk) throw new ApiError(409, "当前运行环境不支持安装管理")
      if (this.#running) throw new ApiError(409, "已有安装/卸载任务在执行，请稍后再试")
      this.#running = true
      try {
        const result = await installerOk.uninstallOpencode(confirmed)
        this.#deps.log.info(`api agent uninstall opencode: ${result.ok ? "ok" : "failed"}`)
        // Same shape the CLI path returns: a needsConfirm answer is a 200 with ok:false
        this.#deps.json(ctx.res, 200, {
          ok: result.ok,
          message: redactSecrets(result.message),
          output: result.output ? redactSecrets(result.output).slice(-20_000) : undefined,
          needsConfirm: result.needsConfirm ?? false,
        })
      } finally {
        this.#running = false
      }
      return
    }
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
      // Updating only makes sense for a copy the bot installed. Removal also covers a
      // hand-installed CLI, but only after the client echoes confirm=1: the package manager
      // would otherwise delete a binary the user installed for their own reasons.
      if (action === "update" && !installer.isManaged(engine)) {
        throw new ApiError(409, `${profile.label} 不是由 Bot 安装的，无法自动更新`)
      }
      if (action === "uninstall") {
        if (this.#deps.store.getEngine(this.#deps.appKey) === engine) {
          throw new ApiError(409, `当前正在使用 ${profile.label}，请先切换到 OpenCode 再卸载`)
        }
        if (!installer.isManaged(engine) && !confirmed) {
          const command = installer.uninstallCommand(engine)
          throw new ApiError(
            409,
            command
              ? `${profile.label} 不是由 Bot 安装的，确认卸载将执行 ${command}；请在请求中带上 confirm=1`
              : `${profile.label} 不是通过 npm/pip 安装的，无法自动卸载`,
          )
        }
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
            : await installer.uninstall(engine, confirmed)
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
