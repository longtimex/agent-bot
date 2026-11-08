import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import {
  controlClientEvidence,
  FEISHU_APP_ID_RE,
  FEISHU_OPEN_ID_RE,
  isConcreteApiBind,
  isLoopbackApiBind,
  parseApiPublicUrl,
} from "./config.js"

const DEFAULT_DETECT_TIMEOUT_MS = 120_000
const API_TIMEOUT_MS = 20_000
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/

export interface SetupResult {
  ok: boolean
  token?: string
  users?: number[]
  botUsername?: string
  /** Selected clients in this run; useful for printing next steps without reloading .env. */
  clients?: SetupClient[]
  /** Android pairing details, printed after the wizard writes them. */
  api?: {
    url?: string
    token: string
  }
  /** Values written to `.env`, so an in-process first-run wizard can apply them immediately. */
  updates?: Record<string, string>
  reason?: string
}

export type SetupClient = "telegram" | "feishu" | "android"

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

const CLIENT_LABELS: Record<SetupClient, string> = {
  telegram: "Telegram",
  android: "安卓 App",
  feishu: "飞书",
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

/** Accepts `1,3`, `1 3`, client names, or `a` / `all` for every client. */
export function parseClientSelection(input: string): SetupClient[] {
  const raw = input.trim().toLowerCase()
  if (["a", "all", "*", "全部", "所有"].includes(raw)) return ["telegram", "android", "feishu"]
  const selected = new Set<SetupClient>()
  for (const part of raw.split(/[\s,，;；、]+/)) {
    if (!part) continue
    if (part === "1" || part === "telegram" || part === "tg") selected.add("telegram")
    else if (part === "2" || part === "android" || part === "app" || part === "安卓") selected.add("android")
    else if (part === "3" || part === "feishu" || part === "lark" || part === "飞书") selected.add("feishu")
  }
  return (["telegram", "android", "feishu"] as const).filter((client) => selected.has(client))
}

/** Feishu open_ids are comma separated in `.env`; accept common Chinese separators too. */
export function parseFeishuOpenIds(input: string): string[] {
  const ids = input
    .split(/[\s,，;；]+/)
    .map((id) => id.trim())
    .filter(Boolean)
  return [...new Set(ids)]
}

export function upsertEnv(
  content: string,
  updates: Record<string, string>,
  section = "Telegram Bot（首次连接向导）",
): string {
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
    result.push(`# ---------- ${section} ----------`)
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
  return { ok: true, token, users, botUsername: bot?.username, clients: ["telegram"], updates }
}

function readEnvState(envPath: string): Record<string, string> {
  return readEnvValues(existsSync(envPath) ? readFileSync(envPath, "utf8") : "")
}

/** Re-read immediately before writing so edits made while a prompt was open are preserved. */
function persistEnv(envPath: string, updates: Record<string, string>, section: string): void {
  const latest = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
  writeEnvFile(envPath, upsertEnv(latest, updates, section))
}

function envBool(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase())
}

function maskApiToken(token: string): string {
  if (token.length <= 10) return "***"
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

function callbackPathValid(path: string): boolean {
  return /^\/[A-Za-z0-9._~/-]+$/.test(path) && !path.includes("//")
}

function apiUrlFor(bind: string, port: number): string | undefined {
  if (!isConcreteApiBind(bind)) return undefined
  return `http://${bind.includes(":") ? `[${bind}]` : bind}:${port}`
}

function apiUrlLoopback(value: string): boolean {
  try {
    return isLoopbackApiBind(new URL(value).hostname)
  } catch {
    return true
  }
}

async function askPort(deps: SetupDeps, label: string, fallback: number): Promise<number> {
  while (true) {
    const raw = (await deps.ask(`${label} [${fallback}]：`)).trim()
    if (!raw) return fallback
    const port = Number(raw)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port
    deps.print("⚠️ 端口需为 1–65535 的整数，请重试。")
  }
}

export async function runAndroidSetup(deps: SetupDeps): Promise<SetupResult> {
  const values = readEnvState(deps.envPath)
  const existingBind = values.API_BIND?.trim()
  const suggestedBind = existingBind && !isLoopbackApiBind(existingBind) ? existingBind : "0.0.0.0"
  const existingPort = Number(values.API_PORT ?? "")
  const port = Number.isInteger(existingPort) && existingPort >= 1 && existingPort <= 65535 ? existingPort : 3080
  const existingUrl = values.API_PUBLIC_URL?.trim()

  deps.print("")
  deps.print("📱 安卓 App 控制端配置")
  deps.print("")
  deps.print("App 通过 HTTP API 连接 Bot。手机必须能访问 API_PUBLIC_URL；")
  deps.print("若前面有反向代理 / SSH 隧道 / VPN，API_BIND 保持 127.0.0.1 即可；")
  deps.print("局域网直连时通常监听 0.0.0.0，并填写服务器的局域网 IP。")
  deps.print("按 Ctrl+C 可随时退出。")
  deps.print("")

  let bind: string
  while (true) {
    const input = (
      await deps.ask(`API 监听地址 API_BIND（反向代理填 127.0.0.1） [${suggestedBind}]：`)
    ).trim()
    bind = input || suggestedBind
    if (bind && !/[\s/?#]/.test(bind)) break
    deps.print("⚠️ 监听地址格式不正确，请填写 IP 或主机名，例如 0.0.0.0、127.0.0.1、192.168.1.10。")
  }

  const apiPort = await askPort(deps, "API 监听端口 API_PORT", port)
  let publicUrl: string | undefined
  while (!publicUrl) {
    const fallback = existingUrl || apiUrlFor(bind, apiPort) || ""
    const hint = fallback ? ` [${fallback}]` : ""
    const input = (
      await deps.ask(
        `手机访问地址 API_PUBLIC_URL${hint}（局域网如 http://192.168.1.10:${apiPort}；反向代理如 https://bot.example.com）：`,
      )
    ).trim()
    const candidate = input || fallback
    if (!candidate) {
      deps.print("⚠️ 当前是回环/通配监听，无法推断手机地址。请填写 API_PUBLIC_URL，或改为反向代理/隧道。")
      continue
    }
    try {
      const parsed = parseApiPublicUrl(candidate)!
      if (apiUrlLoopback(parsed)) {
        deps.print("⚠️ API_PUBLIC_URL 指向本机回环地址，手机无法访问，请填写手机可达的地址。")
        continue
      }
      publicUrl = parsed
    } catch (err) {
      deps.print(`⚠️ ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let token = values.API_TOKEN?.trim()
  if (token) {
    deps.print(`检测到已有 API Token（${maskApiToken(token)}）。`)
    if (!(await yesNo(deps, "继续使用现有 Token？", true))) token = undefined
  }
  if (!token) token = randomBytes(24).toString("hex")

  deps.print("")
  deps.print("即将写入配置：")
  deps.print(`  文件：${deps.envPath}（权限 0600）`)
  deps.print("  API_ENABLED=1")
  deps.print(`  API_BIND=${bind}`)
  deps.print(`  API_PORT=${apiPort}`)
  deps.print(`  API_PUBLIC_URL=${publicUrl}`)
  deps.print(`  API_TOKEN=${maskApiToken(token)}`)
  if (!(await yesNo(deps, "确认保存？", true))) {
    deps.print("已取消，未做任何修改。")
    return { ok: false, reason: "cancelled" }
  }

  const updates: Record<string, string> = {
    API_ENABLED: "1",
    API_BIND: bind,
    API_PORT: String(apiPort),
    API_PUBLIC_URL: publicUrl,
    API_TOKEN: token,
  }
  persistEnv(deps.envPath, updates, "HTTP API（安卓 App 首次连接向导）")

  deps.print("")
  deps.print("✅ 安卓 App 配置已保存。")
  deps.print("配对信息：")
  deps.print(`  API 地址：${publicUrl}/api/v1`)
  deps.print(`  访问令牌：${token}`)
  deps.print("在 App 的「设置」页手动填写，或由 Telegram / 飞书发送 /api 获取扫码配对二维码。")
  return { ok: true, clients: ["android"], api: { url: publicUrl, token }, updates }
}

async function verifyFeishuCredentials(deps: SetupDeps, appId: string, appSecret: string): Promise<void> {
  let response: Response
  try {
    response = await deps.fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
  const body = (await response.json().catch(() => undefined)) as
    | { code?: number; msg?: string; tenant_access_token?: string }
    | undefined
  if (!response.ok || body?.code !== 0 || !body.tenant_access_token) {
    throw new Error(body?.msg ?? `HTTP ${response.status}`)
  }
}

export async function runFeishuSetup(deps: SetupDeps): Promise<SetupResult> {
  const values = readEnvState(deps.envPath)

  deps.print("")
  deps.print("💬 飞书控制端配置")
  deps.print("")
  deps.print("准备步骤：")
  deps.print("  1. 在飞书开放平台创建企业自建应用，启用「机器人」能力")
  deps.print("  2. 在「凭证与基础信息」复制 App ID 与 App Secret")
  deps.print("  3. 在「事件与回调 → 事件配置」选择长连接，订阅 im.message.receive_v1")
  deps.print("  4. 在「权限管理」开通消息收发与资源读取权限，并发布应用版本")
  deps.print("按 Ctrl+C 可随时退出。")
  deps.print("")

  let appId = values.FEISHU_APP_ID?.trim()
  if (appId && FEISHU_APP_ID_RE.test(appId)) {
    if (!(await yesNo(deps, `检测到已有 App ID（${appId}），继续使用？`, true))) appId = undefined
  } else appId = undefined
  while (!appId) {
    const input = (await deps.ask("请粘贴飞书 App ID（形如 cli_0123456789abcdef）：")).trim()
    if (!input) {
      deps.print("已取消，未做任何修改。")
      return { ok: false, reason: "cancelled" }
    }
    if (!FEISHU_APP_ID_RE.test(input)) {
      deps.print("⚠️ App ID 格式不正确：应为 cli_ 后接 16 位十六进制字符。")
      continue
    }
    appId = input
  }

  let appSecret = values.FEISHU_APP_SECRET?.trim()
  if (appSecret && !(await yesNo(deps, "检测到已有 App Secret，继续使用？", true))) appSecret = undefined
  while (!appSecret) {
    const input = (await deps.ask("请粘贴飞书 App Secret：")).trim()
    if (!input) {
      deps.print("已取消，未做任何修改。")
      return { ok: false, reason: "cancelled" }
    }
    appSecret = input
  }

  let verified = false
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await verifyFeishuCredentials(deps, appId, appSecret)
      verified = true
      deps.print("✅ 飞书应用凭据校验通过")
      break
    } catch (err) {
      deps.print(`⚠️ 连接飞书失败：${err instanceof Error ? err.message : String(err)}`)
      if (attempt >= 3 || !(await yesNo(deps, "重试验证？", true))) break
    }
  }
  if (!verified && !(await yesNo(deps, "无法验证凭据（可能是网络问题）。仍然保存并继续？", false))) {
    deps.print("已取消，未做任何修改。")
    return { ok: false, reason: "unverified" }
  }

  let ids = parseFeishuOpenIds(values.FEISHU_ALLOW_OPEN_IDS ?? "").filter((id) => FEISHU_OPEN_ID_RE.test(id))
  let allowAll = envBool(values.FEISHU_ALLOW_ALL_USERS)
  if (allowAll) {
    if (!(await yesNo(deps, "当前允许所有飞书用户，继续保留？（不推荐，建议稍后用 /access 收紧）", true))) {
      allowAll = false
      ids = []
    }
  }
  if (!allowAll && ids.length > 0) {
    deps.print(`检测到已有 open_id 白名单：${ids.join(", ")}`)
    if (!(await yesNo(deps, "继续使用这些 open_id？", true))) ids = []
  }
  if (!allowAll && ids.length === 0) {
    deps.print("不知道自己的 open_id 时，可先输入 a 允许所有飞书用户；启动后私聊 Bot 发送 /start，再用 /access 查看并收紧。")
    while (ids.length === 0 && !allowAll) {
      const input = (await deps.ask("允许使用的飞书 open_id（逗号分隔；输入 a 临时允许所有人）：")).trim()
      if (["a", "all", "全部"].includes(input.toLowerCase())) {
        allowAll = true
        break
      }
      const parsed = parseFeishuOpenIds(input)
      const invalid = parsed.filter((id) => !FEISHU_OPEN_ID_RE.test(id))
      if (invalid.length > 0) deps.print(`⚠️ 无效 open_id：${invalid.join("、")}。每项应形如 ou_xxx。`)
      ids = parsed.filter((id) => FEISHU_OPEN_ID_RE.test(id))
      if (ids.length === 0) deps.print("⚠️ 至少填写一个 open_id，或输入 a 允许所有人。")
    }
  }
  if (ids.length > 0 && !allowAll) {
    const extra = (await deps.ask("其他允许使用的 open_id（可选，逗号分隔，回车跳过）：")).trim()
    const parsed = parseFeishuOpenIds(extra)
    const invalid = parsed.filter((id) => !FEISHU_OPEN_ID_RE.test(id))
    if (invalid.length > 0) deps.print(`⚠️ 已忽略无效 open_id：${invalid.join("、")}`)
    for (const id of parsed) if (FEISHU_OPEN_ID_RE.test(id) && !ids.includes(id)) ids.push(id)
  }

  const existingCallback = envBool(values.FEISHU_CALLBACK_ENABLED)
  deps.print("")
  deps.print("面板按钮需要飞书卡片回调；它要求一个公网可访问的 HTTP(S) 地址。")
  deps.print("只用文字命令与附件时可以关闭回调。")
  const callbackEnabled = await yesNo(deps, "启用飞书卡片回调？", existingCallback)
  const updates: Record<string, string> = {
    FEISHU_APP_ID: appId,
    FEISHU_APP_SECRET: appSecret,
    FEISHU_ALLOW_OPEN_IDS: ids.join(","),
    FEISHU_ALLOW_ALL_USERS: allowAll ? "1" : "0",
    FEISHU_CALLBACK_ENABLED: callbackEnabled ? "1" : "0",
  }

  if (callbackEnabled) {
    let bind = values.FEISHU_CALLBACK_BIND?.trim() || "127.0.0.1"
    while (!bind) {
      bind = (await deps.ask("回调监听地址 FEISHU_CALLBACK_BIND [127.0.0.1]：")).trim() || "127.0.0.1"
    }
    const port = await askPort(deps, "回调监听端口 FEISHU_CALLBACK_PORT", Number(values.FEISHU_CALLBACK_PORT) || 3081)
    let path = values.FEISHU_CALLBACK_PATH?.trim() || "/feishu/card"
    while (!callbackPathValid(path)) {
      deps.print("⚠️ 回调路径需以 / 开头，且不能包含 //、查询串或片段，例如 /feishu/card。")
      path = (await deps.ask("回调路径 FEISHU_CALLBACK_PATH [/feishu/card]：")).trim() || "/feishu/card"
    }

    let verificationToken = values.FEISHU_CALLBACK_VERIFICATION_TOKEN?.trim()
    if (verificationToken && !(await yesNo(deps, "检测到已有 Verification Token，继续使用？", true))) {
      verificationToken = undefined
    }
    let encryptKey = values.FEISHU_CALLBACK_ENCRYPT_KEY?.trim()
    if (encryptKey && !(await yesNo(deps, "检测到已有 Encrypt Key，继续使用？", true))) encryptKey = undefined
    while (!verificationToken && !encryptKey) {
      deps.print("至少填写 Verification Token 或 Encrypt Key 之一（在开放平台「加密策略」中设置）。")
      if (!verificationToken) verificationToken = (await deps.ask("Verification Token（可留空）：")).trim() || undefined
      if (!verificationToken && !encryptKey) encryptKey = (await deps.ask("Encrypt Key（可留空）：")).trim() || undefined
    }

    updates.FEISHU_CALLBACK_BIND = bind
    updates.FEISHU_CALLBACK_PORT = String(port)
    updates.FEISHU_CALLBACK_PATH = path
    if (verificationToken) updates.FEISHU_CALLBACK_VERIFICATION_TOKEN = verificationToken
    if (encryptKey) updates.FEISHU_CALLBACK_ENCRYPT_KEY = encryptKey
  }

  deps.print("")
  deps.print("即将写入配置：")
  deps.print(`  文件：${deps.envPath}（权限 0600）`)
  deps.print(`  FEISHU_APP_ID=${appId}`)
  deps.print("  FEISHU_APP_SECRET=***")
  deps.print(`  FEISHU_ALLOW_OPEN_IDS=${ids.join(",")}`)
  deps.print(`  FEISHU_ALLOW_ALL_USERS=${allowAll ? "1" : "0"}`)
  deps.print(`  FEISHU_CALLBACK_ENABLED=${callbackEnabled ? "1" : "0"}`)
  if (!(await yesNo(deps, "确认保存？", true))) {
    deps.print("已取消，未做任何修改。")
    return { ok: false, reason: "cancelled" }
  }

  persistEnv(deps.envPath, updates, "飞书 Bot（首次连接向导）")
  deps.print("")
  deps.print("✅ 飞书配置已保存。")
  deps.print("下一步：在开放平台用「长连接」接收事件并发布应用版本，然后 npm run restart。")
  if (allowAll) deps.print("⚠️ 当前允许所有飞书用户；首次 /start 后用 /access 收紧白名单。")
  if (!callbackEnabled) deps.print("ℹ️ 卡片回调未启用：文字命令可用，但飞书面板按钮不会响应。")
  return { ok: true, clients: ["feishu"], updates }
}

function configuredLabel(client: SetupClient, evidence: ReturnType<typeof controlClientEvidence>): string {
  const configured =
    client === "telegram" ? evidence.telegram : client === "android" ? evidence.android : evidence.feishu
  return configured ? "已配置" : "未配置"
}

export async function runClientSetup(deps: SetupDeps): Promise<SetupResult> {
  const values = readEnvState(deps.envPath)
  const evidence = controlClientEvidence(values as NodeJS.ProcessEnv)

  deps.print("")
  deps.print("🧭 Agent Bot 控制端配置向导")
  deps.print("可以同时选择多个控制端；重复运行只更新选中的配置，其他配置与注释会保留。")
  deps.print("")
  deps.print(`  1. Telegram    [${configuredLabel("telegram", evidence)}]`)
  deps.print(`  2. 安卓 App    [${configuredLabel("android", evidence)}]`)
  deps.print(`  3. 飞书        [${configuredLabel("feishu", evidence)}]`)
  deps.print("")
  deps.print("输入编号（如 1,2）、名称或 a 选择全部；回车退出。")

  let clients: SetupClient[] = []
  while (clients.length === 0) {
    const input = (await deps.ask("请选择要配置的控制端：")).trim()
    if (!input || ["0", "q", "quit", "exit"].includes(input.toLowerCase())) {
      deps.print("已退出，未做任何修改。")
      return { ok: false, reason: "cancelled" }
    }
    clients = parseClientSelection(input)
    if (clients.length === 0) deps.print("⚠️ 未识别选择，请输入 1、2、3，逗号分隔，或 a 选择全部。")
  }

  const updates: Record<string, string> = {}
  const completed: SetupClient[] = []
  let telegram: SetupResult | undefined
  let android: SetupResult | undefined
  for (const client of clients) {
    const result =
      client === "telegram"
        ? await runSetup(deps)
        : client === "android"
          ? await runAndroidSetup(deps)
          : await runFeishuSetup(deps)
    if (!result.ok) {
      deps.print(`⚠️ ${CLIENT_LABELS[client]} 未完成配置，继续处理其他选择。`)
      continue
    }
    completed.push(client)
    Object.assign(updates, result.updates)
    if (client === "telegram") telegram = result
    else if (client === "android") android = result
  }

  if (completed.length === 0) {
    return { ok: false, reason: "cancelled" }
  }
  deps.print("")
  deps.print(`✅ 已完成控制端：${completed.map((client) => CLIENT_LABELS[client]).join("、")}`)
  deps.print("后续可在安装目录随时运行 npm run clients，添加或修改其他控制端。")
  return {
    ok: true,
    clients: completed,
    updates,
    token: telegram?.token,
    users: telegram?.users,
    botUsername: telegram?.botUsername,
    api: android?.api,
  }
}

export async function setupFromCli(): Promise<SetupResult> {
  if (!canRunSetup()) {
    throw new Error("当前环境不是交互式终端，无法运行连接向导。请在终端中运行 npm run setup 或 npm run clients。")
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await runClientSetup({
      ask: (question) => rl.question(question),
      print: (line = "") => process.stdout.write(`${line}\n`),
      fetch: globalThis.fetch.bind(globalThis),
      envPath: resolve(".env"),
    })
  } finally {
    rl.close()
  }
}
