export function splitMessage(text: string, max: number): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const limit = Math.max(50, Math.floor(max))
  if (trimmed.length <= limit) return [trimmed]

  const chunks: string[] = []
  let rest = trimmed

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit)
    if (cut < limit * 0.5) cut = limit

    const chunk = rest.slice(0, cut).trim()
    if (chunk) chunks.push(chunk)
    rest = rest.slice(cut).trimStart()
  }

  if (rest) chunks.push(rest)
  return chunks
}
