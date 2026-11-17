import type { AgentCliRegistry } from "./agentCli.js"
import type { AgentCustomModelStore } from "./agentCustomModels.js"
import { ApiError, type ApiRequestContext } from "./apiCore.js"
import { customModelView } from "./apiPersonal.js"
import type { ModelAdmin } from "./modelAdmin.js"

export interface ModelRouteDeps {
  models: ModelAdmin
  /** CLI engines and their hand-added models: a CLI takes the name as a plain --model. */
  registry: AgentCliRegistry
  customModels: AgentCustomModelStore
  json: (res: ApiRequestContext["res"], status: number, body: unknown) => void
  readJsonBody: (req: ApiRequestContext["req"]) => Promise<Record<string, unknown>>
}

/**
 * `GET/POST/DELETE /models/agent?engine=` — model ids the operator adds for a CLI engine.
 *
 * Discovery still wins: a hand-added entry only widens the list, it never hides what the CLI
 * reports for itself.
 */
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
