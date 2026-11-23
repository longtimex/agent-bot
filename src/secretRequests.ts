import { secretNameProblem } from "./secretVault.js"

/**
 * An Agent asks for a secret by writing `[[secret: NAME | 用途]]` in its reply (documented in
 * .opencode/agent/assistant.md). The directive is removed from what the user sees and becomes a
 * 安全输入 card instead; inside a code block it is an example and stays as text.
 */
export interface SecretRequest {
  name: string
  purpose?: string
}

const DIRECTIVE = /\[\[\s*secret\s*:\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*(?:\|\s*([^\]\r\n]{0,200}?))?\s*\]\]/gi
const MAX_REQUESTS = 3

export function extractSecretRequests(reply: string): { text: string; requests: SecretRequest[] } {
  if (!/\[\[\s*secret\s*:/i.test(reply)) return { text: reply, requests: [] }
  const code = codeRanges(reply)
  const requests: SecretRequest[] = []
  const rejected: string[] = []
  const text = reply.replace(DIRECTIVE, (match, rawName: string, rawPurpose: string | undefined, offset: number) => {
    if (code.some(([from, to]) => offset >= from && offset < to)) return match
    const name = rawName.toUpperCase()
    const problem = secretNameProblem(name)
    if (problem) {
      rejected.push(`${name}（${problem}）`)
    } else if (!requests.some((request) => request.name === name) && requests.length < MAX_REQUESTS) {
      const purpose = rawPurpose?.trim()
      requests.push(purpose ? { name, purpose } : { name })
    }
    return ""
  })
  const notes = rejected.length > 0 ? `\n\n⚠️ 忽略了无效的密钥请求：${rejected.join("；")}` : ""
  return { text: `${text.replace(/\n{3,}/g, "\n\n").trim()}${notes}`, requests }
}

function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const match of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g)) {
    const start = match.index ?? 0
    ranges.push([start, start + match[0].length])
  }
  return ranges
}

/**
 * What the Agent is told once the user filled the cards. The values are never in it: it names the
 * secrets and where to read them, and repeats that they must not be echoed anywhere.
 */
export function secretContinuationPrompt(names: string[], dir: string): string {
  const files = names.map((name) => `${dir}/${name}`)
  return [
    `[安全输入] 用户已通过安全输入卡片提供：${names.join("、")}。值不在这条消息里，也没有发给你。`,
    "读取方式（只在任务执行期间可用）：",
    ...files.map((file) => `- 文件 ${file}（例如 "$(cat '${file}')"）`),
    `- CLI 引擎另有同名环境变量（${names.map((name) => `$${name}`).join("、")}）；部分 CLI 的命令沙箱会过滤这类变量，优先读文件。`,
    "请继续刚才的任务。不要在回复、日志、提交记录或任何文件里输出这些值，也不要把它们复制到别处。",
  ].join("\n")
}
