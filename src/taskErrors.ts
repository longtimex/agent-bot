import type { ApiTaskErrorCode } from "./apiTaskTypes.js"

export const TASK_ERROR_CODES: readonly ApiTaskErrorCode[] = [
  "ENGINE_UNAVAILABLE",
  "CLI_ARGUMENT_INVALID",
  "AUTH_FAILED",
  "MODEL_UNAVAILABLE",
  "TASK_TIMEOUT",
  "TASK_CANCELLED",
  "ATTACHMENT_FAILED",
  "UNKNOWN",
]

export function isTaskErrorCode(value: unknown): value is ApiTaskErrorCode {
  return typeof value === "string" && (TASK_ERROR_CODES as readonly string[]).includes(value)
}

/** Turn the engine's terminal error text into a stable code operators can grep for. */
export function classifyTaskError(detail: string): ApiTaskErrorCode {
  if (/已取消当前任务|任务已取消|aborted|cancelled|operation was aborted/i.test(detail)) return "TASK_CANCELLED"
  if (/未找到\s+\S+\s+可执行文件|ECONNREFUSED|fetch failed|bad port|network|socket|OpenCode.*(?:未运行|不可用|无法连接)|健康检查失败|请求失败.*(?:ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)/i.test(detail)) {
    return "ENGINE_UNAVAILABLE"
  }
  if (/unexpected argument|unknown argument|invalid option|命令行参数|argv|退出错误 \(代码 2\)/i.test(detail)) {
    return "CLI_ARGUMENT_INVALID"
  }
  if (/\b401\b|\b403\b|unauthorized|forbidden|authentication|认证|鉴权|api.?key|凭据/i.test(detail)) return "AUTH_FAILED"
  if (/未识别的模型|模型.*(?:不存在|不可用|不支持)|model.*(?:not found|unavailable|unsupported)/i.test(detail)) {
    return "MODEL_UNAVAILABLE"
  }
  if (/超时|timed?\s*out|timeout/i.test(detail)) return "TASK_TIMEOUT"
  if (/附件|attachment/i.test(detail)) return "ATTACHMENT_FAILED"
  return "UNKNOWN"
}

export function errorExitCode(detail: string): number | undefined {
  const match = /(?:退出错误 \(代码|exit code)\s+(\d+|null)\)?/i.exec(detail)
  if (!match || match[1] === "null") return undefined
  return Number(match[1])
}
