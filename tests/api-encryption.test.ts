import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { request as httpRequest, type IncomingHttpHeaders } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { gunzipSync } from "node:zlib"
import { decryptPayload, encryptPayload, randomEncKey, decodeEncKey } from "../src/apiCrypto.js"
import { loadConfig } from "../src/config.js"
import { resolveEncKey } from "../src/api.js"
import { authHeaders, withApi } from "./api.test.js"

const KEY = Buffer.alloc(32, 7)

test("encrypt/decrypt round-trips and detects tampering", () => {
  const payload = encryptPayload(KEY, JSON.stringify({ hello: "世界", n: 42 }))
  assert.doesNotMatch(payload, /世界/, "the ciphertext must not contain the plaintext")
  assert.deepEqual(JSON.parse(decryptPayload(KEY, payload)), { hello: "世界", n: 42 })

  // 篡改一个字节后必须失败（GCM 认证标签）
  const flipped = Buffer.from(payload, "base64")
  flipped[flipped.length - 3]! ^= 0x01
  assert.throws(() => decryptPayload(KEY, flipped.toString("base64")))

  // 错误的密钥同样失败
  assert.throws(() => decryptPayload(Buffer.alloc(32, 8), payload))

  // 过短的载荷直接拒绝
  assert.throws(() => decryptPayload(KEY, Buffer.from("short").toString("base64")))
})

test("enc keys are exactly 32 bytes and garbage is rejected", () => {
  const key = randomEncKey()
  assert.equal(decodeEncKey(key)?.length, 32)
  assert.equal(decodeEncKey("not-base64!!"), undefined)
  assert.equal(decodeEncKey(Buffer.alloc(16).toString("base64")), undefined)
})

test("loadConfig parses API_ENCRYPTION and defaults to off", () => {
  const base = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOW_USERS: "7" }
  assert.equal(loadConfig(base).encryption.enabled, false)
  assert.equal(loadConfig({ ...base, API_ENCRYPTION: "1" }).encryption.enabled, true)
})

test("resolveEncKey creates a 0600 key store once and reuses it", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-enc-"))
  try {
    const cfg = { ...loadConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOW_USERS: "7", API_ENCRYPTION: "1" }), dataDir: dir }

    const first = resolveEncKey(cfg)
    assert.ok(first?.length === 32, "a fresh 256-bit key is generated")
    const path = join(dir, "api-enc-key.json")
    assert.ok(existsSync(path))
    assert.equal(statSync(path).mode & 0o777, 0o600, "the key store is private")

    const second = resolveEncKey(cfg)
    assert.deepEqual(second, first, "the stored key is reused, not regenerated")

    // 关闭开关时不生成任何东西
    const off = { ...loadConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOW_USERS: "7" }), dataDir: join(dir, "off") }
    assert.equal(resolveEncKey(off), undefined)
    assert.ok(!existsSync(join(dir, "off", "api-enc-key.json")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("encrypted request bodies get encrypted responses end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-enc-api-"))
  try {
    const encKey = resolveEncKey({
      ...loadConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOW_USERS: "7", API_ENCRYPTION: "1" }),
      dataDir: dir,
    })!

    await withApi(
      async () => "回复",
      async (h) => {
        // 明文请求在同服务器上仍然可用（渐进式，App 未升级也能工作）
        const plain = await fetch(`${h.base}/api/v1/health`, { headers: authHeaders() })
        assert.equal(plain.status, 200)
        assert.ok(!plain.headers.get("x-enc"))

        const body = encryptPayload(encKey, JSON.stringify({ text: "30m 喝水" }))
        const res = await fetch(`${h.base}/api/v1/reminders`, {
          method: "POST",
          headers: { ...authHeaders(), "x-enc": "v1" },
          body,
        })
        assert.equal(res.status, 201)
        assert.equal(res.headers.get("x-enc"), "v1", "the response is encrypted in kind")
        const wire = await res.text()
        assert.doesNotMatch(wire, /喝水/, "the response body must not leak the plaintext")
        const decrypted = JSON.parse(decryptPayload(encKey, wire)) as { reminder: { text: string } }
        assert.equal(decrypted.reminder.text, "喝水")

        // 篡改密文必须被拒（400 且不泄露内容）
        const tampered = await fetch(`${h.base}/api/v1/reminders`, {
          method: "POST",
          headers: { ...authHeaders(), "x-enc": "v1" },
          body: "AAAA" + body.slice(4),
        })
        assert.equal(tampered.status, 400)
        const err = await tampered.text()
        assert.doesNotMatch(err, /喝水/)
        // 密钥对不上时客户端连错误都解不开，所以这个说明必须以明文返回
        assert.notEqual(tampered.headers.get("x-enc"), "v1", "an answer the peer cannot decrypt stays readable")
        assert.match(err, /解密请求体失败/)
        assert.match(err, /重新扫码/, "the stale-key advice reaches the user")
        // The App only falls back to plaintext on the *other* 400 (a server that turned
        // encryption off), which names both the header and the switch. A key mismatch must not
        // match, or a stale key would silently downgrade every request.
        assert.doesNotMatch(err, /x-enc/, "a key mismatch is not the encryption-off reply")
        assert.doesNotMatch(err, /API_ENCRYPTION/)

        // 服务器未启用加密时，带 x-enc 的请求得到明确的 400（不是 500）
        const plainServer = await fetch(`${h.base}/api/v1/health`, {
          headers: { ...authHeaders(), "x-enc": "v1" },
        })
        assert.notEqual(plainServer.status, 500)
      },
      encKey,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Raw GET: `fetch` inflates gzip by itself, which would hide the byte order checked below. */
function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", headers }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end()
  })
}

test("encrypted responses get gzipped after encryption, the order OkHttp unpacks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-enc-gzip-"))
  try {
    const encKey = resolveEncKey({
      ...loadConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOW_USERS: "7", API_ENCRYPTION: "1" }),
      dataDir: dir,
    })!
    // Four ~485-character reminders put the list well past the 1024-byte compression threshold.
    const long = "提醒".repeat(240)
    await withApi(
      async () => "回复",
      async (h) => {
        for (let i = 0; i < 4; i++) {
          const created = await fetch(`${h.base}/api/v1/reminders`, {
            method: "POST",
            headers: { ...authHeaders(), "x-enc": "v1" },
            body: encryptPayload(encKey, JSON.stringify({ text: `10m ${long}${i}` })),
          })
          const answer = await created.text()
          assert.equal(created.status, 201, answer)
        }

        const wire = await rawGet(`${h.base}/api/v1/reminders`, {
          ...authHeaders(),
          "x-enc": "v1",
          "accept-encoding": "gzip",
        })
        assert.equal(wire.status, 200)
        assert.equal(wire.headers["x-enc"], "v1")
        assert.equal(wire.headers["content-encoding"], "gzip", "a body over the threshold is compressed")
        assert.deepEqual(
          [...wire.body.subarray(0, 2)],
          [0x1f, 0x8b],
          "the wire bytes are a real gzip stream, not ciphertext claiming to be one",
        )

        // The App's HTTP stack inflates first and decrypts after, so the compressed layer
        // has to be the ciphertext. Compressing before encrypting would hand OkHttp a body
        // it cannot inflate, and every encrypted reply over 1 KB would fail to decode.
        const inflated = gunzipSync(wire.body).toString("utf8")
        assert.ok(inflated.length > 1024, `the encrypted payload should clear the threshold, got ${inflated.length}`)
        assert.doesNotMatch(inflated, /提醒/, "inflating alone must not reveal the answer")
        const decrypted = JSON.parse(decryptPayload(encKey, inflated)) as { reminders: Array<{ text: string }> }
        assert.equal(decrypted.reminders.length, 4)
        assert.ok(decrypted.reminders[0]!.text.includes("提醒"), "the content survives compression and encryption intact")
      },
      encKey,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Paired while encryption was on, then the operator turned it off (`API_ENCRYPTION=0`, or a
 * reinstall that left the key file behind). The App still sends x-enc, and every screen would fail
 * on a message about a header the user cannot remove — so ApiClient drops the key and repeats the
 * call. That fallback keys on the two names in this reply, which is what pins it to the server.
 */
test("a server without a pairing key answers the 400 the App falls back past", async () => {
  await withApi(async () => "回复", async (h) => {
    const encrypted = await fetch(`${h.base}/api/v1/health`, {
      headers: { ...authHeaders(), "x-enc": "v1" },
    })
    assert.equal(encrypted.status, 400, "the encrypted request is refused, not served and not a 500")
    const text = await encrypted.text()
    assert.match(text, /x-enc/)
    assert.match(text, /API_ENCRYPTION/)

    // What the App's retry sends: the same call without the header works, so the chat keeps
    // running against a server that simply does not encrypt.
    const retry = await fetch(`${h.base}/api/v1/health`, { headers: authHeaders() })
    assert.equal(retry.status, 200)
    assert.ok(!retry.headers.get("x-enc"))
  })
})
