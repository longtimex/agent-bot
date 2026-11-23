import { ApiError, type ApiRequestContext } from "./apiCore.js"
import type { Opencode } from "./opencode.js"
import { INBOX_RETENTION_MS } from "./attachments.js"
import {
  deleteArchivedSession,
  startNewConversation,
  updateArchivedSession,
  resumeArchivedSession,
  staleAttachmentNotice,
  type ArchivedSession,
  type SessionArchiveStore,
} from "./sessionArchive.js"
import type { SessionStore } from "./store.js"

/** What the 历史会话 routes need from the server; passed in so api.ts stays within budget. */
export interface SessionRouteDeps {
  store: SessionStore
  archive: SessionArchiveStore
  oc: Opencode
  appKey: string
  engineLabel: (engine: string) => string
  modelLabel: (engine: string, model: string) => string
  requireIdle: (what: string) => void
  sessionView: () => Record<string, unknown>
  readJsonBody: (req: ApiRequestContext["req"]) => Promise<Record<string, unknown>>
  json: (res: ApiRequestContext["res"], status: number, body: unknown) => void
}

/** The App never sees the engine's own session id: it only ever names an archive entry. */
export function archivedView(deps: SessionRouteDeps, entry: ArchivedSession): Record<string, unknown> {
  const model = entry.model?.label ?? (entry.cliModel ? deps.modelLabel(entry.engine, entry.cliModel) : undefined)
  return {
    id: entry.id,
    engine: entry.engine,
    engineLabel: deps.engineLabel(entry.engine),
    ...(entry.title ? { title: entry.title } : {}),
    ...(model ? { model } : {}),
    archivedAt: entry.archivedAt,
    ...(entry.pinned ? { pinned: true } : {}),
    // The conversation open right now: it stays listed, the App marks it instead of hiding it
    ...(deps.store.getArchiveId(deps.appKey) === entry.id ? { current: true } : {}),
    // No engine session was ever recorded (a stateless CLI, or no run succeeded)
    ...(entry.sessionID ? {} : { stateless: true }),
  }
}

/**
 * Parks the chat's live session instead of deleting it. Returns undefined when there is no
 * context to keep. An OpenCode session pushed past the cap is deleted on the server, which is
 * the only place its disk space is reclaimed.
 */
export function archiveCurrentSession(deps: SessionRouteDeps, title?: string): Promise<ArchivedSession | undefined> {
  return startNewConversation(deps.store, deps.archive, deps.oc, deps.appKey, title)
}

/** GET /sessions, POST /sessions/:id/resume, DELETE /sessions/:id */
export async function routeSessions(
  ctx: ApiRequestContext,
  deps: SessionRouteDeps,
  id: string | undefined,
  action: string | undefined,
): Promise<void> {
  const key = deps.appKey
  if (!id && ctx.method === "GET") {
    deps.json(ctx.res, 200, { sessions: deps.archive.list(key).map((entry) => archivedView(deps, entry)) })
    return
  }
  if (id && action === "resume" && ctx.method === "POST") {
    deps.requireIdle("切换会话")
    const switched = await resumeArchivedSession(deps.store, deps.archive, deps.oc, key, id)
    if (!switched) throw new ApiError(404, "历史会话不存在或已被清理")
    const { target, parked, alreadyCurrent } = switched
    const stale = alreadyCurrent ? undefined : staleAttachmentNotice(target, INBOX_RETENTION_MS)
    deps.json(ctx.res, 200, {
      ok: true,
      message: alreadyCurrent
        ? `「${target.title ?? "这个会话"}」就是当前会话`
        : `已切回「${target.title ?? "历史会话"}」（${deps.engineLabel(target.engine)}）` +
          (parked ? "，刚才的会话已存入历史" : "") +
          (target.sessionID ? "" : "。该会话当时没有保存上下文，Agent 会从头开始") +
          (stale ? `。${stale}` : ""),
      session: deps.sessionView(),
      ...(parked ? { archived: archivedView(deps, parked) } : {}),
    })
    return
  }
  // Rename (an empty or null title clears it) and pin/unpin
  if (id && !action && ctx.method === "PUT") {
    const body = await deps.readJsonBody(ctx.req)
    const patch: { title?: string | null; pinned?: boolean } = {}
    if (body.title !== undefined) {
      if (body.title !== null && typeof body.title !== "string") throw new ApiError(400, "title 必须是字符串")
      patch.title = body.title as string | null
    }
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== "boolean") throw new ApiError(400, "pinned 必须是 true 或 false")
      patch.pinned = body.pinned
    }
    if (patch.title === undefined && patch.pinned === undefined) throw new ApiError(400, "请提供 title 或 pinned")
    const updated = updateArchivedSession(deps.store, deps.archive, key, id, patch)
    if (!updated) throw new ApiError(404, "历史会话不存在或已被清理")
    deps.json(ctx.res, 200, { ok: true, archived: archivedView(deps, updated) })
    return
  }
  if (id && !action && ctx.method === "DELETE") {
    if (!(await deleteArchivedSession(deps.archive, deps.oc, key, id, deps.store))) {
      throw new ApiError(404, "历史会话不存在或已被清理")
    }
    deps.json(ctx.res, 200, { ok: true, removed: true })
    return
  }
  throw new ApiError(404, "未知的会话操作")
}
