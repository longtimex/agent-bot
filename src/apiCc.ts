import type { IncomingMessage, ServerResponse } from "node:http"
import {
  assertSafeId,
  CC_LONG_TIMEOUT_MS,
  CC_PROVIDER_API_FORMATS,
  CC_PROVIDER_TEMPLATES,
  CcSwitchError,
  CcSwitchRunError,
  redactSecrets,
  stripAnsi,
  type CcSwitchProvider,
  type CcSwitchProviderDraft,
  type CcSwitchService,
} from "./ccswitch.js"
import { ccAppFlagToken, ccBlockedReason, ccConfirmPlan, isLongCcCommand } from "./ccGuards.js"
import { ApiError, type ApiRequestContext } from "./apiCore.js"
import {
  CC_EXEC_COMMANDS,
  CC_EXEC_GROUPS,
  CC_VIEWS,
  assertSafeQuery,
  ccPhrases,
  hermesLimit,
  parseCcRunArgs,
  validateCcExtra,
} from "./apiCcSpecs.js"

export interface CcRouteDeps {
  cc: CcSwitchService | undefined
  json: (res: ServerResponse, status: number, body: unknown) => void
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>
  ccQuery: <T>(run: () => Promise<T>) => Promise<T>
  runCcAction: <T>(run: () => Promise<T>) => Promise<T>
  withCcLock: <T>(run: () => Promise<T>) => Promise<T>
}

export async function routeCc(
  deps: CcRouteDeps,
  ctx: ApiRequestContext,
  id: string | undefined,
  action: string | undefined,
): Promise<void> {
    const cc = deps.cc
    if (!cc) throw new ApiError(409, "当前运行环境不支持 cc-switch")

    if (ctx.method === "GET" && !id) {
      if (!cc.available) {
        deps.json(ctx.res, 200, { available: false, app: cc.app, bin: null, version: null, providers: [], current: null, error: null })
        return
      }
      let providers: CcSwitchProvider[] = []
      let error: string | undefined
      try {
        providers = await cc.listProviders()
      } catch (err) {
        error = redactSecrets(err instanceof Error ? err.message : String(err))
      }
      const version = await cc.version()
      deps.json(ctx.res, 200, {
        available: true,
        app: cc.app,
        bin: cc.bin ?? null,
        version: version ?? null,
        providers: providers.map((provider) => ({ id: provider.id, name: provider.name, current: provider.current })),
        current: providers.find((provider) => provider.current)?.id ?? null,
        error: error ?? null,
      })
      return
    }

    if (ctx.method === "GET" && id === "views") {
      // Labels and target prompts come from the server, so the app never hardcodes this list
      deps.json(ctx.res, 200, {
        views: Object.entries(CC_VIEWS).map(([name, spec]) => ({
          name,
          label: spec.label,
          needsTarget: spec.needsTarget ?? false,
          targetLabel: spec.targetLabel ?? "目标 ID",
          // So a typed 「/cc provider current」 resolves here instead of in the app
          tokens: spec.phrases ?? ccPhrases(spec.args("")),
        })),
      })
      return
    }

    if (ctx.method === "GET" && id === "view") {
      const name = ctx.url.searchParams.get("name") ?? ""
      const spec = Object.hasOwn(CC_VIEWS, name) ? CC_VIEWS[name] : undefined
      if (!spec) throw new ApiError(400, `未知的视图，可用：${Object.keys(CC_VIEWS).join("、")}`)
      const raw = ctx.url.searchParams.get("target") ?? ""
      const label = spec.targetLabel ?? "目标 ID"
      // An absent target stays empty (the argv builder ignores it); a needed one must validate
      const target = raw ? ccTargetId(raw, label) : ""
      if (spec.needsTarget && !target) throw new ApiError(400, `「${spec.label}」需要${label}`)
      const result = await deps.ccQuery(() => cc.run(spec.args(target), spec.long ? CC_LONG_TIMEOUT_MS : undefined))
      deps.json(ctx.res, 200, {
        name,
        text: clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    if (id === "hermes") {
      // Hermes keeps two memory blobs (MEMORY.md / USER.md). They are long free text, so
      // the App edits them on one screen instead of through a one-line cc-switch prompt.
      if (ctx.method === "GET") {
        deps.json(ctx.res, 200, await hermesState(deps, cc))
        return
      }
      if (ctx.method === "POST") {
        const body = await deps.readJsonBody(ctx.req)
        const kind = typeof body.kind === "string" ? body.kind.trim().toLowerCase() : ""
        if (kind !== "memory" && kind !== "user") throw new ApiError(400, "kind 需是 memory 或 user")
        const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : ""
        const file = kind === "user" ? "USER.md" : "MEMORY.md"
        // cc-switch has already applied the change by the time the refresh runs, so a glitchy
        // follow-up read must not turn the answer into a failure — the App would retry a write
        // that succeeded. `refreshed: false` tells it to keep showing what it has instead of
        // replacing the editor with the empty defaults of a stateless response.
        const reply = async (build: (limits: string) => string): Promise<void> => {
          try {
            const state = await hermesState(deps, cc)
            deps.json(ctx.res, 200, {
              ok: true,
              kind,
              action,
              refreshed: true,
              message: build(state.limits),
              ...state,
            })
          } catch {
            deps.json(ctx.res, 200, {
              ok: true,
              kind,
              action,
              refreshed: false,
              message: `${build("")}\n⚠️ 修改已生效，但状态刷新失败，请重新打开本页确认。`,
            })
          }
        }
        if (action === "enable" || action === "disable") {
          await deps.runCcAction(() => cc.run(["hermes", "memory", action, kind]))
          await reply(
            () =>
              action === "enable"
                ? `已启用 ${file}。`
                : `已停用 ${file}，Hermes 加载记忆时会跳过它。`,
          )
          return
        }
        // Both write over what is there, and cc-switch's own `clear` prints a refusal and
        // still exits 0 without `--yes`, so the flag goes back in here rather than in a
        // request field the App could forget
        if (action === "clear") {
          if (body.confirm !== true) throw new ApiError(400, `「清空 ${file}」需要确认，请在请求中带上 confirm: true`)
          await deps.runCcAction(() => cc.run(["hermes", "memory", "clear", kind, "--yes"]))
          await reply(() => `已清空 ${file}。`)
          return
        }
        if (action !== "set") throw new ApiError(400, "未知的 action，可用：set、clear、enable、disable")
        if (body.confirm !== true) throw new ApiError(400, `「覆盖 ${file}」需要确认，请在请求中带上 confirm: true`)
        const content = typeof body.content === "string" ? body.content.replace(/[\r\n]+$/, "") : ""
        if (!content.trim()) throw new ApiError(400, `内容为空；要清空 ${file} 请改用 clear。`)
        if (content.length > 20_000) throw new ApiError(400, "记忆内容过长（上限 20000 字）")
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
          throw new ApiError(400, "记忆内容含控制字符，只允许换行与制表符")
        }
        await deps.runCcAction(() => cc.run(["hermes", "memory", "set", kind, "--content", content]))
        // cc-switch writes whatever it is given and Hermes truncates on load, so going over
        // the budget is reported rather than refused
        await reply((limits) => {
          const budget = hermesLimit(limits, kind)?.chars
          const note =
            budget !== undefined && content.length > budget
              ? `⚠️ 已写入 ${content.length} 字，超出 Hermes 的 ${budget} 字预算，加载时会被截断。`
              : ""
          return `已写入 ${file}（${content.length} 字）。${note}`
        })
        return
      }
      throw new ApiError(405, "该路径只支持 GET 与 POST")
    }

    if (ctx.method === "GET" && id === "proxy") {
      deps.json(ctx.res, 200, { text: clipCcOutput(await deps.ccQuery(() => cc.proxyShow())) })
      return
    }

    if (ctx.method === "GET" && id === "mcp") {
      deps.json(ctx.res, 200, { text: clipCcOutput(await deps.ccQuery(() => cc.listMcp())) })
      return
    }

    if (ctx.method === "GET" && id === "prompts") {
      deps.json(ctx.res, 200, { text: clipCcOutput(await deps.ccQuery(() => cc.listPrompts())) })
      return
    }

    if (ctx.method === "GET" && id === "env") {
      const mode = ctx.url.searchParams.get("mode") === "tools" ? "tools" : "check"
      const text = await deps.ccQuery(() => (mode === "tools" ? cc.envTools() : cc.envCheck()))
      deps.json(ctx.res, 200, { mode, text: clipCcOutput(text) })
      return
    }

    if (ctx.method === "GET" && (id === "stream" || id === "models")) {
      // Typed Telegram commands `/cc stream <id>` and `/cc models <id>` as buttons.
      const providerId = ctx.url.searchParams.get("id")?.trim() ?? ""
      if (!providerId) throw new ApiError(400, "缺少 id 查询参数（Provider ID）")
      const text = await deps.ccQuery(() => (id === "stream" ? cc.streamCheck(providerId) : cc.fetchModels(providerId)))
      deps.json(ctx.res, 200, { id: providerId, text: clipCcOutput(redactSecrets(text)) })
      return
    }

    if (ctx.method === "GET" && id === "sessions") {
      // `/cc sessions search <关键词>`; the read-only listing stays on /cc/view?name=sessions
      const query = assertSafeQuery(ctx.url.searchParams.get("q") ?? "", "搜索关键词")
      const result = await deps.ccQuery(() => cc.run(["sessions", "search", query], CC_LONG_TIMEOUT_MS))
      deps.json(ctx.res, 200, {
        query,
        text: clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    if (ctx.method === "GET" && id === "quota") {
      // `/cc quota <id>` read-only: the --reset variant burns credit and stays on Telegram.
      const providerId = ctx.url.searchParams.get("id")?.trim() ?? ""
      if (!providerId) throw new ApiError(400, "缺少 id 查询参数（Provider ID）")
      const result = await deps.ccQuery(() => cc.run(["provider", "quota", ccTargetId(providerId, "Provider ID")]))
      deps.json(ctx.res, 200, {
        id: providerId,
        text: clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    if (ctx.method === "POST" && id === "use") {
      const body = await deps.readJsonBody(ctx.req)
      const providerId = typeof body.id === "string" ? body.id.trim() : ""
      if (!providerId) throw new ApiError(400, "缺少 id 字段")
      const text = await deps.runCcAction(() => cc.useProvider(providerId))
      deps.json(ctx.res, 200, { ok: true, message: `已切换 Provider 到 ${providerId}。`, text: clipCcOutput(text) })
      return
    }

    if (ctx.method === "POST" && id === "test") {
      const body = await deps.readJsonBody(ctx.req)
      let providerId = typeof body.id === "string" ? body.id.trim() : ""
      if (!providerId) {
        const providers = await deps.ccQuery(() => cc.listProviders())
        providerId = providers.find((provider) => provider.current)?.id ?? ""
      }
      if (!providerId) throw new ApiError(400, "未找到当前 Provider，请在请求中指定 id")
      const result = await deps.runCcAction(() => cc.speedtest(providerId))
      deps.json(ctx.res, 200, {
        ok: result.ok,
        id: providerId,
        latencyMs: result.latencyMs ?? null,
        status: result.status ?? null,
        text: clipCcOutput(redactSecrets(result.raw)),
      })
      return
    }

    if (ctx.method === "POST" && id === "mcp" && action === "sync") {
      const text = await deps.runCcAction(() => cc.syncMcp())
      deps.json(ctx.res, 200, { ok: true, message: "已同步 MCP 配置。", text: clipCcOutput(text) })
      return
    }

    if (ctx.method === "POST" && id === "prompts" && (action === "activate" || action === "deactivate")) {
      const body = await deps.readJsonBody(ctx.req)
      const promptId = typeof body.id === "string" ? body.id.trim() : ""
      if (action === "activate" && !promptId) throw new ApiError(400, "缺少 id 字段")
      const text = await deps.runCcAction(() => (action === "activate" ? cc.activatePrompt(promptId) : cc.deactivatePrompt()))
      deps.json(ctx.res, 200, {
        ok: true,
        message: action === "activate" ? `已启用提示词 ${promptId}。` : "已停用提示词。",
        text: clipCcOutput(text),
      })
      return
    }

    if (ctx.method === "POST" && id === "mcp" && action === "import") {
      const body = await deps.readJsonBody(ctx.req)
      const raw = typeof body.json === "string" ? body.json.trim() : ""
      if (!raw) throw new ApiError(400, "缺少 json 字段（MCP 服务器配置）")
      if (raw.length > 20_000) throw new ApiError(400, "MCP 配置过长（上限 20000 字）")
      const text = await deps.runCcAction(() => cc.importMcp(raw))
      deps.json(ctx.res, 200, { ok: true, message: "已提交 MCP 导入。", text: clipCcOutput(text) })
      return
    }

    if (ctx.method === "POST" && id === "prompts" && action === "create") {
      const body = await deps.readJsonBody(ctx.req)
      const name = typeof body.name === "string" ? body.name.trim() : ""
      const content = typeof body.content === "string" ? body.content.trim() : ""
      if (!name || !content) throw new ApiError(400, "缺少 name 或 content 字段")
      if (/\s/.test(name)) throw new ApiError(400, "提示词名称不能包含空格")
      if (content.length > 20_000) throw new ApiError(400, "提示词内容过长（上限 20000 字）")
      const text = await deps.runCcAction(() => cc.importPrompt(name, content))
      deps.json(ctx.res, 200, { ok: true, message: `已创建提示词 ${name}。`, text: clipCcOutput(text) })
      return
    }

    if (ctx.method === "GET" && id === "exec") {
      // The app renders its danger zone from this, so the two sides cannot drift
      const groupOrder = Object.values(CC_EXEC_GROUPS)
      const commands = Object.entries(CC_EXEC_COMMANDS)
        .map(([name, spec]) => ({
          name,
          label: spec.label,
          // the argv builders are pure, so a dry call reveals the cc-switch group
          group: CC_EXEC_GROUPS[spec.args("", "")[0] ?? ""] ?? "其他",
          // On the wire this means "needs an arg": a command whose only value is the extra
          // half (`proxy config port 8787`) must make the App prompt for it too
          needsTarget: (spec.needsTarget ?? false) || spec.extra !== undefined,
          targetLabel: spec.targetLabel ?? "目标 ID",
          confirm: spec.confirm ?? false,
          // Same word list as the views, so 「/cc provider del foo」 reaches this gate
          tokens: spec.phrases ?? ccPhrases(spec.args("", "")),
        }))
        // stable sort keeps the table order inside a section
        .sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group))
      deps.json(ctx.res, 200, { commands })
      return
    }

    if (ctx.method === "GET" && id === "providers") {
      // The create form renders these, so cc-switch's allowed values stay server-side
      deps.json(ctx.res, 200, {
        app: cc.app,
        // OpenCode-style apps only accept raw settings JSON, so the form must ask for it
        fieldMode: cc.supportsProviderFields,
        templates: [...CC_PROVIDER_TEMPLATES],
        apiFormats: [...CC_PROVIDER_API_FORMATS],
        nameMaxLength: 80,
        configMaxLength: 20_000,
      })
      return
    }

    if (ctx.method === "POST" && id === "providers") {
      // The typed twin of Telegram's `/cc provider add ...`; the API key is masked
      // by the service before anything is returned, and never echoed back.
      const body = await deps.readJsonBody(ctx.req)
      const text = (key: string): string | undefined => {
        const value = body[key]
        return typeof value === "string" && value.trim() ? value.trim() : undefined
      }
      const name = text("name")
      if (!name) throw new ApiError(400, "缺少 name 字段（Provider 显示名）")
      const draft: CcSwitchProviderDraft = {
        name,
        id: text("id"),
        template: text("template"),
        baseUrl: text("baseUrl"),
        apiKey: text("apiKey"),
        model: text("model"),
        apiFormat: text("apiFormat"),
        config: typeof body.config === "string" ? body.config.trim() : undefined,
      }
      const result = await deps.withCcLock(async () => {
        try {
          return await cc.addProvider(draft)
        } catch (err) {
          // A rejected field is the form's mistake; cc-switch refusing the command is not.
          // addProvider throws on a non-zero exit, so a 200 here would describe a provider
          // that was never created, and the failure body would carry no `error`.
          if (err instanceof CcSwitchRunError) throw new ApiError(502, redactSecrets(err.message))
          if (err instanceof CcSwitchError) throw new ApiError(400, redactSecrets(err.message))
          throw new ApiError(502, redactSecrets(err instanceof Error ? err.message : String(err)))
        }
      })
      deps.json(ctx.res, 200, {
        ok: true,
        name: draft.name,
        message: `已创建 Provider「${draft.name}」。`,
        text: clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    if (ctx.method === "POST" && id === "deeplink") {
      const body = await deps.readJsonBody(ctx.req)
      const url = typeof body.url === "string" ? body.url.trim() : ""
      if (!url) throw new ApiError(400, "缺少 url 字段")
      if (!/^ccswitch:\/\/v1\/import\?/i.test(url)) throw new ApiError(400, "只接受 ccswitch://v1/import?... 形式的链接")
      if (url.length > 8192) throw new ApiError(400, "Deep Link 过长（上限 8192 字）")
      if (body.confirm !== true) throw new ApiError(400, "Deep Link 会覆盖 Provider/MCP/提示词配置，需要 confirm: true")
      const result = await deps.runCcAction(() => cc.runBare(["deeplink", url], CC_LONG_TIMEOUT_MS))
      deps.json(ctx.res, 200, {
        ok: result.code === 0,
        // cc-switch links can carry provider keys, so the URL is not echoed back
        message: result.code === 0 ? "已导入 Deep Link。" : "Deep Link 导入失败",
        text: clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    if (ctx.method === "POST" && id === "run") {
      const body = await deps.readJsonBody(ctx.req)
      const args = parseCcRunArgs(body.args)
      // Every cc-switch command accepts -a/--app; letting one through would retarget
      // another app's config, so the flag is rejected in all its spellings
      const appFlag = ccAppFlagToken(args)
      if (appFlag) throw new ApiError(400, `不要在 args 中传 ${appFlag}；应用类型由 CC_SWITCH_APP 固定`)
      // A deep link is one bare argv whose URL can carry provider keys, and the
      // dedicated endpoint never echoes it back; that cannot be said of a raw run
      if (args[0] === "deeplink") throw new ApiError(400, "Deep Link 请改用 POST /cc/deeplink")
      const blocked = ccBlockedReason(args, "App")
      if (blocked) throw new ApiError(400, redactSecrets(blocked))
      const plan = ccConfirmPlan(args)
      if (plan && body.confirm !== true) {
        throw new ApiError(400, `「${redactSecrets(plan.label)}」需要确认，请在请求中带上 confirm: true`)
      }
      if (plan?.kind === "provider-use") {
        const providerId = plan.providerId ?? ""
        const text = await deps.runCcAction(() => cc.useProvider(providerId))
        deps.json(ctx.res, 200, {
          ok: true,
          code: 0,
          // What ran is echoed redacted and cut short: a raw run can carry an API key in a
          // later token, and this response may end up in the App's saved history
          command: redactSecrets(`provider use ${providerId.slice(0, 80)}`),
          message: `已切换 Provider 到 ${redactSecrets(providerId.slice(0, 80))}。`,
          text: clipCcOutput(redactSecrets(stripAnsi(text))),
        })
        return
      }
      // cc-switch only performs the real run once its own flag is present, so a
      // confirmed action is submitted with the flag the plan asked for
      let argv = args
      for (const extra of plan?.appendArgs ?? []) {
        if (!argv.includes(extra)) argv = [...argv, extra]
      }
      const timeoutMs = plan?.timeoutMs ?? (isLongCcCommand(args) ? CC_LONG_TIMEOUT_MS : undefined)
      const result = await deps.runCcAction(() =>
        plan?.pty ? cc.runWithConfirm(argv, timeoutMs) : cc.run(argv, timeoutMs),
      )
      const command = redactSecrets(args.slice(0, 3).map((token) => token.slice(0, 80)).join(" "))
      deps.json(ctx.res, 200, {
        ok: result.code === 0,
        code: result.code,
        command,
        message: `${result.code === 0 ? "已完成" : "执行失败"}：${redactSecrets(plan?.label ?? command)}`,
        text: clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    if (ctx.method === "POST" && id === "exec") {
      const body = await deps.readJsonBody(ctx.req)
      const name = typeof body.name === "string" ? body.name.trim() : ""
      const spec = Object.hasOwn(CC_EXEC_COMMANDS, name) ? CC_EXEC_COMMANDS[name] : undefined
      if (!spec) throw new ApiError(400, `未知的操作，可用：${Object.keys(CC_EXEC_COMMANDS).join("、")}`)
      if (spec.confirm && body.confirm !== true) throw new ApiError(400, `「${spec.label}」需要确认，请在请求中带上 confirm: true`)
      const rawArg = typeof body.arg === "string" ? body.arg.trim() : ""
      const needsAny = spec.needsTarget || spec.extra !== undefined
      if (!needsAny && rawArg) throw new ApiError(400, "该操作不接受 arg 字段")
      if (needsAny && !rawArg) throw new ApiError(400, `缺少 arg 字段（${spec.targetLabel ?? "目标 ID"}）`)
      // The App prompts once, so a two-value command arrives as 「<id> <rest>」; Telegram
      // types the same words into `/cc failover move p1 up`
      const [head, ...tail] = rawArg.split(/\s+/)
      let target = ""
      if (spec.needsTarget) {
        try {
          target = assertSafeId(head ?? "", spec.targetLabel ?? "ID")
        } catch (err) {
          // A malformed id is the caller's mistake, not a cc-switch failure
          throw new ApiError(400, err instanceof Error ? err.message : "目标 ID 不合法")
        }
      }
      const rawExtra = spec.needsTarget ? tail.join(" ").trim() : rawArg
      if (!spec.extra && rawExtra) throw new ApiError(400, `「${spec.label}」的 arg 只能是一个${spec.targetLabel ?? "目标 ID"}`)
      const extra = spec.extra ? validateCcExtra(spec.extra, rawExtra, spec.extraLabel ?? "参数") : ""
      const args = spec.args(target, extra)
      const timeoutMs = spec.timeoutMs ?? (spec.long ? CC_LONG_TIMEOUT_MS : undefined)
      const result = await deps.runCcAction(() =>
        spec.pty ? cc.runWithConfirm(args, timeoutMs) : cc.run(args, timeoutMs),
      )
      deps.json(ctx.res, 200, {
        ok: result.code === 0,
        name,
        code: result.code,
        message: `${result.code === 0 ? "已完成" : "执行失败"}：${spec.label}${target || extra ? `（${target || extra}）` : ""}`,
        text: clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))),
      })
      return
    }

    throw new ApiError(404, "未知的 cc-switch API 路径")
  }

function clipCcOutput(text: string): string {
    return text.length > 20_000 ? text.slice(-20_000) : text
  }

  /**
   * One read of everything the App's memory screen shows: cc-switch's limits summary plus
   * both blobs. `show` prints a sentence instead of content for a file that does not exist,
   * which would otherwise land in the editor as text the user then saves back.
   */
async function hermesState(
    deps: CcRouteDeps,
    cc: CcSwitchService,
  ): Promise<{ limits: string; memory: string; user: string; memoryEnabled: boolean | null; userEnabled: boolean | null }> {
    const show = async (args: string[]): Promise<string> => {
      const result = await deps.ccQuery(() => cc.run(args))
      return clipCcOutput(redactSecrets(stripAnsi(result.stdout || result.stderr))).replace(/[\r\n]+$/, "")
    }
    const blob = async (kind: "memory" | "user"): Promise<string> => {
      const text = await show(["hermes", "memory", "show", kind])
      // A blob that was never written prints `Hermes <kind> memory is empty (file not
      // created yet)` instead of content, which must not land in the editor to be saved back
      return /^Hermes \S+ memory is empty \(file not created yet\)$/.test(text.trim()) ? "" : text
    }
    const limits = await show(["hermes", "memory", "limits"])
    return {
      limits,
      memory: await blob("memory"),
      user: await blob("user"),
      memoryEnabled: hermesLimit(limits, "memory")?.enabled ?? null,
      userEnabled: hermesLimit(limits, "user")?.enabled ?? null,
    }
  }

  /** cc-switch's ID guard throws its own error type; a bad id is the caller's mistake. */
function ccTargetId(raw: string, label: string): string {
    try {
      return assertSafeId(raw, label)
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : `${label} 不合法`)
    }
  }

