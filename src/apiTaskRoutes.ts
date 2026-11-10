import { accessSync, constants } from "node:fs"
import { ApiError, type ApiRequestContext } from "./apiCore.js"
import { clampLimit } from "./apiHttp.js"
import { MAX_TASK_RECORDS, type ApiTaskManager } from "./apiTasks.js"
import { multipartBoundary } from "./multipart.js"

export interface TaskRouteDeps {
  tasks: ApiTaskManager
  readJsonBody: (req: ApiRequestContext["req"]) => Promise<Record<string, unknown>>
  json: (res: ApiRequestContext["res"], status: number, body: unknown) => void
  expandAlias: (text: string) => string
  appKey: string
}

/** Returns true when the task/tasks/stop/queue route handled the request. */
export async function routeTasks(
  deps: TaskRouteDeps,
  ctx: ApiRequestContext,
  resource: string | undefined,
  id: string | undefined,
  action: string | undefined,
  segments: string[],
): Promise<boolean> {
  const { method } = ctx
  if (resource === "task" && method === "POST" && !id) {
      const boundary = multipartBoundary(ctx.req.headers["content-type"])
      if (boundary) {
        const form = await deps.tasks.parseMultipartTask(ctx.req, boundary)
        const text = form.text.trim()
        if (!text && (form.attachments?.length ?? 0) === 0) throw new ApiError(400, "缺少 text 字段")
        if (text.length > 12_000) throw new ApiError(400, "消息太长（上限 12000 字），请分段发送")
        const task = deps.tasks.submitSaved(deps.expandAlias(text), form.engine, form.model, form.attachments, form.failed)
        deps.json(ctx.res, 202, { task: deps.tasks.view(task) })
        return true
      }
      const body = await deps.readJsonBody(ctx.req)
      const text = typeof body.text === "string" ? body.text.trim() : ""
      const attachments = deps.tasks.parseAttachments(body.attachments)
      // Attachments-only tasks are allowed: #runTask fills in a default instruction per media kind.
      if (!text && (attachments?.length ?? 0) === 0) throw new ApiError(400, "缺少 text 字段")
      if (text.length > 12_000) throw new ApiError(400, "消息太长（上限 12000 字），请分段发送")
      // Same expansion the bot applies to /name messages, so shortcuts created in
      // either client work from both (built-in commands do not exist here).
      const expanded = deps.expandAlias(text)
      const engine = typeof body.engine === "string" && body.engine.trim() ? body.engine.trim() : undefined
      const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined
      const task = deps.tasks.submit(expanded, engine, model, attachments)
      deps.json(ctx.res, 202, { task: deps.tasks.view(task) })
      return true
    }

  if (resource === "task" && id && method === "GET" && !action) {
      const task = deps.tasks.get(id)
      if (!task) throw new ApiError(404, "任务不存在或已被清理")
      deps.json(ctx.res, 200, { task: deps.tasks.view(task) })
      return true
    }

  if (resource === "task" && id && action === "events" && method === "GET") {
      const task = deps.tasks.get(id)
      if (!task) throw new ApiError(404, "任务不存在或已被清理")
      if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
        // Already settled: a single snapshot response is friendlier than an
        // event stream that closes after one frame
        deps.json(ctx.res, 200, { task: deps.tasks.view(task) })
        return true
      }
      deps.tasks.streamEvents(ctx, task)
      return true
    }

  if (resource === "task" && id && method === "GET" && action === "media") {
      await deps.tasks.sendMedia(ctx, id, Number(segments[3]))
      return true
    }

  if (resource === "task" && id && method === "POST" && action === "stop") {
      const task = deps.tasks.stopTask(id)
      deps.json(ctx.res, 200, { ok: true, task: deps.tasks.view(task) })
      return true
    }

  if (resource === "task" && id && method === "POST" && action === "retry") {
      const failed = deps.tasks.get(id)
      if (!failed || failed.key !== deps.appKey) throw new ApiError(404, "任务不存在或已被清理")
      if (failed.status === "queued" || failed.status === "running") {
        throw new ApiError(409, "任务还在排队或执行中，请先停止")
      }
      // Telegram's /retry replays the captured prompt, so reuse the stored text,
      // engine, model pin and attachments instead of a text-only client copy.
      // The inbox copies remain file-backed; never read them into Base64 here.
      const source = failed.savedAttachments ?? []
      const readable: typeof source = []
      for (const saved of source) {
        try {
          accessSync(saved.path, constants.R_OK)
          readable.push(saved)
        } catch {
          // inbox pruning deletes copies older than a day
        }
      }
      const unreadable = source.length - readable.length
      if (!failed.text.trim() && readable.length === 0) {
        throw new ApiError(410, "任务的附件已从收件目录清理，无法只凭空提示词重试")
      }
      const note = unreadable > 0 ? `${failed.text}\n\n[附件处理失败]\n${unreadable} 个附件已从收件目录清理，本次重试无法读取` : failed.text
      const task = deps.tasks.submitSaved(note, failed.engine, failed.model, readable.length > 0 ? readable : undefined)
      deps.json(ctx.res, 202, { ok: true, retriedFrom: id, task: deps.tasks.view(task) })
      return true
    }

  if (resource === "tasks" && method === "GET") {
      const limit = clampLimit(ctx.url.searchParams.get("limit"), 50, MAX_TASK_RECORDS)
      // Unlike /queue this also answers the settled runs, which is what lets a client re-run
      // any of them through POST /task/:id/retry while the record is still retained.
      const tasks = deps.tasks.list(limit)
      deps.json(ctx.res, 200, { tasks: tasks.map((task) => deps.tasks.view(task)) })
      return true
    }

  if (resource === "stop" && method === "POST") {
      deps.json(ctx.res, 200, deps.tasks.stopAll())
      return true
    }

  if (resource === "queue" && method === "POST" && id === "clear") {
      deps.json(ctx.res, 200, deps.tasks.clearQueue())
      return true
    }

  if (resource === "queue" && method === "GET") {
      deps.json(ctx.res, 200, { tasks: deps.tasks.queue().map((task) => deps.tasks.view(task)) })
      return true
    }

  return false
}
