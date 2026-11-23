import type { ApiTask } from "./apiTaskTypes.js"
import { RESUME_MAX_AGE_MS, type RecoveryPlan } from "./jobJournal.js"

/** The part of an App task a restart needs to show it again, or run it, under the same id. */
export type StoredApiTask = Pick<
  ApiTask,
  "id" | "key" | "text" | "engine" | "autoEngine" | "model" | "modelRef" | "createdAt" | "savedAttachments"
>

export function storedTask(task: ApiTask): StoredApiTask {
  const { id, key, text, engine, autoEngine, model, modelRef, createdAt, savedAttachments } = task
  return { id, key, text, engine, autoEngine, model, modelRef, createdAt, savedAttachments }
}

export const INTERRUPTED_ERROR =
  "服务重启时这条任务正在执行，已中断，没有自动重跑（可能已改过文件或产生费用）。需要的话点「重试」。"

/**
 * Turns what the previous process left into task records. A recent queued task comes back queued
 * and runs again; an interrupted one comes back failed and a stale one cancelled, each with the
 * reason, so the App's bubble says what happened and offers 重试 (which needs the record).
 */
export function recoveredTasks(
  plan: RecoveryPlan<StoredApiTask>,
  now = Date.now(),
): { resume: ApiTask[]; ended: ApiTask[]; summary?: string } {
  const ended: ApiTask[] = [
    ...plan.interrupted.map(
      (entry): ApiTask => ({ ...entry.payload, status: "failed", errorCode: "UNKNOWN", error: INTERRUPTED_ERROR, finishedAt: now }),
    ),
    ...plan.expired.map(
      (entry): ApiTask => ({
        ...entry.payload,
        status: "cancelled",
        errorCode: "TASK_CANCELLED",
        error: `排队超过 ${Math.round(RESUME_MAX_AGE_MS / 60_000)} 分钟，服务重启后没有自动执行。需要的话点「重试」。`,
        finishedAt: now,
      }),
    ),
  ]
  const resume = plan.resume.map((entry): ApiTask => ({ ...entry.payload, status: "queued" }))
  const total = resume.length + ended.length
  const summary =
    total > 0
      ? `${resume.length} resumed, ${plan.interrupted.length} interrupted, ${plan.expired.length} expired`
      : undefined
  return { resume, ended, summary }
}
