import type { Logger } from "./logger.js"
import type { TaskHistoryStore } from "./history.js"
import type { UsageOutcome, UsageStore } from "./usage.js"
import { classifyTaskError } from "./taskErrors.js"
import { logChatTaskTerminal, type ChatTerminalTask } from "./taskTerminalLog.js"

export interface ChatTaskOutcomeDeps {
  log: Logger
  usage: UsageStore
  history: TaskHistoryStore
  session: (key: string, engine: string) => string | undefined
  mask: (text: string) => string
}

export interface ChatTaskOutcomeInput {
  task: ChatTerminalTask & { text: string; scheduled?: boolean }
  engine: string
  model?: string
  outcome: UsageOutcome
  detail?: string
  ms: number
  startedAt: number
}

/** Records usage, history and the one terminal log line for a Telegram/Feishu run. */
export class ChatTaskOutcomeRecorder {
  readonly #deps: ChatTaskOutcomeDeps

  constructor(deps: ChatTaskOutcomeDeps) {
    this.#deps = deps
  }

  record(input: ChatTaskOutcomeInput): void {
    const errorCode = input.outcome === "ok" ? undefined : classifyTaskError(input.detail ?? "")
    logChatTaskTerminal(
      {
        log: this.#deps.log,
        session: (engine) => this.#deps.session(input.task.key, engine),
        mask: this.#deps.mask,
      },
      input.task,
      input.engine,
      input.outcome,
      input.detail,
      input.startedAt,
    )
    this.#deps.usage.record(input.task.key, {
      engine: input.engine,
      model: input.model,
      ms: input.ms,
      outcome: input.outcome,
    })
    this.#deps.history.record(input.task.key, {
      prompt: input.task.text,
      engine: input.engine,
      model: input.model,
      ms: input.ms,
      outcome: input.outcome,
      errorCode,
      detail: input.detail,
      scheduled: input.task.scheduled,
    })
  }
}

export function chatTaskOutcomeRecorder(
  log: Logger,
  usage: UsageStore,
  history: TaskHistoryStore,
  store: { get(key: string): string | undefined; getCliSession(key: string, engine: string): string | undefined },
  mask: (text: string) => string,
): ChatTaskOutcomeRecorder {
  return new ChatTaskOutcomeRecorder({
    log,
    usage,
    history,
    session: (key, engine) => (engine === "opencode" ? store.get(key) : store.getCliSession(key, engine)),
    mask,
  })
}
