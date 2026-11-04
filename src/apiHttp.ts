import type { ServerResponse } from "node:http"

/**
 * Small HTTP helpers shared by the API surface. Kept free of ApiServer state so
 * the route modules the server is being split into can reuse them verbatim.
 */

const MEDIA_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  zip: "application/zip",
}

export function mimeForName(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : ""
  return MEDIA_MIME[ext] ?? "application/octet-stream"
}

export function clampLimit(raw: string | null, fallback: number, max: number): number {
  // A garbage value must fall back to the default: NaN would slice the list empty.
  const value = Number(raw?.trim() || fallback)
  return Math.min(Math.max(Number.isFinite(value) ? Math.floor(value) : fallback, 1), max)
}

/** A download-style response with an attachment filename. */
export function res_attachment(res: ServerResponse, filename: string, contentType: string, body: string): void {
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "content-disposition": `attachment; filename="${filename}"`,
  })
  res.end(body)
}

/** Same contract for binary payloads (the gzipped data backup). */
export function res_attachment_binary(res: ServerResponse, filename: string, contentType: string, body: Buffer): void {
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": body.byteLength,
    "content-disposition": `attachment; filename="${filename}"`,
  })
  res.end(body)
}

export function stamp(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}
