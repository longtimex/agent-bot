import type { IncomingMessage, ServerResponse } from "node:http"
import { ApiError, type ApiRequestContext } from "./apiCore.js"
import { clip } from "./messages.js"
import { redactSecrets, stripAnsi } from "./ccswitch.js"
import { magpieErrorText, type MagpieService } from "./magpie.js"
import { magpieBlockedReason, magpieConfirmPlan } from "./magpieGuards.js"
import {
  MAGPIE_EXEC,
  MAGPIE_VIEWS,
  assertMagpieArg,
  assertMagpieTarget,
} from "./apiMagpieSpecs.js"

export interface MagpieRouteDeps {
  magpie: MagpieService | undefined
  json: (res: ServerResponse, status: number, body: unknown) => void
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>
  magpieQuery: <T>(run: () => Promise<T>) => Promise<T>
}

const OUTPUT_LIMIT = 4000

function viewSpec(name: string) {
  return Object.hasOwn(MAGPIE_VIEWS, name) ? MAGPIE_VIEWS[name] : undefined
}

function execSpec(name: string) {
  return Object.hasOwn(MAGPIE_EXEC, name) ? MAGPIE_EXEC[name] : undefined
}

function clipped(text: string): string {
  const cleaned = redactSecrets(stripAnsi(text)).trim()
  return cleaned.length > OUTPUT_LIMIT ? `${clip(cleaned, OUTPUT_LIMIT)}…` : cleaned
}

/** Header lists mirror /cc/views: the App renders what the server ships, no hardcoding. */
function specLists(): Record<string, unknown> {
  return {
    views: Object.entries(MAGPIE_VIEWS).map(([name, spec]) => ({
      name,
      label: spec.label,
      needsTarget: spec.needsTarget ?? false,
      targetLabel: spec.targetLabel ?? "目标（可选）",
      // A view is read-only; the field is sent so one Kotlin model can decode both lists.
      confirm: false,
      long: spec.long ?? false,
    })),
    commands: Object.entries(MAGPIE_EXEC).map(([name, spec]) => ({
      name,
      label: spec.label,
      needsTarget: spec.needsTarget ?? false,
      targetLabel: spec.targetLabel ?? "目标（可选）",
      confirm: spec.confirm ?? false,
      long: spec.long ?? false,
    })),
  }
}

function targetFor(raw: unknown, spec: { needsTarget?: boolean; targetLabel?: string }): string {
  const value = typeof raw === "string" ? raw.trim() : ""
  if (!value) {
    if (spec.needsTarget) throw new ApiError(400, `「${spec.targetLabel ?? "目标"}」不能为空`)
    return ""
  }
  try {
    return assertMagpieTarget(value, spec.targetLabel ?? "目标")
  } catch (err) {
    throw new ApiError(400, magpieErrorText(err))
  }
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : String(item)))
  }
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean)
  return []
}

function argvFrom(value: unknown): string[] {
  try {
    return stringList(value).map(assertMagpieArg)
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : String(err))
  }
}

export async function routeMagpie(
  deps: MagpieRouteDeps,
  ctx: ApiRequestContext,
  id: string | undefined,
  action: string | undefined,
): Promise<void> {
  const magpie = deps.magpie
  if (!magpie && id !== "views") throw new ApiError(409, "当前运行环境不支持 magpie")

  // Overview: version + gateway health unlock the panel without shelling into every command.
  if (ctx.method === "GET" && !id) {
    const overview = await magpie!.overview()
    deps.json(ctx.res, 200, { ...overview, ...specLists() })
    return
  }

  if (ctx.method === "GET" && id === "views") {
    deps.json(ctx.res, 200, { available: magpie?.available ?? false, ...specLists() })
    return
  }

  if (ctx.method === "GET" && id === "view") {
    const name = ctx.url.searchParams.get("name") ?? ""
    const spec = viewSpec(name)
    if (!spec) throw new ApiError(400, `未知的视图，可用：${Object.keys(MAGPIE_VIEWS).join("、")}`)
    const target = targetFor(ctx.url.searchParams.get("target") ?? "", spec)
    try {
      const text = await deps.magpieQuery(() => magpie!.runRaw(spec.args(target)))
      deps.json(ctx.res, 200, { name, label: spec.label, text: clipped(text) })
    } catch (err) {
      throw new ApiError(502, magpieErrorText(err))
    }
    return
  }

  if (ctx.method === "POST" && id === "exec") {
    const body = await deps.readJsonBody(ctx.req)
    const name = typeof body.name === "string" ? body.name.trim() : ""
    const spec = execSpec(name)
    if (!spec) throw new ApiError(400, `未知的命令，可用：${Object.keys(MAGPIE_EXEC).join("、")}`)
    const target = targetFor(body.target, spec)
    if (spec.confirm && body.confirm !== true) {
      throw new ApiError(400, `需要确认：${spec.label}。带 confirm: true 重发。`)
    }
    try {
      const text = await deps.magpieQuery(() => magpie!.runRaw(spec.args(target)))
      deps.json(ctx.res, 200, { ok: true, name, label: spec.label, text: clipped(text) })
    } catch (err) {
      throw new ApiError(502, magpieErrorText(err))
    }
    return
  }

  // The generic escape hatch, equal to Telegram's `/magpie run …`.
  if (ctx.method === "POST" && id === "run") {
    const body = await deps.readJsonBody(ctx.req)
    const args = argvFrom(body.args)
    if (args.length === 0) throw new ApiError(400, "缺少 args")
    if (args.length > 24) throw new ApiError(400, "参数过多（上限 24 段）")
    if (args.join(" ").length > 2000) throw new ApiError(400, "参数总长超过 2000 字")
    const blocked = magpieBlockedReason(args, "App")
    if (blocked) throw new ApiError(400, blocked)
    const plan = magpieConfirmPlan(args)
    if (plan && body.confirm !== true) {
      throw new ApiError(400, `需要确认：${plan.label}。带 confirm: true 重发。`)
    }
    try {
      const text = await deps.magpieQuery(() => magpie!.runRaw(args))
      deps.json(ctx.res, 200, { ok: true, text: clipped(text) })
    } catch (err) {
      throw new ApiError(502, magpieErrorText(err))
    }
    return
  }

  // Writing a provider key needs a place that never echoes it back.
  if (ctx.method === "POST" && id === "provider") {
    const body = await deps.readJsonBody(ctx.req)
    const preset = typeof body.preset === "string" ? body.preset : ""
    const key = typeof body.key === "string" ? body.key : ""
    if (!preset || !key) throw new ApiError(400, "需要 preset 与 key")
    try {
      const text = await deps.magpieQuery(() => magpie!.addProvider(preset, key))
      deps.json(ctx.res, 200, { ok: true, text: clipped(text) })
    } catch (err) {
      throw new ApiError(400, magpieErrorText(err))
    }
    return
  }

  // Pick one agent's model (`magpie <agent> <model>`).
  if (ctx.method === "POST" && id === "agent") {
    const body = await deps.readJsonBody(ctx.req)
    const agent = typeof body.agent === "string" ? body.agent : ""
    const model = typeof body.model === "string" ? body.model : ""
    if (!agent || !model) throw new ApiError(400, "需要 agent 与 model")
    try {
      const text = await deps.magpieQuery(() => magpie!.setAgentModel(agent, model))
      deps.json(ctx.res, 200, { ok: true, text: clipped(text) })
    } catch (err) {
      throw new ApiError(400, magpieErrorText(err))
    }
    return
  }

  // Routing groups: `magpie group add <name> models=… routing=…`.
  if (ctx.method === "POST" && id === "group") {
    const body = await deps.readJsonBody(ctx.req)
    const name = typeof body.name === "string" ? body.name : ""
    const pairs = argvFrom(body.pairs)
    if (!name || pairs.length === 0) throw new ApiError(400, "需要 name 与 pairs（如 models=a/b,c/d）")
    try {
      const text = await deps.magpieQuery(() => magpie!.addGroup(name, pairs))
      deps.json(ctx.res, 200, { ok: true, text: clipped(text) })
    } catch (err) {
      throw new ApiError(400, magpieErrorText(err))
    }
    return
  }

  throw new ApiError(404, `未知的 magpie 接口：/magpie/${id ?? ""}${action ? `/${action}` : ""}`)
}
