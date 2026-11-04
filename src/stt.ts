import { readFileSync } from "node:fs"
import type { ModelCapabilities } from "./attachmentInput.js"
import type { SavedAttachment } from "./attachments.js"

/**
 * Optional speech-to-text for voice notes, using any OpenAI-compatible
 * `POST /audio/transcriptions` endpoint (OpenAI, Groq, local whisper servers).
 * Off unless STT_BASE_URL is configured.
 */
export interface SttConfig {
  baseUrl: string
  apiKey?: string
  model: string
  language?: string
}

export interface SttDeps {
  fetchImpl?: typeof fetch
  readFile?: (path: string) => Buffer
}

/** Calls `{baseUrl}/audio/transcriptions` and returns the transcript text. */
export async function transcribeAudio(filePath: string, opts: SttConfig, deps: SttDeps = {}): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const readFile = deps.readFile ?? readFileSync
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`

  const form = new FormData()
  const bytes = readFile(filePath)
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), filePath.split("/").pop() || "audio")
  form.append("model", opts.model)
  if (opts.language) form.append("language", opts.language)

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
  } catch (err) {
    throw new Error(`语音转写请求失败：${(err as Error).message}`)
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200)
    throw new Error(`语音转写失败（HTTP ${res.status}）${detail ? `：${detail}` : ""}`)
  }
  const body = (await res.json().catch(() => undefined)) as { text?: unknown } | undefined
  const text = typeof body?.text === "string" ? body.text.trim() : ""
  if (!text) throw new Error("语音转写返回了空结果")
  return text
}

export interface ApplySttOptions {
  stt?: SttConfig
  modelCapabilities?: ModelCapabilities
  /** Upper bound for one transcription (matches the Telegram inbound file cap). */
  maxBytes?: number
}

export interface ApplySttResult {
  saved: SavedAttachment[]
  /** Human-readable failures; the caller shows them next to the other attachment notes. */
  errors: string[]
}

/**
 * When the current model cannot take audio directly, a configured STT service turns
 * voice notes into inline text instead of dropping them with a "not supported" note.
 * Items the model accepts (or STT not configured / transcription failed) pass through
 * untouched, so existing behaviour never regresses.
 */
export async function applyStt(saved: SavedAttachment[], opts: ApplySttOptions = {}, deps: SttDeps = {}): Promise<ApplySttResult> {
  const errors: string[] = []
  if (!opts.stt) return { saved, errors }
  const out: SavedAttachment[] = []
  for (const item of saved) {
    const blocked = item.kind === "audio" && (opts.modelCapabilities?.audio === false || item.bytes > (opts.maxBytes ?? 10 * 1024 * 1024))
    if (!blocked) {
      out.push(item)
      continue
    }
    try {
      const text = await transcribeAudio(item.path, opts.stt, deps)
      out.push({ ...item, text: `（语音转写）\n${text}` })
    } catch (err) {
      errors.push(`${item.name}：${(err as Error).message}`)
      out.push(item)
    }
  }
  return { saved: out, errors }
}
