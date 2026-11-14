import { clip, clipTail } from "./messages.js"

const MAX_STEP_OUTPUT = 1500
const MAX_FAILURE_DIGEST = 600

/**
 * Test runners print failing names in the middle of their output while the summary at the
 * end carries only counts. Cutting just the tail therefore tells an operator that five
 * tests failed but not which five. Keep every `not ok` line and the first diagnostic line
 * beneath it, bounded so a broken reporter cannot crowd out useful output.
 */
export function failureDigest(text: string, max: number): string {
  const lines = text.split("\n")
  const picked: string[] = []
  for (let i = 0; i < lines.length && picked.length < 40; i += 1) {
    if (!/^\s*not ok\b/.test(lines[i]!)) continue
    picked.push(lines[i]!.trim())
    const next = lines.slice(i + 1, i + 8).find((line) => /^\s*(error|code|failureType):/.test(line))
    if (next) picked.push(next.trim())
  }
  if (picked.length === 0) return ""
  const digest = ["失败明细：", ...picked.map((line) => `- ${line}`)].join("\n")
  return digest.length <= max ? digest : `${clip(digest, max - 1) ?? ""}…`
}

/** Bounded stdout/stderr for one ops step, with failing test names kept above the fold. */
export function summarizeStepOutput(text: string): string {
  if (text.length <= MAX_STEP_OUTPUT) return text
  const failures = failureDigest(text, MAX_FAILURE_DIGEST)
  const budget = MAX_STEP_OUTPUT - failures.length - (failures ? 30 : 4)
  const head = Math.max(40, Math.floor(budget / 2))
  const tail = Math.max(40, budget - head)
  // The halves go back to Telegram, which rejects a cut that splits a surrogate pair
  return `${failures}${failures ? "\n" : ""}${clip(text, head) ?? ""}\n…\n${clipTail(text, tail)}`
}
