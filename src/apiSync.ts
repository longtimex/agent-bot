import { ApiError, type ApiRequestContext } from "./apiCore.js"
import { peerSessions, type PersonalRouteDeps } from "./apiPersonal.js"
import type { ChatTranscriptStore, TranscriptMessage } from "./chatTranscript.js"

export interface SyncRouteDeps extends PersonalRouteDeps {
  transcripts?: ChatTranscriptStore
  /** Copies engine/model/dir AND live engine session id from peer into appKey. */
  handoffSession: (fromKey: string) => string[]
}

/** Routes GET /sync/messages and POST /sync/handoff for cross-client transcript recovery and handoff. */
export async function routeSync(
  deps: SyncRouteDeps,
  ctx: ApiRequestContext,
  id: string | undefined,
): Promise<void> {
  const peers = peerSessions(deps)
  if (id === "messages" && ctx.method === "GET") {
    const requestedScope = ctx.url.searchParams.get("scope")?.trim() || "app"
    const limitRaw = Number(ctx.url.searchParams.get("limit") ?? "60")
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(80, Math.floor(limitRaw)) : 60
    const peer = peers.find((entry) => entry.scope === requestedScope)
    const targetKey = peer?.key ?? (requestedScope === "app" ? deps.appKey : undefined)
    if (!targetKey) {
      deps.json(ctx.res, 200, { scope: requestedScope, count: 0, messages: [] })
      return
    }
    const messages: TranscriptMessage[] = deps.transcripts?.list(targetKey, limit) ?? []
    deps.json(ctx.res, 200, { scope: peer?.scope ?? "app", count: messages.length, messages })
    return
  }

  if (id === "handoff" && ctx.method === "POST") {
    if (deps.hasActiveTask()) throw new ApiError(409, "任务执行中，请先停止当前任务再接管对端会话")
    const body = await deps.readJsonBody(ctx.req)
    const defaultScope = peers.find((entry) => entry.scope !== "app")?.scope ?? "telegram"
    const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : defaultScope
    const peer = peers.find((entry) => entry.scope === scope && entry.key !== deps.appKey)
    if (!peer) throw new ApiError(409, "没有可接管的对端会话：请先在 Telegram 或飞书里与 Bot 对话一次")

    const changed = deps.handoffSession(peer.key)
    const messages = deps.transcripts ? deps.transcripts.copy(peer.key, deps.appKey) : []
    deps.json(ctx.res, 200, {
      ok: true,
      scope: peer.scope,
      message:
        `已接管${peer.label}` +
        (changed.length > 0 ? `（${changed.join("、")}）` : "") +
        (messages.length > 0 ? `，同步 ${messages.length} 条对话记录` : ""),
      session: deps.sessionView(),
      messages,
    })
    return
  }

  throw new ApiError(404, "未知的跨端同步接口")
}
