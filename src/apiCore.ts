import type { IncomingMessage, ServerResponse } from "node:http"

export const API_PREFIX = "/api/v1"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface ApiRequestContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  method: string
  segments: string[]
  /** True when this request asked for (and got) v1 message-level encryption. */
  encrypted: boolean
}
