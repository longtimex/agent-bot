import { ApiError, type ApiRequestContext } from "./apiCore.js"
import type { Opencode } from "./opencode.js"
import { INBOX_RETENTION_MS } from "./attachments.js"
import {
  archiveLiveSession,
  deleteArchivedSession,
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
  }
}

/**
 * Parks the chat's live session instead of deleting it. Returns undefined when there is no
 * context to keep. An OpenCode session pushed past the cap is deleted on the server, which is
 * the only place its disk space is reclaimed.
 */
export function archiveCurrentSession(deps: SessionRouteDeps, title?: string): Promise<ArchivedSession | undefined> {
  return archiveLiveSession(deps.store, deps.archive, deps.oc, deps.appKey, title)
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
    const { target, parked } = switched
    const stale = staleAttachmentNotice(target, INBOX_RETENTION_MS)
    deps.json(ctx.res, 200, {
      ok: true,
      message:
        `已切回「${target.title ?? "历史会话"}」（${deps.engineLabel(target.engine)}）` +
        (parked ? "，刚才的会话已存入历史" : "") +
        (stale ? `。${stale}` : ""),
      session: deps.sessionView(),
      ...(parked ? { archived: archivedView(deps, parked) } : {}),
    })
    return
  }
  if (id && !action && ctx.method === "DELETE") {
    if (!(await deleteArchivedSession(deps.archive, deps.oc, key, id))) {
      throw new ApiError(404, "历史会话不存在或已被清理")
    }
    deps.json(ctx.res, 200, { ok: true, removed: true })
    return
  }
  throw new ApiError(404, "未知的会话操作")
}
