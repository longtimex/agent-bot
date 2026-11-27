import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { redactSecrets } from "./ccswitch.js"
import { readJsonObject, writePrivateAtomic } from "./jsonStore.js"
import type { Logger } from "./logger.js"

export interface WebhookConfig {
  id: string
  name: string
  secret: string
  enabled: boolean
  engine?: string
  model?: string
  promptTemplate: string
  silentToken?: string
  createdAt: number
  lastTriggeredAt?: number
  triggerCount: number
  lastStatus?: "ok" | "silent" | "failed"
  lastSummary?: string
}

export interface CreateWebhookInput {
  name: string
  promptTemplate: string
  engine?: string
  model?: string
  silentToken?: string
}

interface WebhooksFile {
  version: number
  hooks: WebhookConfig[]
}

const MAX_HOOKS = 30
const MAX_PAYLOAD_PREVIEW = 8_000
export const DEFAULT_SILENT_TOKEN = "[[silent]]"

function safeString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLen) : undefined
}

function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Verifies an inbound webhook request using either:
 * 1. Direct secret header `X-Webhook-Secret: <secret>` (or `?secret=` fallback disabled on purpose — headers only), or
 * 2. GitHub / standard HMAC signature `X-Hub-Signature-256: sha256=<hmac-sha256-hex>`.
 */
export function verifyWebhookSignature(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
): boolean {
  const rawSecret = headers["x-webhook-secret"]
  const headerSecret = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret
  if (typeof headerSecret === "string" && headerSecret.trim()) {
    return timingSafeHexEqual(headerSecret.trim(), secret)
  }

  const rawSig = headers["x-hub-signature-256"]
  const sigHeader = Array.isArray(rawSig) ? rawSig[0] : rawSig
  if (typeof sigHeader === "string" && sigHeader.startsWith("sha256=")) {
    const provided = sigHeader.slice("sha256=".length).trim().toLowerCase()
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex").toLowerCase()
    return timingSafeHexEqual(provided, expected)
  }

  return false
}

/** Renders a webhook's prompt template with redacted event & JSON payload context. */
export function renderWebhookPrompt(
  hook: Pick<WebhookConfig, "name" | "promptTemplate" | "silentToken">,
  eventName: string,
  payloadText: string,
): string {
  const safePayload = redactSecrets(payloadText).slice(0, MAX_PAYLOAD_PREVIEW)
  const safeEvent = eventName.replace(/[\r\n]+/g, " ").trim().slice(0, 80) || "webhook"
  const silent = hook.silentToken?.trim() || DEFAULT_SILENT_TOKEN
  const hasPayloadVar = hook.promptTemplate.includes("{{payload}}")
  // Function replacers avoid interpreting `$&`, `$$`, or `$1` inside code/diff payloads.
  let rendered = hook.promptTemplate
    .replaceAll("{{name}}", () => hook.name)
    .replaceAll("{{event}}", () => safeEvent)
    .replaceAll("{{payload}}", () => safePayload)
    .replaceAll("{{silentToken}}", () => silent)
  if (!hasPayloadVar && safePayload) {
    rendered += `\n\n--- Webhook 事件（${safeEvent}） ---\n${safePayload}`
  }
  rendered += `\n\n（如果事件正常且无需打扰用户，请仅回复 ${silent}）`
  return rendered
}

/** Persists inbound webhook trigger definitions with 0600 permissions. */
export class WebhookStore {
  readonly #path: string
  readonly #log: Logger
  #hooks: WebhookConfig[] = []

  constructor(path: string, log: Logger) {
    this.#path = path
    this.#log = log
    this.#load()
  }

  list(): WebhookConfig[] {
    return this.#hooks.map((hook) => ({ ...hook }))
  }

  get(id: string): WebhookConfig | undefined {
    const found = this.#hooks.find((hook) => hook.id === id)
    return found ? { ...found } : undefined
  }

  create(input: CreateWebhookInput): WebhookConfig {
    if (this.#hooks.length >= MAX_HOOKS) {
      throw new Error(`最多只能创建 ${MAX_HOOKS} 个 Webhook 触发器`)
    }
    const name = safeString(input.name, 60)
    const promptTemplate = safeString(input.promptTemplate, 4000)
    if (!name) throw new Error("Webhook 名称不能为空")
    if (!promptTemplate) throw new Error("提示词模板不能为空")

    const hook: WebhookConfig = {
      id: randomBytes(5).toString("hex"),
      name,
      secret: `whsec_${randomBytes(20).toString("hex")}`,
      enabled: true,
      ...(safeString(input.engine, 40) ? { engine: safeString(input.engine, 40) } : {}),
      ...(safeString(input.model, 120) ? { model: safeString(input.model, 120) } : {}),
      promptTemplate,
      silentToken: safeString(input.silentToken, 40) ?? DEFAULT_SILENT_TOKEN,
      createdAt: Date.now(),
      triggerCount: 0,
    }
    this.#hooks.unshift(hook)
    this.#save()
    return { ...hook }
  }

  toggle(id: string): WebhookConfig | undefined {
    const found = this.#hooks.find((hook) => hook.id === id)
    if (!found) return undefined
    found.enabled = !found.enabled
    this.#save()
    return { ...found }
  }

  remove(id: string): WebhookConfig | undefined {
    const idx = this.#hooks.findIndex((hook) => hook.id === id)
    if (idx < 0) return undefined
    const [removed] = this.#hooks.splice(idx, 1)
    this.#save()
    return removed ? { ...removed } : undefined
  }

  recordRun(id: string, status: "ok" | "silent" | "failed", summary?: string, now = Date.now()): void {
    const found = this.#hooks.find((hook) => hook.id === id)
    if (!found) return
    found.lastTriggeredAt = now
    found.triggerCount += 1
    found.lastStatus = status
    found.lastSummary = summary ? redactSecrets(summary).replace(/\s+/g, " ").trim().slice(0, 200) : undefined
    this.#save()
  }

  #load(): void {
    const parsed = readJsonObject(this.#path, (msg) => this.#log.warn(msg)) as Partial<WebhooksFile> | undefined
    if (!parsed || !Array.isArray(parsed.hooks)) return
    const loaded: WebhookConfig[] = []
    for (const raw of parsed.hooks) {
      if (!raw || typeof raw !== "object") continue
      const rec = raw as unknown as Record<string, unknown>
      const id = safeString(rec.id, 32)
      const name = safeString(rec.name, 60)
      const secret = safeString(rec.secret, 128)
      const promptTemplate = safeString(rec.promptTemplate, 4000)
      if (!id || !name || !secret || !promptTemplate) continue
      loaded.push({
        id,
        name,
        secret,
        enabled: rec.enabled !== false,
        ...(safeString(rec.engine, 40) ? { engine: safeString(rec.engine, 40) } : {}),
        ...(safeString(rec.model, 120) ? { model: safeString(rec.model, 120) } : {}),
        promptTemplate,
        silentToken: safeString(rec.silentToken, 40) ?? DEFAULT_SILENT_TOKEN,
        createdAt: typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now(),
        ...(typeof rec.lastTriggeredAt === "number" && Number.isFinite(rec.lastTriggeredAt)
          ? { lastTriggeredAt: rec.lastTriggeredAt }
          : {}),
        triggerCount: typeof rec.triggerCount === "number" && Number.isFinite(rec.triggerCount) ? Math.max(0, Math.round(rec.triggerCount)) : 0,
        ...(rec.lastStatus === "ok" || rec.lastStatus === "silent" || rec.lastStatus === "failed"
          ? { lastStatus: rec.lastStatus }
          : {}),
        ...(safeString(rec.lastSummary, 200) ? { lastSummary: safeString(rec.lastSummary, 200) } : {}),
      })
    }
    this.#hooks = loaded.slice(0, MAX_HOOKS)
  }

  #save(): void {
    try {
      const body: WebhooksFile = { version: 1, hooks: this.#hooks }
      writePrivateAtomic(this.#path, `${JSON.stringify(body, null, 2)}\n`)
    } catch (err) {
      this.#log.warn("failed to persist webhooks:", (err as Error).message)
    }
  }
}
