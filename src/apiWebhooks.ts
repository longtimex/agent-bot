import type { IncomingMessage, ServerResponse } from "node:http"
import { ApiError, type ApiRequestContext } from "./apiCore.js"
import type { AuthFailureLimiter } from "./apiRateLimit.js"
import type { NoticeStore } from "./appNotices.js"
import { redactSecrets } from "./ccswitch.js"
import { callEngine, resolveOpencodeModel, type EngineCallDeps } from "./engineCall.js"
import type { Logger } from "./logger.js"
import { findModel, resolveModelKey } from "./models.js"
import type { SessionStore } from "./store.js"
import {
  DEFAULT_SILENT_TOKEN,
  renderWebhookPrompt,
  verifyWebhookSignature,
  type WebhookConfig,
  type WebhookStore,
} from "./webhooks.js"

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024
const MAX_PENDING_PER_HOOK = 8

/** Per-hook FIFO queue so concurrent triggers never race on the same `hook:<id>` session. */
const hookQueues = new Map<string, { tail: Promise<void>; pending: number }>()

function resolveWebhookOpencodeModel(
  store: SessionStore,
  key: string,
  rawModel: string | undefined,
): ReturnType<typeof resolveOpencodeModel> {
  const trimmed = rawModel?.trim()
  if (trimmed) {
    const modelKey = resolveModelKey(trimmed)
    const known = modelKey ? findModel(modelKey) : undefined
    if (known) return { providerID: known.providerID, modelID: known.modelID, label: known.label }
    const slash = trimmed.indexOf("/")
    if (slash > 0 && slash < trimmed.length - 1) {
      return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1), label: trimmed }
    }
  }
  return resolveOpencodeModel(store, key)
}

function enqueueHookRun<T>(hookId: string, run: () => Promise<T>): Promise<T> {
  const current = hookQueues.get(hookId) ?? { tail: Promise.resolve(), pending: 0 }
  current.pending += 1
  const next = current.tail.then(run, run)
  const tail = next.then(
    () => undefined,
    () => undefined,
  )
  current.tail = tail
  hookQueues.set(hookId, current)
  void tail.finally(() => {
    current.pending = Math.max(0, current.pending - 1)
    if (current.pending === 0 && hookQueues.get(hookId) === current) hookQueues.delete(hookId)
  })
  return next
}

export interface WebhookExecDeps {
  webhooks: WebhookStore
  engineDeps: EngineCallDeps
  store: SessionStore
  log: Logger
  notices?: NoticeStore
  notifyOwner?: (text: string) => Promise<void>
  triggerBaseUrl?: () => string | undefined
}

export interface WebhookRouteDeps extends WebhookExecDeps {
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>
  json: (res: ServerResponse, status: number, body: unknown) => void
}

/** Runs one webhook prompt through the shared engine (serialized per hook id). */
export function executeWebhook(
  deps: WebhookExecDeps,
  hook: WebhookConfig,
  eventName: string,
  payloadText: string,
): Promise<{ status: "ok" | "silent" | "failed"; text: string }> {
  return enqueueHookRun(hook.id, async () => {
    const key = `hook:${hook.id}`
    const engine = hook.engine || deps.store.defaultEngine()
    const prompt = renderWebhookPrompt(hook, eventName, payloadText)
    const silentToken = hook.silentToken?.trim() || DEFAULT_SILENT_TOKEN

    try {
      const model = engine === "opencode" ? resolveWebhookOpencodeModel(deps.store, key, hook.model) : undefined
      const reply = await callEngine(deps.engineDeps, {
        key,
        engine,
        text: prompt,
        model,
        cliModel: engine === "opencode" ? undefined : hook.model,
      })
      const trimmed = reply.trim()
      if (!trimmed || trimmed === silentToken || trimmed.includes(silentToken)) {
        deps.webhooks.recordRun(hook.id, "silent", "静默忽略（无异常）")
        return { status: "silent", text: "事件已静默处理，未发送打扰通知" }
      }
      const clean = redactSecrets(trimmed)
      deps.webhooks.recordRun(hook.id, "ok", clean.slice(0, 180))
      const notice = `🪝 Webhook「${hook.name}」(${eventName})\n\n${clean.slice(0, 3200)}`
      deps.notices?.push({ kind: "system", text: notice })
      await deps.notifyOwner?.(notice).catch((err: unknown) => {
        deps.log.warn(`webhook notifyOwner failed (${hook.id}):`, err instanceof Error ? err.message : String(err))
      })
      return { status: "ok", text: clean }
    } catch (err) {
      const detail = redactSecrets(err instanceof Error ? err.message : String(err))
      deps.webhooks.recordRun(hook.id, "failed", detail)
      const notice = `⚠️ Webhook「${hook.name}」执行失败 (${eventName})\n${detail.slice(0, 1000)}`
      deps.notices?.push({ kind: "system", text: notice })
      await deps.notifyOwner?.(notice).catch(() => {})
      return { status: "failed", text: detail }
    }
  })
}

async function readBoundedRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"])
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, `Webhook 请求体超过 ${Math.round(maxBytes / 1024)}KB 上限`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.byteLength
    if (size > maxBytes) {
      req.pause()
      throw new ApiError(413, `Webhook 请求体超过 ${Math.round(maxBytes / 1024)}KB 上限`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/**
 * Handles unauthenticated-by-Bearer inbound `POST /api/v1/hooks/:id/trigger`.
 * Security relies on per-hook `X-Webhook-Secret` or `X-Hub-Signature-256` HMAC
 * plus the shared client rate limiter.
 */
export async function handleInboundWebhookTrigger(
  deps: WebhookExecDeps & {
    authLimit: AuthFailureLimiter
    json: (res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>) => void
  },
  req: IncomingMessage,
  res: ServerResponse,
  hookId: string,
  clientIp: string,
): Promise<void> {
  const limit = deps.authLimit.check(clientIp)
  if (!limit.allowed) {
    deps.json(res, 429, { error: `鉴权失败过多，请在 ${limit.retryAfterSec} 秒后重试` }, { "retry-after": String(limit.retryAfterSec) })
    return
  }

  let rawBody: Buffer
  try {
    rawBody = await readBoundedRawBody(req, MAX_WEBHOOK_BODY_BYTES)
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 400
    deps.json(res, status, { error: err instanceof Error ? err.message : "读取请求体失败" })
    return
  }

  const hook = deps.webhooks.get(hookId)
  if (!hook || !verifyWebhookSignature(hook.secret, req.headers, rawBody)) {
    deps.authLimit.recordFailure(clientIp)
    deps.json(res, 401, { error: "Webhook 鉴权失败（请提供有效的 X-Webhook-Secret 或 X-Hub-Signature-256）" })
    return
  }
  deps.authLimit.recordSuccess(clientIp)

  if (!hook.enabled) {
    deps.json(res, 409, { error: `Webhook「${hook.name}」已暂停` })
    return
  }

  const rawEvent =
    req.headers["x-github-event"] ??
    req.headers["x-gitlab-event"] ??
    req.headers["x-webhook-event"] ??
    "webhook"
  const eventName = Array.isArray(rawEvent) ? (rawEvent[0] ?? "webhook") : String(rawEvent)
  const payloadText = rawBody.toString("utf8").trim() || "{}"

  if ((hookQueues.get(hook.id)?.pending ?? 0) >= MAX_PENDING_PER_HOOK) {
    deps.json(res, 429, { error: `Webhook「${hook.name}」待处理事件过多，请稍后重试` })
    return
  }

  void executeWebhook(deps, hook, eventName, payloadText).catch((err: unknown) => {
    deps.log.warn(`webhook execution crashed (${hook.id}):`, err instanceof Error ? err.message : String(err))
  })

  deps.json(res, 202, {
    ok: true,
    accepted: true,
    hookId: hook.id,
    name: hook.name,
    event: eventName,
    message: `已受理 Webhook「${hook.name}」事件，正在后台由 AI 分析处理`,
  })
}

/** Bearer-authenticated CRUD & test endpoints: GET/POST /hooks, POST /hooks/:id/toggle|test, DELETE /hooks/:id. */
export async function routeWebhooks(
  deps: WebhookRouteDeps,
  ctx: ApiRequestContext,
  id: string | undefined,
  action: string | undefined,
): Promise<void> {
  const triggerBase = deps.triggerBaseUrl?.()

  if (!id && ctx.method === "GET") {
    deps.json(ctx.res, 200, {
      hooks: deps.webhooks.list(),
      ...(triggerBase ? { triggerBaseUrl: `${triggerBase}/api/v1/hooks` } : {}),
    })
    return
  }

  if (!id && ctx.method === "POST") {
    const body = await deps.readJsonBody(ctx.req)
    try {
      const hook = deps.webhooks.create({
        name: typeof body.name === "string" ? body.name : "",
        promptTemplate: typeof body.promptTemplate === "string" ? body.promptTemplate : "",
        engine: typeof body.engine === "string" ? body.engine : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
        silentToken: typeof body.silentToken === "string" ? body.silentToken : undefined,
      })
      deps.json(ctx.res, 201, {
        ok: true,
        message: `已创建 Webhook「${hook.name}」`,
        hook,
        hooks: deps.webhooks.list(),
        ...(triggerBase ? { triggerBaseUrl: `${triggerBase}/api/v1/hooks` } : {}),
      })
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "创建 Webhook 失败")
    }
    return
  }

  if (id && action === "toggle" && ctx.method === "POST") {
    const hook = deps.webhooks.toggle(id)
    if (!hook) throw new ApiError(404, "未找到该 Webhook")
    deps.json(ctx.res, 200, {
      ok: true,
      message: hook.enabled ? `已启用「${hook.name}」` : `已暂停「${hook.name}」`,
      hook,
      hooks: deps.webhooks.list(),
    })
    return
  }

  if (id && action === "test" && ctx.method === "POST") {
    const hook = deps.webhooks.get(id)
    if (!hook) throw new ApiError(404, "未找到该 Webhook")
    const body = await deps.readJsonBody(ctx.req)
    const eventName = typeof body.event === "string" && body.event.trim() ? body.event.trim() : "test"
    const payload =
      body.payload !== undefined
        ? (typeof body.payload === "string" ? body.payload : JSON.stringify(body.payload, null, 2))
        : JSON.stringify({ test: true, hook: hook.name, at: new Date().toISOString() }, null, 2)
    const result = await executeWebhook(deps, hook, eventName, payload)
    deps.json(ctx.res, 200, {
      ok: result.status !== "failed",
      status: result.status,
      message: result.status === "failed" ? `测试失败：${result.text}` : `测试完成（${result.status}）`,
      reply: result.text.slice(0, 1200),
      hook: deps.webhooks.get(id) ?? hook,
      hooks: deps.webhooks.list(),
    })
    return
  }

  if (id && !action && ctx.method === "DELETE") {
    const removed = deps.webhooks.remove(id)
    if (!removed) throw new ApiError(404, "未找到该 Webhook")
    deps.json(ctx.res, 200, {
      ok: true,
      message: `已删除 Webhook「${removed.name}」`,
      hooks: deps.webhooks.list(),
    })
    return
  }

  throw new ApiError(404, "未知的 Webhook 接口")
}
