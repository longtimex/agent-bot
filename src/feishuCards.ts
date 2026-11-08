import type { InlineKeyboard } from "grammy"

const MAX_BUTTONS_PER_ROW = 4
const MAX_TEXT_BUTTONS = 30
const MAX_CARD_MARKDOWN = 25_000

export interface FeishuCardAction {
  data: string
}

export interface FeishuButton {
  text: string
  data?: string
  url?: string
}

interface CardElement {
  tag: string
  [key: string]: unknown
}

export interface FeishuCard {
  config: { wide_screen_mode: boolean; update_multi: boolean }
  elements: CardElement[]
}

/**
 * Panels are authored in Telegram Markdown: `*bold*`, `_italic_`, backslash
 * escapes and `--` dashes. Feishu's markdown element uses CommonMark, where a
 * single asterisk is italic. Converting only the common Telegram forms keeps
 * the visual result close without a full Markdown rewriter; unsupported markup
 * still renders as literal text and never blocks delivery.
 */
export function telegramMarkdownToFeishu(text: string): string {
  let out = text
  // Backslash escapes are Telegram-specific; Feishu renders the backslash itself.
  out = out.replace(/\\([_*`[\]\\])/g, "$1")
  // Telegram bold *text* -> Feishu bold **text**. Do not touch **text** or
  // fenced code, and require a non-space on both sides.
  out = out.replace(/(^|[^*])\*(?!\*)(\S(?:[^*\n]*?\S)?)\*(?!\*)/g, "$1**$2**")
  // A horizontal rule written as --- must not be swallowed as three dashes.
  out = out.replace(/^---+$/gm, "---")
  return out
}

/** Telegram callback data is opaque here; it becomes the button action value. */
export function keyboardToFeishuActions(keyboard?: InlineKeyboard): CardElement[] {
  const rows = keyboard?.inline_keyboard
  if (!rows || rows.length === 0) return []
  const actions: CardElement[] = []
  let count = 0
  for (const row of rows) {
    if (count >= MAX_TEXT_BUTTONS) break
    const buttons: CardElement[] = []
    for (const button of row) {
      if (count >= MAX_TEXT_BUTTONS) break
      const label = ("text" in button && button.text) || ("label" in button && String(button.label)) || "按钮"
      if ("url" in button && button.url) {
        buttons.push({ tag: "button", text: { tag: "plain_text", content: label }, type: "default", url: button.url })
      } else if ("callback_data" in button && button.callback_data) {
        buttons.push({
          tag: "button",
          text: { tag: "plain_text", content: label },
          type: "default",
          value: { data: button.callback_data },
        })
      } else {
        // Unsupported Telegram-only button types become inert labels instead of
        // producing a card that Feishu refuses wholesale.
        buttons.push({ tag: "button", text: { tag: "plain_text", content: label }, type: "default", disabled: true })
      }
      count += 1
      if (buttons.length >= MAX_BUTTONS_PER_ROW) break
    }
    if (buttons.length > 0) actions.push({ tag: "action", actions: buttons, layout: "flow" })
  }
  return actions
}

/**
 * Cards are the only Feishu message type that supports inline callbacks, so
 * every panel and text reply becomes an interactive card. Text is capped well
 * below Feishu's element limit; long replies have already been split by the
 * outbound pipeline before they reach here.
 */
export function buildFeishuCard(text: string, keyboard?: InlineKeyboard): FeishuCard {
  const markdown = telegramMarkdownToFeishu(text)
  const clipped = markdown.length > MAX_CARD_MARKDOWN ? `${markdown.slice(0, MAX_CARD_MARKDOWN - 20)}\n\n…（已截断）` : markdown
  return {
    config: { wide_screen_mode: true, update_multi: true },
    elements: [
      { tag: "markdown", content: clipped || "（无内容）" },
      ...keyboardToFeishuActions(keyboard),
    ],
  }
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  if (typeof record.text === "string") return record.text
  if (typeof record.content === "string") return record.content
  if (Array.isArray(record.content)) return record.content.map(textOf).join("")
  return ""
}

/**
 * Feishu's card action payload has appeared both at the root and under
 * `context`. This accepts either shape and also tolerates the older SDK's
 * `open_id` layout, so an SDK upgrade cannot silently drop every button press.
 */
export function parseFeishuCardAction(raw: unknown): {
  openMessageId: string
  openChatId?: string
  openId: string
  data: string
  eventId?: string
  token?: string
} | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  const context = record.context && typeof record.context === "object" ? (record.context as Record<string, unknown>) : {}
  const operator = record.operator && typeof record.operator === "object" ? (record.operator as Record<string, unknown>) : {}
  const action = record.action && typeof record.action === "object" ? (record.action as Record<string, unknown>) : {}
  const openMessageId = String(context.open_message_id ?? record.open_message_id ?? "")
  const openChatId = String(context.open_chat_id ?? record.open_chat_id ?? "") || undefined
  const openId = String(operator.open_id ?? record.open_id ?? "")
  const eventId = String(record.event_id ?? "") || undefined
  const token = String(record.token ?? "") || undefined
  const value = action.value
  if (!openMessageId || !openId) return undefined
  const data =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && typeof (value as Record<string, unknown>).data === "string"
        ? String((value as Record<string, unknown>).data)
        : textOf(action.value)
  if (!data) return undefined
  return { openMessageId, openChatId, openId, data, eventId, token }
}

export function cardButtonValue(button: FeishuButton): Record<string, string> {
  return button.data ? { data: button.data } : { url: button.url ?? "" }
}
