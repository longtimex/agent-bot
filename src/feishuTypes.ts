import type { Client } from "@larksuiteoapi/node-sdk"
import type { Logger } from "./logger.js"

/** The image/file keys returned by Feishu can be top-level or wrapped in `data`. */
export interface FeishuUpload {
  image_key?: string
  file_key?: string
  data?: { image_key?: string; file_key?: string }
}

export interface FeishuApiLike {
  im: {
    v1: {
      message: {
        create(payload: {
          data: { receive_id: string; msg_type: string; content: string; uuid?: string }
          params: { receive_id_type: "chat_id" | "open_id" | "union_id" | "email" | "user_id" }
        }): Promise<{ data?: { message_id?: string; chat_id?: string } }>
        patch(payload: { data: { content: string }; path: { message_id: string } }): Promise<unknown>
        delete(payload: { path: { message_id: string } }): Promise<unknown>
      }
      image: {
        create(payload: { data: { image_type: "message"; image: Buffer } }): Promise<FeishuUpload | null>
      }
      file: {
        create(payload: {
          data: {
            file_type: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream"
            file_name: string
            duration?: number
            file: Buffer
          }
        }): Promise<FeishuUpload | null>
      }
      messageResource: {
        get(payload: {
          params: { type: string }
          path: { message_id: string; file_key: string }
        }): Promise<{ getReadableStream(): NodeJS.ReadableStream }>
      }
    }
  }
}

export type FeishuClientLike = Pick<Client, "im"> | FeishuApiLike

export interface FeishuMessageRef {
  messageId: string
  chatId: string
}

export interface FeishuOutboundDeps {
  client: FeishuApiLike
  log: Logger
  maxBytes: number
}

export function asFeishuApi(client: FeishuClientLike): FeishuApiLike {
  return client as unknown as FeishuApiLike
}
