import type { ResolvedModel } from "./engineCall.js"
import type { MediaKind } from "./media.js"

export interface ApiTaskView {
  id: string
  status: "queued" | "running" | "done" | "failed" | "cancelled"
  text: string
  engine: string
  model?: string
  progress?: string
  reply?: string
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  /** Attachments ride along on submit; only the count is echoed back. */
  attachmentCount?: number
  /** Media produced by the task, mirroring what Telegram receives. */
  media?: ApiTaskMediaView[]
}

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
  attachments?: ApiAttachment[]
  media?: ApiTaskMedia[]
  /** OpenCode pin resolved from `model` at submit; CLI engines use `model` directly. */
  modelRef?: ResolvedModel
}

export interface ApiAttachment {
  name: string
  mime: string
  data: string
}
