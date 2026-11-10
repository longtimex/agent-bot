import type { ResolvedModel } from "./engineCall.js"
import type { MediaKind } from "./media.js"
import type { SavedAttachment } from "./attachments.js"

export interface ApiTaskView {
  id: string
  status: "queued" | "running" | "done" | "failed" | "cancelled"
  text: string
  engine: string
  model?: string
  progress?: string
  reply?: string
  error?: string
  /** Stable machine-readable failure class, also present for cancelled tasks. */
  errorCode?: ApiTaskErrorCode
  /** Why a default engine was replaced for this task (e.g. OpenCode was unreachable). */
  engineNote?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  /** Attachments ride along on submit; only the count is echoed back. */
  attachmentCount?: number
  /** Media produced by the task, mirroring what Telegram receives. */
  media?: ApiTaskMediaView[]
}

export type ApiTaskErrorCode =
  | "ENGINE_UNAVAILABLE"
  | "CLI_ARGUMENT_INVALID"
  | "AUTH_FAILED"
  | "MODEL_UNAVAILABLE"
  | "TASK_TIMEOUT"
  | "TASK_CANCELLED"
  | "ATTACHMENT_FAILED"
  | "UNKNOWN"

export interface ApiTaskMediaView {
  index: number
  kind: MediaKind
  label: string
  name: string
  size: number
  remote: boolean
}

export interface ApiTaskMedia {
  kind: MediaKind
  name: string
  size: number
  remote: boolean
  /** Local absolute path inside data/outbox, or the original URL when remote. */
  target: string
}

export interface ApiTask extends Omit<ApiTaskView, "media"> {
  key: string
  controller?: AbortController
  /** True only when neither the request nor the session stored an engine choice. */
  autoEngine?: boolean
  /** Attachments saved to the inbox at submit time; the base64 payload is never retained. */
  savedAttachments?: SavedAttachment[]
  media?: ApiTaskMedia[]
  /** OpenCode pin resolved from `model` at submit; CLI engines use `model` directly. */
  modelRef?: ResolvedModel
}

export interface ApiAttachment {
  name: string
  mime: string
  data: string
}
