export interface ParsedBotCommand {
  /** Lower-cased command token without the `@botname` suffix; empty for a plain message. */
  command: string
  /** Everything after the command token, trimmed. */
  arg: string
}

/**
 * Telegram appends `@botname` to a command in groups, and `/STOP` reaches the bot as often
 * as `/stop`, so the token is normalised before dispatch. A plain message comes back with an
 * empty command, which the caller treats as a task to run.
 */
export function parseBotCommand(text: string): ParsedBotCommand {
  const trimmed = text.trim()
  if (!trimmed) return { command: "", arg: "" }
  const raw = trimmed.split(/\s+/, 1)[0] ?? ""
  return { command: raw.toLowerCase().split("@")[0] ?? "", arg: trimmed.slice(raw.length).trim() }
}
