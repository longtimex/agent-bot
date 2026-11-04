import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * Message-level encryption (v1) for the App API: each JSON request/response body is
 * one AES-256-GCM blob, base64(nonce(12) || ciphertext || tag(16)), under the pairing
 * key stored server-side in data/api-enc-key.json. The URL path and query stay
 * readable (they carry no secrets beyond ids); SSE, media streams and the exported
 * history/backup attachments are not encrypted and fall back to plain HTTP.
 */
export const ENC_HEADER = "x-enc"
export const ENC_VERSION = "v1"
const NONCE_BYTES = 12
const TAG_BYTES = 16

export function encryptPayload(key: Buffer, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString("base64")
}

export function decryptPayload(key: Buffer, payload: string): string {
  const raw = Buffer.from(payload, "base64")
  if (raw.length < NONCE_BYTES + TAG_BYTES) throw new Error("加密载荷不完整")
  const nonce = raw.subarray(0, NONCE_BYTES)
  const tag = raw.subarray(raw.length - TAG_BYTES)
  const data = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)
  const decipher = createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}

/** A fresh 256-bit key, base64-encoded for the JSON store. */
export function randomEncKey(): string {
  return randomBytes(32).toString("base64")
}

/** Round-trips only for exactly 32 bytes — anything else means a corrupted store. */
export function decodeEncKey(value: unknown): Buffer | undefined {
  if (typeof value !== "string") return undefined
  const key = Buffer.from(value, "base64")
  return key.length === 32 ? key : undefined
}
