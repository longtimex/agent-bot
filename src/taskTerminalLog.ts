import type { ApiTask } from "./apiTaskTypes.js"
import type { Logger } from "./logger.js"
import { redactSecrets } from "./ccswitch.js"
import type { ApiTaskErrorCode } from "./apiTaskTypes.js"
import { classifyTaskError, errorExitCode } from "./taskErrors.js"
import type { UsageOutcome } from "./usage.js"

export interface TaskTerminalLoggerDeps {
  log: Logger
  session: (engine: string) => string | undefined
  mask?: (text: string) => string
}

/** Writes one stable, credential-free line per terminal task. */
export function logApiTaskTerminal(
  deps: TaskTerminalLoggerDeps,
  task: ApiTask,
  outcome: UsageOutcome,
  detail: string | undefined,
  started: number,
): void {
  const code: ApiTaskErrorCode | "-" = task.errorCode ?? (outcome === "ok" ? "-" : classifyTaskError(detail ?? ""))
  const exit = detail ? errorExitCode(detail) : undefined
  const reason = detail
    ? redactSecrets(detail).replace(/\s+/g, " ").slice(0, 300)
    : task.engineNote ?? "-"
  const line =
    `task=${task.id} engine=${task.engine} session=${deps.session(task.engine) ?? "-"} outcome=${outcome} ` +
    `exitCode=${exit ?? "-"} durationMs=${Date.now() - started} reason=${code} detail=${reason}`
  if (task.status === "failed") deps.log.warn(line)
  else deps.log.info(line)
}

export interface ChatTerminalTask {
  id?: string
  key: string
}

/** Writes the same terminal line for Telegram/Feishu tasks as the API task manager. */
export function logChatTaskTerminal(
  deps: TaskTerminalLoggerDeps,
  task: ChatTerminalTask,
  engine: string,
  outcome: UsageOutcome,
  detail: string | undefined,
  started: number,
): ApiTaskErrorCode | "-" {
  const code: ApiTaskErrorCode | "-" = outcome === "ok" ? "-" : classifyTaskError(detail ?? "")
  const exit = detail ? errorExitCode(detail) : undefined
  const reason = detail ? redactSecrets(deps.mask?.(detail) ?? detail).replace(/\s+/g, " ").slice(0, 300) : "-"
  const line =
    `task=${task.id ?? "-"} engine=${engine} session=${deps.session(engine) ?? "-"} outcome=${outcome} ` +
    `exitCode=${exit ?? "-"} durationMs=${Date.now() - started} reason=${code} detail=${reason}`
  if (outcome === "failed") deps.log.error(line)
  else deps.log.info(line)
  return code
}
