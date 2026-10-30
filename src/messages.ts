const FENCE_RE = /^\s*(```|~~~)/

/**
 * Truncates short display text. A cut between the halves of a surrogate pair leaves
 * a lone high surrogate, and Telegram rejects that with a 400 that silently stops
 * every later update to the same message.
 */
export function clip(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined
  const head = value.slice(0, Math.max(0, Math.floor(max)))
  const last = head.charCodeAt(head.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head
}

/**
 * Keeps the last `max` characters. Cutting the front of a string can leave a lone low
 * surrogate, which Telegram rejects with a 400 that discards the whole message.
 */
export function clipTail(value: string, max: number): string {
  const tail = value.slice(Math.max(0, value.length - Math.max(0, Math.floor(max))))
  const first = tail.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail
}

function pickCut(text: string, limit: number): number {
  let cut = text.lastIndexOf("\n", limit)
  if (cut < limit * 0.5) cut = text.lastIndexOf(" ", limit)
  if (cut < limit * 0.5) cut = limit
  // A hard cut must not land between the halves of a surrogate pair
  const last = text.charCodeAt(cut - 1)
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1
  return cut
}

interface MdState {
  /** Fence marker left unclosed by the chunk, if any. */
  fence: string | undefined
  /** Index of the last unmatched inline backtick, or -1 when inline code is balanced. */
  span: number
}

const BACKTICK = 0x60

function scanMd(chunk: string): MdState {
  let fence: string | undefined
  let span = -1
  let count = 0
  let offset = 0
  for (const line of chunk.split("\n")) {
    const marker = FENCE_RE.exec(line)?.[1]
    if (marker) {
      if (fence === marker) fence = undefined
      else if (!fence) fence = marker
    } else if (!fence) {
      for (let i = 0; i < line.length; i += 1) {
        if (line.charCodeAt(i) !== BACKTICK) continue
        count += 1
        span = offset + i
      }
    }
    offset += line.length + 1
  }
  return { fence, span: count % 2 === 0 ? -1 : span }
}

export function splitMessage(text: string, max: number): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const limit = Math.max(50, Math.floor(max))
  if (trimmed.length <= limit) return [trimmed]

  const chunks: string[] = []
  let rest = trimmed

  while (rest.length > limit) {
    let cut = pickCut(rest, limit)
    let head = rest.slice(0, cut)
    let state = scanMd(head)

    if (state.fence && state.fence.length + 1 > limit - head.trimEnd().length) {
      cut = pickCut(rest, limit - state.fence.length - 1)
      head = rest.slice(0, cut)
      state = scanMd(head)
    }

    // Telegram ends an inline code span at the message boundary, so a chunk that
    // closes inside one fails the Markdown parse and the whole chunk is resent as
    // plain text with every marker visible. Move the unfinished span to the next
    // message; only when it starts too early to be worth re-cutting do we close
    // and reopen it.
    let reopen = false
    if (state.span >= 0) {
      if (state.span >= Math.floor(limit * 0.4)) {
        cut = state.span
        head = rest.slice(0, cut)
        state = scanMd(head)
      } else {
        reopen = true
      }
    }

    let remainder = rest.slice(cut)
    let chunk: string
    if (state.fence) {
      // Close the block in this chunk and reopen it in the next, otherwise the
      // Telegram Markdown parse fails and the code block renders as raw text
      chunk = `${head.trimEnd()}\n${state.fence}`
      remainder = `${state.fence}\n${remainder.trimStart()}`
    } else if (reopen) {
      chunk = `${head.trimEnd()}\``
      remainder = `\`${remainder.trimStart()}`
    } else {
      chunk = head.trim()
      remainder = remainder.trimStart()
    }

    if (chunk) chunks.push(chunk)
    rest = remainder
  }

  if (rest) chunks.push(rest)
  return chunks
}
