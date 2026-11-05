#!/usr/bin/env node
/**
 * Replays the Android App's request sequence against a running bot, from any machine that can
 * reach it. `npm test` proves the contract against a stubbed engine; this proves the *deployment*:
 * the address, the token, the pairing key, the task lifecycle, the SSE stream and the media
 * endpoint as the phone will use them. Install the APK only after this is green.
 *
 *   node scripts/app-smoke.mjs --base http://127.0.0.1:3080 --token <API_TOKEN> [--enc <base64 key>]
 *   APP_SMOKE_BASE=... APP_SMOKE_TOKEN=... APP_SMOKE_ENC=... npm run smoke:app
 *
 * It reads, submits its own two tasks and stops its own task; it never touches the engine, the
 * working directory or another client's queue. A task that fails because the engine behind the bot
 * is unavailable is reported as a warning — this checks the wire, not the agent's health.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const args = new Map()
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i]?.startsWith("--")) args.set(process.argv[i].slice(2), process.argv[i + 1])
}
const base = (args.get("base") ?? process.env.APP_SMOKE_BASE ?? "http://127.0.0.1:3080").replace(/\/+$/, "")
const token = args.get("token") ?? process.env.APP_SMOKE_TOKEN ?? process.env.API_TOKEN ?? ""
const encKey = args.get("enc") ?? process.env.APP_SMOKE_ENC ?? ""
const API = `${base}/api/v1`

if (!token) {
  console.error("缺少令牌：--token <API_TOKEN>（或 APP_SMOKE_TOKEN）。令牌见 .env 的 API_TOKEN，或在 Telegram 里发 /api 查看。")
  process.exit(2)
}
let key = null
if (encKey) {
  key = Buffer.from(encKey, "base64")
  if (key.length !== 32) {
    console.error("--enc 需要 32 字节密钥的 base64（二维码里的 enc 字段，或 data/api-enc-key.json 的 key）")
    process.exit(2)
  }
}

// Same wire format as ApiClient.kt: base64(nonce(12) || ciphertext || tag(16)).
const encrypt = (text) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64")
}
const decrypt = (payload) => {
  const raw = Buffer.from(payload, "base64")
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8")
}

// ApiClient.encryptionSkipped: the stream, media bytes and the export/backup files stay plaintext.
const skipEncryption = (path) => {
  const segments = path.split("?")[0].split("/")
  return segments.includes("events") || segments.includes("media") || segments.includes("export") || segments.at(-1) === "backup"
}

async function call(path, { method = "GET", body, ms = 20_000 } = {}) {
  const headers = { authorization: `Bearer ${token}` }
  const paired = key !== null && !skipEncryption(path)
  if (paired) headers["x-enc"] = "v1"
  let wire
  if (body !== undefined) wire = paired ? encrypt(JSON.stringify(body)) : JSON.stringify(body)
  else if (method !== "GET") wire = ""
  if (wire !== undefined) headers["content-type"] = "application/json; charset=utf-8"

  let res
  try {
    res = await fetch(`${API}${path}`, { method, headers, body: wire, signal: AbortSignal.timeout(ms) })
  } catch (err) {
    // fetch hides the socket reason behind "fetch failed", which is the one thing a user needs here
    const cause = err instanceof Error ? err.cause : undefined
    const detail = cause instanceof Error ? cause.message : String(cause ?? err)
    throw new Error(`${method} ${path} 连不上 ${base}：${detail}`)
  }
  const text = await res.text()
  const answered = res.headers.get("x-enc") === "v1"
  let json
  try {
    json = JSON.parse(answered ? decrypt(text) : text)
  } catch (err) {
    throw new Error(`${method} ${path} 的响应无法解读（${err.message}）：${text.slice(0, 160)}`)
  }
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}：${String(json.error ?? "").slice(0, 200)}`)
  return { json, answered }
}

const results = []
async function step(name, run) {
  let note = ""
  let ok = true
  try {
    note = (await run()) ?? ""
  } catch (err) {
    ok = false
    note = err instanceof Error ? err.message : String(err)
  }
  results.push({ name, ok, note })
  console.log(`${ok ? "✅" : "❌"} ${name}${note ? ` — ${note}` : ""}`)
  return note
}
const warn = (text) => `⚠️ ${text}`

await step("GET /health 连接、版本与加密一致性", async () => {
  const { json, answered } = await call("/health")
  if (key && !answered) throw new Error("带了配对密钥，服务端却回明文：API_ENCRYPTION 与二维码里的密钥不是同一把")
  return `${json.name ?? "agent-bot"} ${json.version ?? ""} engine=${json.engine ?? "?"}`.trim()
})
if (!results[0]?.ok) {
  console.log(`\n连不上 ${API}：Bot 是否在跑、端口是否放行、手机/这台机器是否与它同网段（或隧道/VPN 是否已开）。`)
  console.log("默认地址是 http://127.0.0.1:3080，跨机测试请用 --base http://<服务器地址>:3080。")
  process.exit(1)
}

for (const path of [
  "/session",
  "/info",
  "/status",
  "/help",
  "/agents",
  "/models",
  "/tasks?limit=5",
  "/history?limit=5",
  "/usage",
  "/ops/diag",
]) {
  await step(`GET ${path}`, async () => {
    const { json } = await call(path)
    return Object.keys(json).length ? "" : warn("返回了空对象")
  })
}

const stamp = Date.now().toString(36)
const taskId = await step("POST /task 提交一条对话", async () => {
  const { json } = await call("/task", { method: "POST", body: { text: `smoke-${stamp}` } })
  if (!json.task?.id) throw new Error("响应缺少 task.id")
  return json.task.id
})

await step("GET /task/:id 轮询到终态", async () => {
  const deadline = Date.now() + 120_000
  for (;;) {
    const { json } = await call(`/task/${taskId}`)
    const task = json.task
    if (task.status === "done") {
      // A reply can hold several lines (the server appends ⚠️ notes for undeliverable media)
      const oneLine = String(task.reply ?? "").replace(/\s*\n\s*/g, " / ")
      return `reply=${oneLine.slice(0, 80)}`
    }
    if (task.status === "failed") return warn(`引擎回报：${String(task.error ?? "").slice(0, 120)}`)
    if (task.status === "cancelled") return warn("任务被取消")
    if (Date.now() > deadline) throw new Error("120 秒内没有跑完，SSE 与轮询都无法确认它还在动")
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
})

await step("POST /task 带一个文本附件", async () => {
  const data = Buffer.from(`smoke ${stamp}`, "utf8").toString("base64")
  const { json } = await call("/task", {
    method: "POST",
    body: { text: "读取附件并只回答附件内容", attachments: [{ name: "smoke.txt", mime: "text/plain", data }] },
  })
  if (!json.task?.id) throw new Error("响应缺少 task.id")
  return `已受理 ${json.task.id}`
})

await step("GET /task/:id/events 走 SSE 推送", async () => {
  // Watch a task of our own from the start: attaching to a settled one only ever returns a
  // snapshot, which would leave the pushing path the phone relies on unchecked.
  const { json } = await call("/task", { method: "POST", body: { text: "smoke-sse 请分步骤慢慢想" } })
  const id = json.task?.id
  if (!id) throw new Error("响应缺少 task.id")
  const res = await fetch(`${API}/task/${id}/events`, {
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`SSE → HTTP ${res.status}`)
  if (!String(res.headers.get("content-type")).includes("event-stream")) {
    const snapshot = await res.text()
    if (!snapshot.includes('"status"')) throw new Error(`既不是事件流也不是任务快照：${snapshot.slice(0, 120)}`)
    return "任务已收尾，服务端回了单帧快照（正常）"
  }
  let buf = ""
  let frames = 0
  let progress = 0
  let terminal = false
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString("utf8")
    let cut = buf.indexOf("\n\n")
    while (cut >= 0) {
      const frame = buf.slice(0, cut)
      buf = buf.slice(cut + 2)
      if (frame.startsWith("data: ")) {
        frames++
        if (/"status":"(done|failed|cancelled)"/.test(frame)) terminal = true
        else if (/"progress":"[^"]/.test(frame)) progress++
      }
      cut = buf.indexOf("\n\n")
    }
    if (terminal) break
  }
  if (frames === 0) throw new Error("事件流一帧数据都没送到（只有心跳）")
  if (!terminal) return warn(`${frames} 帧，90 秒内没等到终态`)
  return `${frames} 帧，收到终态${progress ? `，含 ${progress} 帧进度` : ""}`
})

await step("POST /task/:id/stop 只停自己起的任务", async () => {
  const { json } = await call("/task", { method: "POST", body: { text: "smoke-stop 请分步骤慢慢想" } })
  const id = json.task?.id
  if (!id) throw new Error("响应缺少 task.id")
  const now = await call(`/task/${id}`)
  if (!["queued", "running"].includes(now.json.task?.status)) return warn("任务跑得太快，停止步骤跳过")
  const { json: stopped } = await call(`/task/${id}/stop`, { method: "POST" })
  if (!stopped.task) throw new Error("停止响应缺少 task")
  return `状态 ${stopped.task.status}`
})

const failed = results.filter((entry) => !entry.ok)
const warned = results.filter((entry) => entry.note.startsWith("⚠️"))
console.log(
  `\n${base}：${results.length - failed.length}/${results.length} 步通过` +
    (warned.length ? `，其中 ${warned.length} 步是引擎侧提醒` : "") +
    (failed.length ? `，${failed.length} 步失败` : ""),
)
if (failed.length) {
  console.log("失败明细：")
  for (const entry of failed) console.log(`  · ${entry.name}：${entry.note}`)
  console.log("手机出现同样现象时：地址要带协议与端口，令牌去掉首尾空格，App「设置」里清空密钥后重新扫码。")
}
process.exit(failed.length ? 1 : 0)
