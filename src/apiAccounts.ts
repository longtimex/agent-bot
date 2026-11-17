import { ApiError, type ApiRequestContext } from "./apiCore.js"
import type { AccountEntry, AccountUpdate } from "./accounts.js"
import type { AppNotice } from "./appNotices.js"
import type { PersonalRouteDeps } from "./apiPersonal.js"

/**
 * The account vault and the App mailbox, split out of apiPersonal.ts so the reminder and
 * schedule routes there are not buried by them. Both answer from stores the bridge owns.
 */
function secretChannelError(): ApiError {
  return new ApiError(
    403,
    "保存密码需要加密通道：开启 API_ENCRYPTION=1 后在 Bot 里发 /api 重新扫码，或将 API_PUBLIC_URL 设为 https 地址；也可设 ALLOW_PLAINTEXT_SECRETS=1 接受明文",
  )
}
function accountView(entry: AccountEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    username: entry.username,
    // The ciphertext never leaves the server; the App only needs to know one exists.
    hasPassword: Boolean(entry.secret),
    url: entry.url,
    notes: entry.notes,
    tags: entry.tags,
    extras: entry.extras,
    updatedAt: entry.updatedAt,
  }
}

/**
 * Notices raised while no chat was bound. The App asks with the timestamp of the last one it
 * inserted, so a poll never repeats a reminder it has already shown.
 */
export async function routeNotices(deps: PersonalRouteDeps, ctx: ApiRequestContext): Promise<void> {
  if (ctx.method !== "GET") throw new ApiError(404, "未知的通知 API 路径")
  const raw = ctx.url.searchParams.get("since")
  const parsed = raw ? Number(raw) : Number.NaN
  const since = Number.isFinite(parsed) ? parsed : undefined
  const notices: AppNotice[] = deps.notices?.list(since) ?? []
  deps.json(ctx.res, 200, { notices })
}

/** `/account` for the App: the same store the Telegram bridge answers from. */
export async function routeAccounts(
  deps: PersonalRouteDeps,
  ctx: ApiRequestContext,
  id: string | undefined,
  action: string | undefined,
): Promise<void> {
  const accounts = deps.accounts
  if (!accounts) throw new ApiError(409, "当前运行环境不支持账号库")
  // A password must not cross a plaintext hop. The check sits on the requests that actually
  // carry one, so editing a note over plain HTTP still works on an unencrypted deployment.
  const plaintext = process.env.ALLOW_PLAINTEXT_SECRETS === "1"
  // An https public URL means the operator terminates TLS in front of us: the hop is
  // encrypted even though the request body carries no message-level envelope.
  const httpsDeployment = deps.cfg.api.publicUrl?.startsWith("https://") === true
  const guardSecret = (): void => {
    if (!ctx.encrypted && !httpsDeployment && !plaintext) throw secretChannelError()
  }
  if (ctx.method === "GET" && !id) {
    const { entries, categories, tags } = accounts.snapshot()
    deps.json(ctx.res, 200, {
      accounts: entries.map((entry) => accountView(entry)),
      categories,
      tags,
    })
    return
  }
  if (ctx.method === "POST" && !id) {
    const body = await deps.readJsonBody(ctx.req)
    if (typeof body.password === "string" && body.password) guardSecret()
    const name = typeof body.name === "string" ? body.name : ""
    if (!name.trim()) throw new ApiError(400, "缺少 name 字段，例如：{\"name\":\"GitHub\"}")
    try {
      const entry = accounts.add({
        name,
        username: typeof body.username === "string" ? body.username : "",
        password: typeof body.password === "string" ? body.password : undefined,
        category: typeof body.category === "string" ? body.category : undefined,
        url: typeof body.url === "string" ? body.url : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map((tag) => String(tag)) : undefined,
        extras: body.extras && typeof body.extras === "object" ? (body.extras as Record<string, string>) : undefined,
      })
      deps.json(ctx.res, 201, { ok: true, message: `已保存「${entry.name}」。`, account: accountView(entry) })
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "无法保存账号")
    }
    return
  }
  if (ctx.method === "PATCH" && id) {
    const body = await deps.readJsonBody(ctx.req)
    if (typeof body.password === "string" && body.password) guardSecret()
    const patch: AccountUpdate = {}
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim()
    if (typeof body.username === "string") patch.username = body.username
    if (body.password === null) patch.password = null
    else if (typeof body.password === "string") patch.password = body.password
    for (const key of ["category", "url", "notes"] as const) {
      if (!(key in body)) continue
      const value = body[key]
      patch[key] = value === null ? null : typeof value === "string" ? value : undefined
    }
    if (Array.isArray(body.tags)) patch.tags = body.tags.map((tag) => String(tag))
    if (body.extras && typeof body.extras === "object") patch.extras = body.extras as Record<string, string>
    try {
      const entry = accounts.update(id, patch)
      deps.json(ctx.res, 200, { ok: true, message: `已更新「${entry.name}」。`, account: accountView(entry) })
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "无法更新账号")
    }
    return
  }
  if (ctx.method === "POST" && id && action === "reveal") {
    guardSecret()
    const revealed = accounts.reveal(id)
    if (!revealed) throw new ApiError(404, "账号不存在")
    deps.json(ctx.res, 200, { ok: true, password: revealed.password })
    return
  }
  if (ctx.method === "DELETE" && id) {
    const removed = accounts.remove(id)
    if (!removed) throw new ApiError(404, "账号不存在")
    deps.json(ctx.res, 200, { ok: true, message: `已删除「${removed.name}」。` })
    return
  }
  throw new ApiError(404, "未知的账号库 API 路径")
}

