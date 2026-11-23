import { ApiError } from "./apiCore.js"
import type { ApiTask, ApiTaskView } from "./apiTaskTypes.js"
import { secretContinuationPrompt } from "./secretRequests.js"
import { activeSecretVault, secretValueProblem } from "./secretVault.js"

export interface SecretTaskHost {
  submit: (text: string, engine?: string, model?: string) => Promise<ApiTask>
  view: (task: ApiTask) => ApiTaskView
}

/**
 * The App's 安全输入 card: `POST /task/:id/secret {name, value}`. Only a name the task asked for
 * is accepted, the value goes straight into the vault, and once the last one is in the Agent's
 * continuation is queued on the same engine and returned so the App can follow it.
 */
export async function provideTaskSecret(
  host: SecretTaskHost,
  task: ApiTask,
  rawName: string,
  value: string,
): Promise<{ remaining: string[]; task?: ApiTaskView }> {
  const vault = activeSecretVault()
  if (!vault) throw new ApiError(503, "安全输入未启用")
  const name = rawName.trim().toUpperCase()
  const request = task.secretRequests?.find((item) => item.name === name)
  if (!request) throw new ApiError(404, "这条任务没有请求这个密钥")
  if (request.provided) throw new ApiError(409, "这个密钥已经提供过了")
  const problem = secretValueProblem(value)
  if (problem) throw new ApiError(400, problem)
  try {
    vault.set(task.key, name, value, request.purpose)
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : String(err))
  }
  request.provided = true
  const requests = task.secretRequests ?? []
  const remaining = requests.filter((item) => !item.provided).map((item) => item.name)
  if (remaining.length > 0) return { remaining }
  try {
    const next = await host.submit(
      secretContinuationPrompt(requests.map((item) => item.name), vault.dirFor(task.key)),
      task.autoEngine ? undefined : task.engine,
      task.autoEngine ? undefined : task.model,
    )
    return { remaining, task: host.view(next) }
  } catch (err) {
    // The value is kept; the App may submit again once the queue has room
    request.provided = false
    throw err
  }
}

export function listSecrets(chat: string): { secrets: Array<{ name: string; purpose?: string; expiresAt: number }> } {
  return { secrets: activeSecretVault()?.list(chat) ?? [] }
}

export function clearSecrets(chat: string): { cleared: number } {
  return { cleared: activeSecretVault()?.clear(chat) ?? 0 }
}
