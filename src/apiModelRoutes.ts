import type { AgentCliRegistry } from "./agentCli.js"
import type { AgentCustomModelStore } from "./agentCustomModels.js"
import { supportsRelay, type AgentProviderStore } from "./agentProviders.js"
import { asRecord } from "./util.js"
import { ApiError, type ApiRequestContext } from "./apiCore.js"
import { customModelView } from "./apiPersonal.js"
import type { ModelAdmin } from "./modelAdmin.js"

/** Metadata services answer unauthenticated requests with instance credentials. */
const BLOCKED_PROBE_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "100.100.100.200"])

export interface ModelRouteDeps {
  models: ModelAdmin
  /** CLI engines and their hand-added models: a CLI takes the name as a plain --model. */
  registry: AgentCliRegistry
  customModels: AgentCustomModelStore
  providers: AgentProviderStore
  json: (res: ApiRequestContext["res"], status: number, body: unknown) => void
  readJsonBody: (req: ApiRequestContext["req"]) => Promise<Record<string, unknown>>
}

/**
 * `GET/POST/DELETE /models/agent?engine=` — model ids the operator adds for a CLI engine.
 *
 * Discovery still wins: a hand-added entry only widens the list, it never hides what the CLI
 * reports for itself.
 */
/**
 * `POST /models/test` — does this endpoint answer, and does it know this model?
 *
 * It hits `GET {baseURL}/models`, the OpenAI-compatible discovery route. A provider that
 * implements only chat completions answers 404 there; that is reported as "reachable, cannot
 * list" rather than a failure, because the credentials may still be fine.
 */
export async function routeModelTest(deps: ModelRouteDeps, ctx: ApiRequestContext): Promise<void> {
  if (ctx.method !== "POST") throw new ApiError(404, "未知的模型测试 API 路径")
  const body = await deps.readJsonBody(ctx.req)
  const baseURL = (typeof body.baseURL === "string" ? body.baseURL : "").trim().replace(/\/+$/, "")
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
  const model = typeof body.model === "string" ? body.model.trim() : ""
  if (!/^https?:\/\//i.test(baseURL)) throw new ApiError(400, "baseURL 需要以 http:// 或 https:// 开头")
  // The probe makes the server fetch a user-supplied URL. Private ranges stay allowed on
  // purpose (a local relay is the normal case), but cloud metadata endpoints never are.
  const host = (() => {
    try {
      return new URL(baseURL).hostname.toLowerCase()
    } catch {
      return ""
    }
  })()
  if (BLOCKED_PROBE_HOSTS.has(host)) {
    throw new ApiError(400, "该地址是云主机元数据端点，拒绝探测；请填写模型服务的实际地址")
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(`${baseURL}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    })
    const text = await res.text()
    if (res.status === 404 || res.status === 405) {
      deps.json(ctx.res, 200, {
        ok: true,
        message: `${baseURL} 可以访问，但该服务没有 /models 接口，无法列出模型（不影响使用）`,
        models: [],
      })
      return
    }
    if (!res.ok) {
      deps.json(ctx.res, 200, { ok: false, message: `HTTP ${res.status}：${text.slice(0, 300)}`, models: [] })
      return
    }
    let models: string[] = []
    try {
      const parsed: unknown = JSON.parse(text)
      const data = asRecord(parsed)?.data
      if (Array.isArray(data)) {
        models = data
          .map((item) => (typeof asRecord(item)?.id === "string" ? (asRecord(item)?.id as string) : ""))
          .filter(Boolean)
      }
    } catch {
      // A plain-text answer still proves the endpoint is up; model listing stays empty
    }
    const listed = models.slice(0, 50)
    deps.json(ctx.res, 200, {
      ok: true,
      message: model
        ? models.includes(model)
          ? `连通，模型 ${model} 可用（共 ${models.length} 个）`
          : `连通，但列表里没有 ${model}（共 ${models.length} 个，可检查名称大小写）`
        : `连通，读到 ${models.length} 个模型`,
      models: listed,
    })
  } catch (err) {
    const reason = err instanceof Error ? (err.name === "AbortError" ? "超时（15 秒）" : err.message) : "未知错误"
    deps.json(ctx.res, 200, { ok: false, message: `连接失败：${reason}`, models: [] })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `GET/POST/DELETE /models/provider?engine=` — the relay a CLI engine should talk to.
 *
 * Only engines that read a base URL from the environment are offered this; anything else is
 * configured inside the CLI itself and editing it from here would be guesswork.
 */
export async function routeAgentProvider(deps: ModelRouteDeps, ctx: ApiRequestContext): Promise<void> {
  const requested = ctx.url.searchParams.get("engine") ?? ""
  const engine = deps.registry.resolve(requested)
  if (!engine) throw new ApiError(400, `未知的 Agent 引擎：${requested || "(空)"}`)
  if (!supportsRelay(engine)) {
    throw new ApiError(400, `${engine} 不支持通过环境变量配置中转站，请在 CLI 自己的配置里设置`)
  }
  if (ctx.method === "GET") {
    deps.json(ctx.res, 200, { engine, provider: deps.providers.get(engine) ?? null })
    return
  }
  if (ctx.method === "POST") {
    const body = await deps.readJsonBody(ctx.req)
    const baseURL = typeof body.baseURL === "string" ? body.baseURL.trim() : ""
    if (!/^https?:\/\//i.test(baseURL)) throw new ApiError(400, "baseURL 需要以 http:// 或 https:// 开头")
    deps.providers.set(engine, {
      baseURL,
      apiKey: typeof body.apiKey === "string" && body.apiKey ? body.apiKey : undefined,
    })
    deps.json(ctx.res, 200, { ok: true, engine, provider: deps.providers.get(engine) ?? null })
    return
  }
  if (ctx.method === "DELETE") {
    deps.providers.set(engine, undefined)
    deps.json(ctx.res, 200, { ok: true, engine, provider: null })
    return
  }
  throw new ApiError(404, "未知的中转站 API 路径")
}

export async function routeAgentModels(deps: ModelRouteDeps, ctx: ApiRequestContext): Promise<void> {
  const requested = ctx.url.searchParams.get("engine") ?? ""
  const engine = deps.registry.resolve(requested)
  if (!engine) throw new ApiError(400, `未知的 Agent 引擎：${requested || "(空)"}`)
  if (ctx.method === "GET") {
    deps.json(ctx.res, 200, { engine, models: deps.customModels.list(engine) })
    return
  }
  if (ctx.method === "POST") {
    const body = await deps.readJsonBody(ctx.req)
    try {
      const models = deps.customModels.add(engine, {
        value: typeof body.value === "string" ? body.value : "",
        label: typeof body.label === "string" ? body.label : "",
        baseURL: typeof body.baseURL === "string" && body.baseURL ? body.baseURL : undefined,
        apiKey: typeof body.apiKey === "string" && body.apiKey ? body.apiKey : undefined,
      })
      deps.json(ctx.res, 201, { ok: true, engine, models })
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "无法添加模型")
    }
    return
  }
  if (ctx.method === "DELETE") {
    if (!deps.customModels.remove(engine, ctx.url.searchParams.get("value") ?? "")) {
      throw new ApiError(404, "没有这个自定义模型")
    }
    deps.json(ctx.res, 200, { ok: true, engine, models: deps.customModels.list(engine) })
    return
  }
  throw new ApiError(404, "未知的模型 API 路径")
}

export async function routeCustomModels(deps: ModelRouteDeps,
  ctx: ApiRequestContext,
  key: string | undefined,
): Promise<void> {
    const models = deps.models
    if (ctx.method === "GET" && !key) {
      const custom = models.listCustomModels()
      deps.json(ctx.res, 200, {
        models: Object.entries(custom).map(([name, entry]) => customModelView(name, entry)),
        agents: models.listAgents().map((agent) => ({
          name: agent.name,
          model: agent.model,
          description: agent.description,
          mode: agent.mode,
        })),
      })
      return
    }
    if (ctx.method === "POST" && !key) {
      const body = await deps.readJsonBody(ctx.req)
      // The same positive-integer rule Telegram's `--context/--output` flags enforce
      const limitOf = (field: string, raw: unknown): number | undefined => {
        if (raw === undefined || raw === null) return undefined
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > 1_000_000_000) {
          throw new ApiError(400, `${field} 需要 1–1000000000 之间的整数`)
        }
        return raw
      }
      const input = {
        key: typeof body.key === "string" ? body.key : "",
        providerID: typeof body.providerID === "string" ? body.providerID : "",
        modelID: typeof body.modelID === "string" ? body.modelID : "",
        label: typeof body.label === "string" ? body.label : undefined,
        desc: typeof body.desc === "string" ? body.desc : undefined,
        attachment: typeof body.attachment === "boolean" ? body.attachment : undefined,
        contextWindow: limitOf("contextWindow", body.contextWindow),
        outputLimit: limitOf("outputLimit", body.outputLimit),
        // Optional: creates the provider block when opencode.json does not have it yet
        provider: (() => {
          const raw = asRecord(body.provider)
          if (!raw) return undefined
          const baseURL = typeof raw.baseURL === "string" ? raw.baseURL.trim() : ""
          if (!baseURL) return undefined
          return {
            baseURL,
            apiKey: typeof raw.apiKey === "string" && raw.apiKey ? raw.apiKey : undefined,
            npm: typeof raw.npm === "string" && raw.npm ? raw.npm : undefined,
          }
        })(),
      }
      if (!input.key || !input.providerID || !input.modelID) {
        throw new ApiError(400, "缺少 key、providerID 或 modelID 字段")
      }
      let added
      try {
        added = models.add(input)
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : "无法添加模型")
      }
      // Telegram spells out which capabilities landed, because a provider missing from
      // opencode.json silently keeps them; the App has to say the same thing.
      const capabilities = [
        input.attachment ? "支持图片输入" : "",
        input.contextWindow ? `上下文 ${input.contextWindow}` : "",
        input.outputLimit ? `输出上限 ${input.outputLimit}` : "",
      ].filter(Boolean)
      const capabilityNote =
        capabilities.length === 0
          ? ""
          : added.providerUpdated
            ? `已写入模型能力：${capabilities.join("、")}。`
            : `⚠️ 模型能力参数（${capabilities.join("、")}）未写入：Provider 不在项目 opencode.json 中。`
      deps.json(ctx.res, 200, {
        ok: true,
        message: `已添加自定义模型 ${added.key}（${input.providerID}/${input.modelID}）。${capabilityNote}`,
        model: customModelView(added.key, added.entry),
      })
      return
    }
    if (ctx.method === "DELETE" && key) {
      const force = ctx.url.searchParams.get("force") === "1"
      let removed
      try {
        removed = models.remove(key, force)
      } catch (err) {
        throw new ApiError(409, err instanceof Error ? err.message : "模型无法删除")
      }
      if (!removed) throw new ApiError(404, "自定义模型不存在")
      deps.json(ctx.res, 200, {
        ok: true,
        message: `已删除自定义模型 ${removed.key}。${removed.resetChats.length > 0 ? `已重置 ${removed.resetChats.length} 个会话的模型选择。` : ""}`,
        resetChats: removed.resetChats,
        resetAgents: removed.resetAgents,
      })
      return
    }
    throw new ApiError(404, "未知的模型 API 路径")
  }
