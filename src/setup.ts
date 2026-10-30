import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { createInterface } from "node:readline/promises"

const DEFAULT_DETECT_TIMEOUT_MS = 120_000
const API_TIMEOUT_MS = 20_000
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/

export interface SetupResult {
  ok: boolean
  token?: string
  users?: number[]
  botUsername?: string
  reason?: string
}

export interface SetupDeps {
  ask: (question: string) => Promise<string>
  print: (line?: string) => void
  fetch: typeof fetch
  envPath: string
  detectTimeoutMs?: number
}

interface BotInfo {
  id: number
  username?: string
  first_name?: string
}

interface TelegramUser {
  id: number
  username?: string
  first_name?: string
  is_bot?: boolean
}

interface TelegramUpdate {
  update_id: number
  message?: {
    chat?: { type?: string; id?: number }
    from?: TelegramUser
  }
}

export function canRunSetup(): boolean {
  const ci = (process.env.CI ?? "").toLowerCase()
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !["1", "true", "yes"].includes(ci)
}

export function isValidToken(token: string): boolean {
  return TOKEN_RE.test(token.trim())
}

export function maskToken(token: string): string {
  const [id = "", secret = ""] = token.split(":", 2)
  return `${id}:***${secret.length > 4 ? secret.slice(-4) : ""}`
}

export function parseUserIds(input: string): number[] {
  const ids: number[] = []
  for (const part of input.split(/[\s,，;；]+/)) {
    if (!/^\d{1,15}$/.test(part)) continue
    const id = Number(part)
    if (Number.isSafeInteger(id) && id > 0) ids.push(id)
  }
  return [...new Set(ids)]
}

export function upsertEnv(content: string, updates: Record<string, string>): string {
  // Every occurrence is rewritten, not just the first: dotenv takes the last value,
  // so a duplicate left with the old token would win after the wizard reports success.
  const written = new Set<string>()
  const lines = content ? content.replace(/\r\n/g, "\n").split("\n") : []
  const result = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (!match) return line
    const key = match[1] as string
    if (!Object.hasOwn(updates, key)) return line
    written.add(key)
    return `${key}=${formatEnvValue(updates[key]!)}`
  })
  const pending = Object.entries(updates).filter(([key]) => !written.has(key))
  if (pending.length > 0) {
    while (result.length > 0 && result[result.length - 1] === "") result.pop()
    if (result.length > 0) result.push("")
    result.push("# ---------- Telegram Bot（首次连接向导） ----------")
    for (const [key, value] of pending) result.push(`${key}=${formatEnvValue(value)}`)
  }
  const joined = result.join("\n").replace(/\n+$/, "")
  return joined ? `${joined}\n` : ""
}

export function writeEnvFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
  chmodSync(path, 0o600)
}

function formatEnvValue(value: string): string {
  return /[\s#"'\\]/.test(value) ? JSON.stringify(value) : value
}

function readEnvValues(content: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = (match[2] as string).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[match[1] as string] = value
  }
  return values
}

function redactToken(text: string, token: string): string {
  return token ? text.split(token).join(maskToken(token)) : text
}

async function apiCall<T>(
  deps: SetupDeps,
  token: string,
  method: string,
  payload?: Record<string, unknown>,
  timeoutMs = API_TIMEOUT_MS,
): Promise<T> {
  let response: Response
  try {
    response = await deps.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: payload ? "POST" : "GET",
      headers: payload ? { "content-type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new Error(redactToken(err instanceof Error ? err.message : String(err), token))
  }
  const body = (await response.json().catch(() => undefined)) as
    | { ok?: boolean; result?: T; description?: string }
    | undefined
  if (!response.ok || !body?.ok) {
    const detail = body?.description ?? `HTTP ${response.status}`
    throw new Error(redactToken(detail, token))
  }
  return body.result as T
}

async function waitForOwner(deps: SetupDeps, token: string): Promise<TelegramUser | undefined> {
  let offset = 0
  try {
    const last = await apiCall<TelegramUpdate[]>(deps, token, "getUpdates", { offset: -1, limit: 1, timeout: 0 }, 15_000)
    const updateId = Array.isArray(last) ? last[last.length - 1]?.update_id : undefined
    if (typeof updateId === "number") offset = updateId + 1
  } catch {
    // Draining pending updates is best-effort; the real poll below reports failures.
  }

  const deadline = Date.now() + (deps.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS)
  while (Date.now() < deadline) {
    const remaining = Math.max(1, Math.ceil((deadline - Date.now()) / 1000))
    const wait = Math.min(25, remaining)
    const updates = await apiCall<TelegramUpdate[]>(
      deps,
      token,
      "getUpdates",
      { offset, limit: 100, timeout: wait, allowed_updates: ["message"] },
      (wait + 10) * 1000,
    )
    for (const update of updates ?? []) {
      offset = Math.max(offset, update.update_id + 1)
      const message = update.message
      const from = message?.from
      if (!from || from.is_bot || message?.chat?.type !== "private") continue
      return from
    }
  }
  return undefined
}

async function yesNo(deps: SetupDeps, question: string, fallback: boolean): Promise<boolean> {
  const suffix = fallback ? "[Y/n]" : "[y/N]"
  while (true) {
    const answer = (await deps.ask(`${question} ${suffix} `)).trim().toLowerCase()
    if (!answer) return fallback
    if (["y", "yes", "是", "好", "1"].includes(answer)) return true
    if (["n", "no", "否", "0"].includes(answer)) return false
    deps.print("请输入 y 或 n。")
  }
}

function describeUser(user: TelegramUser): string {
  if (user.username) return `@${user.username}`
  return user.first_name ?? `用户 ${user.id}`
}

export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  const envPath = deps.envPath
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
  const values = readEnvValues(existing)

  deps.print("")
  deps.print("🤖 Telegram Bot 首次连接引导")
  deps.print("")
  deps.print("准备步骤：")
  deps.print("  1. 在 Telegram 搜索 @BotFather，发送 /newbot 创建机器人")
  deps.print("  2. 复制 BotFather 返回的 HTTP API Token")
  deps.print("  3. 保持本终端打开，稍后给新建的 Bot 发送一条消息")
  deps.print("")
  deps.print("Token 会显示在终端输入行中；如担心泄露，可先用 /revoke 重置。")
  deps.print("按 Ctrl+C 可随时退出。")
  deps.print("")

  let token = values.TELEGRAM_BOT_TOKEN
  if (token && isValidToken(token)) {
    if (!(await yesNo(deps, `检测到已有 Bot Token（${maskToken(token)}），继续使用？`, true))) {
      token = undefined
    }
  } else {
    token = undefined
  }

  while (!token) {
    const input = (await deps.ask("请粘贴 Bot Token（形如 123456789:AA...）：")).trim()
    if (!input) {
      deps.print("已取消，未做任何修改。")
      return { ok: false, reason: "cancelled" }
    }
    if (!isValidToken(input)) {
      deps.print("⚠️ Token 格式不正确，请确认复制了完整内容。")
      continue
    }
    token = input
  }

  let bot: BotInfo | undefined
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      bot = await apiCall<BotInfo>(deps, token, "getMe")
      break
    } catch (err) {
      deps.print(`⚠️ 连接 Telegram 失败：${err instanceof Error ? err.message : String(err)}`)
      if (attempt >= 3) break
      if (!(await yesNo(deps, "重试验证？", true))) break
    }
  }
  if (bot) {
    deps.print(`✅ 已连接 ${bot.username ? `@${bot.username}` : bot.first_name ?? `Bot ${bot.id}`}`)
  } else if (!(await yesNo(deps, "无法验证 Token（可能是网络问题）。仍然保存并继续？", false))) {
    deps.print("已取消，未做任何修改。")
    return { ok: false, reason: "unverified" }
  }

  let owner: TelegramUser | undefined
  if (bot?.username) {
    deps.print("")
    deps.print(`现在打开 Telegram，搜索 @${bot.username}，点击 Start 或发送任意消息。`)
    deps.print(`正在等待你的消息（最多 ${Math.round((deps.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS) / 1000)} 秒）…`)
    try {
      owner = await waitForOwner(deps, token)
    } catch (err) {
      deps.print(`⚠️ 无法自动识别用户：${err instanceof Error ? err.message : String(err)}`)
      deps.print("若提示 409 Conflict，说明该 Token 已有其他 Bot 实例在轮询，或设置了 Webhook。")
    }
    if (owner) {
      deps.print(`✅ 已识别 ${describeUser(owner)}（用户 ID ${owner.id}）`)
    } else {
      deps.print("未检测到消息，改为手动输入用户 ID。")
    }
  }

  const users: number[] = []
  if (owner && (await yesNo(deps, `将 ${describeUser(owner)} 加入白名单？`, true))) {
    users.push(owner.id)
  }
  if (users.length === 0) {
    while (users.length === 0) {
      const input = (await deps.ask("请输入允许使用的 Telegram 用户 ID（逗号分隔，可用 @userinfobot 获取）：")).trim()
      users.push(...parseUserIds(input))
      if (users.length === 0) deps.print("⚠️ 未识别到有效 ID，请输入数字，例如 123456789。")
    }
  } else {
    const extra = (await deps.ask("其他允许使用的用户 ID（可选，逗号分隔，回车跳过）：")).trim()
    const extraIds = parseUserIds(extra)
    if (extra && extraIds.length === 0) deps.print("⚠️ 未识别到有效 ID，已忽略。")
    for (const id of extraIds) if (!users.includes(id)) users.push(id)
  }

  deps.print("")
  deps.print("即将写入配置：")
  deps.print(`  文件：${envPath}（权限 0600）`)
  deps.print(`  TELEGRAM_BOT_TOKEN=${maskToken(token)}`)
  deps.print(`  TELEGRAM_ALLOW_USERS=${users.join(",")}`)
  if (!(await yesNo(deps, "确认保存？", true))) {
    deps.print("已取消，未做任何修改。")
    return { ok: false, reason: "cancelled" }
  }

  const updates: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_ALLOW_USERS: users.join(","),
  }
  // Re-read right before writing: the wizard can sit for minutes, and a value the
  // running bot stored meanwhile (e.g. a new whitelisted user) must not be reverted.
  const latest = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
  if (!latest) updates.TELEGRAM_ALLOW_ALL_USERS = "0"
  writeEnvFile(envPath, upsertEnv(latest, updates))

  deps.print("")
  deps.print("✅ 配置已保存。")
  deps.print("下一步：")
  deps.print("  npm run serve    # 如果 OpenCode 尚未运行")
  deps.print("  npm start        # 启动 Bot（或 npm run restart）")
  if (bot?.username) deps.print(`  在 Telegram 给 @${bot.username} 发送 /start 打开功能菜单`)
  return { ok: true, token, users, botUsername: bot?.username }
}

export async function setupFromCli(): Promise<SetupResult> {
  if (!canRunSetup()) {
    throw new Error("当前环境不是交互式终端，无法运行连接向导。请在终端中运行 npm run setup。")
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await runSetup({
      ask: (question) => rl.question(question),
      print: (line = "") => process.stdout.write(`${line}\n`),
      fetch: globalThis.fetch.bind(globalThis),
      envPath: resolve(".env"),
    })
  } finally {
    rl.close()
  }
}
