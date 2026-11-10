import type { IncomingMessage } from "node:http"

/** One streaming part of a multipart/form-data request. */
export interface MultipartPart {
  name: string
  filename?: string
  contentType?: string
  /** Consume this before asking the parser for the next part. */
  data: AsyncIterable<Uint8Array>
}

/** Returns the form boundary, or undefined for a non-multipart request. */
export function multipartBoundary(contentType: string | undefined): string | undefined {
  if (!contentType || !/^multipart\/form-data\b/i.test(contentType)) return undefined
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  return match?.[1] ?? match?.[2]?.trim()
}

function headerValue(headers: string, name: string): string | undefined {
  const line = headers.split("\r\n").find((item) => item.toLowerCase().startsWith(`${name.toLowerCase()}:`))
  return line?.slice(line.indexOf(":") + 1).trim()
}

function dispositionParam(value: string | undefined, key: string): string | undefined {
  if (!value) return undefined
  const extended = new RegExp(`${key}\\*=UTF-8''([^;]+)`, "i").exec(value)
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1])
    } catch {
      return extended[1]
    }
  }
  return new RegExp(`${key}="([^"]*)"`, "i").exec(value)?.[1]
    ?? new RegExp(`${key}=([^;]+)`, "i").exec(value)?.[1]?.trim()
}

/**
 * A small streaming multipart parser. It intentionally stops at the form-data
 * shape the App sends (one set of headers, file and text fields), keeping only
 * the boundary tail in memory. A full-body Buffer here would defeat the point of
 * streaming a large video from the phone.
 */
export async function* multipartParts(req: IncomingMessage, boundary: string): AsyncGenerator<MultipartPart> {
  const marker = Buffer.from(`\r\n--${boundary}`)
  const iterator = req[Symbol.asyncIterator]()
  let buffer = Buffer.alloc(0)
  let eof = false
  let partFinished = true

  const fill = async (): Promise<boolean> => {
    if (eof) return false
    const { done, value } = await iterator.next()
    if (done) {
      eof = true
      return false
    }
    if (value) buffer = Buffer.concat([buffer, Buffer.from(value)])
    return true
  }

  const ensure = async (bytes: number): Promise<void> => {
    while (buffer.byteLength < bytes && !eof) await fill()
  }

  const readHeaders = async (): Promise<string> => {
    while (true) {
      const end = buffer.indexOf("\r\n\r\n")
      if (end >= 0) {
        const headers = buffer.subarray(0, end).toString("latin1")
        buffer = buffer.subarray(end + 4)
        return headers
      }
      if (!(await fill())) throw new Error("multipart 请求不完整")
    }
  }

  const nextChunk = async (): Promise<Buffer | undefined> => {
    while (true) {
      const index = buffer.indexOf(marker)
      if (index >= 0) {
        const body = buffer.subarray(0, index)
        await ensure(index + marker.byteLength + 2)
        const rest = buffer.subarray(index + marker.byteLength)
        partFinished = true
        if (rest.subarray(0, 2).toString("latin1") === "--") {
          eof = true
          buffer = Buffer.alloc(0)
        } else if (rest.subarray(0, 2).toString("latin1") === "\r\n") {
          buffer = rest.subarray(2)
        } else {
          buffer = rest
        }
        return body.byteLength > 0 ? body : undefined
      }
      if (eof) throw new Error("multipart 请求缺少结束边界")
      // Keep enough tail to recognize a boundary split across chunks.
      if (buffer.byteLength > marker.byteLength + 4) {
        const cut = buffer.byteLength - (marker.byteLength + 4)
        const body = buffer.subarray(0, cut)
        buffer = buffer.subarray(cut)
        return body
      }
      if (!(await fill())) throw new Error("multipart 请求缺少结束边界")
    }
  }

  const readPartBody = async function* (): AsyncGenerator<Uint8Array> {
    while (!partFinished) {
      const chunk = await nextChunk()
      if (chunk) yield chunk
    }
  }

  // The first delimiter has no CRLF prefix. Later delimiters are consumed by
  // nextChunk(), which leaves the next part's headers at the front of the buffer.
  const leading = Buffer.from(`--${boundary}`)
  while (buffer.byteLength < leading.byteLength && !eof) await fill()
  if (!buffer.subarray(0, leading.byteLength).equals(leading)) {
    throw new Error("multipart 缺少起始边界")
  }
  buffer = buffer.subarray(leading.byteLength)
  if (buffer.subarray(0, 2).toString("latin1") === "--") {
    eof = true
    return
  }
  if (buffer.subarray(0, 2).toString("latin1") === "\r\n") buffer = buffer.subarray(2)

  while (!eof) {
    const headers = await readHeaders()
    const disposition = headerValue(headers, "content-disposition")
    const name = dispositionParam(disposition, "name")
    if (!name) throw new Error("multipart 字段缺少 name")
    partFinished = false
    const data = readPartBody()
    yield {
      name,
      filename: dispositionParam(disposition, "filename"),
      contentType: headerValue(headers, "content-type"),
      data,
    }
    // A callback that ignored the body must not confuse the next boundary scan.
    if (!partFinished) for await (const _chunk of data) void _chunk
  }
}

/** Consumes a small part (a text field) completely. */
export async function readMultipartPart(part: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of part) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
