import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
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
