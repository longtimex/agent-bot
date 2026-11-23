/**
 * Conversation memory for stateless engines (Copilot, Antigravity, Kiro, dsh, Pi).
 *
 * Those CLIs run every prompt in a fresh process with no session to resume, so each message
 * reached them alone: a follow-up such as "再改短一点" had nothing to refer to. The last few turns
 * are kept beside the chat's session record and prepended to the next prompt. Engines that keep
 * their own session never use this; they already remember more, and better, than a transcript.
 */
export interface RecentTurn {
  q: string
  a: string
}

export const MAX_CONTEXT_TURNS = 4
const MAX_PROMPT_CHARS = 1_500
const MAX_REPLY_CHARS = 2_500

function clipMiddle(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  const head = Math.floor(max * 0.6)
  return `${trimmed.slice(0, head)}\n…（中间省略）…\n${trimmed.slice(trimmed.length - (max - head))}`
}

/** One stored turn, bounded so a long answer cannot crowd the next prompt out of argv. */
export function clipTurn(question: string, answer: string): RecentTurn {
  return { q: clipMiddle(question, MAX_PROMPT_CHARS), a: clipMiddle(answer, MAX_REPLY_CHARS) }
}

export function sanitizeTurns(value: unknown): RecentTurn[] | undefined {
  if (!Array.isArray(value)) return undefined
  const turns = value
    .filter((item): item is RecentTurn => Boolean(item) && typeof item.q === "string" && typeof item.a === "string")
    .map((item) => clipTurn(item.q, item.a))
    .slice(-MAX_CONTEXT_TURNS)
  return turns.length > 0 ? turns : undefined
}

/** The prompt a stateless engine receives: the recent turns as context, then the new message. */
export function withRecentTurns(turns: RecentTurn[], prompt: string): string {
  if (turns.length === 0) return prompt
  const history = turns.map((turn) => `用户：${turn.q}\n助手：${turn.a}`).join("\n\n")
  return (
    "[以下是本会话最近的对话，仅供理解上下文；请只回答最后的新消息，不要复述历史]\n\n" +
    `${history}\n\n[新消息]\n${prompt}`
  )
}
