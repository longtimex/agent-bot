import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Logger } from "../src/logger.js"
import {
  DEFAULT_SILENT_TOKEN,
  renderWebhookPrompt,
  verifyWebhookSignature,
  WebhookStore,
} from "../src/webhooks.js"

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }

test("verifyWebhookSignature accepts direct secret header and GitHub HMAC-SHA256", () => {
  const secret = "whsec_test_1234567890"
  const body = Buffer.from(JSON.stringify({ action: "opened", repo: "demo" }), "utf8")

  assert.equal(verifyWebhookSignature(secret, { "x-webhook-secret": secret }, body), true)
  assert.equal(verifyWebhookSignature(secret, { "x-webhook-secret": "wrong" }, body), false)

  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
  assert.equal(verifyWebhookSignature(secret, { "x-hub-signature-256": sig }, body), true)
  assert.equal(verifyWebhookSignature(secret, { "x-hub-signature-256": "sha256=deadbeef" }, body), false)
  assert.equal(verifyWebhookSignature(secret, {}, body), false)
})

test("renderWebhookPrompt substitutes placeholders, redacts secrets, and appends silent instruction", () => {
  const rendered = renderWebhookPrompt(
    { name: "CI 监控", promptTemplate: "事件 {{event}} 详情：{{payload}}", silentToken: DEFAULT_SILENT_TOKEN },
    "workflow_run",
    '{"token":"ghp_abcdefghijklmnopqrstuvwxyz123456","status":"failed"}',
  )
  assert.match(rendered, /workflow_run/)
  assert.doesNotMatch(rendered, /ghp_abcdefghijklmnopqrstuvwxyz123456/)
  assert.match(rendered, /\[\[silent\]\]/)
})

test("WebhookStore persists CRUD, toggle, and run statistics", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-webhooks-"))
  try {
    const path = join(dir, "webhooks.json")
    const store = new WebhookStore(path, log)
    const created = store.create({
      name: "GitHub Alert",
      promptTemplate: "分析告警：{{payload}}",
      engine: "claude",
    })
    assert.ok(created.id)
    assert.ok(created.secret.startsWith("whsec_"))
    assert.equal(created.enabled, true)

    store.recordRun(created.id, "ok", "发现 1 个错误")
    const toggled = store.toggle(created.id)
    assert.equal(toggled?.enabled, false)

    const reloaded = new WebhookStore(path, log)
    const fetched = reloaded.get(created.id)
    assert.ok(fetched)
    assert.equal(fetched.triggerCount, 1)
    assert.equal(fetched.lastStatus, "ok")
    assert.equal(fetched.enabled, false)

    const removed = reloaded.remove(created.id)
    assert.equal(removed?.id, created.id)
    assert.equal(reloaded.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
