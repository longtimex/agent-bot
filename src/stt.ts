import { openAsBlob } from "node:fs"
import type { ModelCapabilities } from "./attachmentInput.js"
import type { SavedAttachment } from "./attachments.js"
import { redactSecrets } from "./ccswitch.js"

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
  /**
   * The task's own cancel signal. Without it /stop waited out every voice note's 120s
   * transcription (and paid for it) before the task noticed it had been stopped.
   */
  signal?: AbortSignal
  /** Test seam; production uses a disk-backed Blob so a large voice note is not read into the heap. */
  openBlob?: (path: string, type?: string) => Promise<Blob>
}

/** The task was stopped while a voice note was being transcribed. */
export class SttCancelled extends Error {
  constructor() {
    // Same wording the engines use, so the task settles as cancelled rather than failed
    super("已取消当前任务。")
    this.name = "SttCancelled"
  }
}

/** Calls `{baseUrl}/audio/transcriptions` and returns the transcript text. */
export async function transcribeAudio(filePath: string, opts: SttConfig, deps: SttDeps = {}): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const openBlob = deps.openBlob ?? openAsBlob
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`

  const form = new FormData()
  const file = await openBlob(filePath, "application/octet-stream")
  form.append("file", file, filePath.split(/[\\/]/).pop() || "audio")
  form.append("model", opts.model)
  if (opts.language) form.append("language", opts.language)

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : undefined,
      body: form,
      signal: deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    })
  } catch (err) {
    if (deps.signal?.aborted) throw new SttCancelled()
    throw new Error(`语音转写请求失败：${(err as Error).message}`)
  }
  if (!res.ok) {
    // A gateway's error page can quote the request, Authorization header included
    const detail = redactSecrets(await res.text().catch(() => "")).slice(0, 200)
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
    if (deps.signal?.aborted) throw new SttCancelled()
    const blocked = item.kind === "audio" && opts.modelCapabilities?.audio === false
    if (!blocked) {
      out.push(item)
      continue
    }
    try {
      const text = await transcribeAudio(item.path, opts.stt, deps)
      out.push({ ...item, text: `（语音转写）\n${text}` })
    } catch (err) {
      // A stop is not a per-file failure: abandon the rest instead of noting it and carrying on
      if (err instanceof SttCancelled) throw err
      errors.push(`${item.name}：${(err as Error).message}`)
      out.push(item)
    }
  }
  return { saved: out, errors }
}
