import assert from "node:assert/strict"
import type { IncomingMessage } from "node:http"
import { Readable } from "node:stream"
import test from "node:test"
import { multipartBoundary, multipartParts, readMultipartPart } from "../src/multipart.js"

function request(chunks: Array<string | Buffer>): IncomingMessage {
  return Readable.from(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) as unknown as IncomingMessage
}

async function collect(body: Buffer, boundary: string) {
  const parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer }> = []
  for await (const part of multipartParts(request([body]), boundary)) {
    parts.push({
      name: part.name,
      filename: part.filename,
      contentType: part.contentType,
      data: await readMultipartPart(part.data),
    })
  }
  return parts
}

test("multipartBoundary accepts quoted and unquoted boundaries", () => {
  assert.equal(multipartBoundary("multipart/form-data; boundary=abc123"), "abc123")
  assert.equal(multipartBoundary('multipart/form-data; boundary="a b:c"'), "a b:c")
  assert.equal(multipartBoundary("application/json"), undefined)
})

test("multipartParts parses mixed text and file fields", async () => {
  const boundary = "agentbot-boundary"
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nhello\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file0"; filename="a.mp4"\r\nContent-Type: video/mp4\r\n\r\n`),
    Buffer.from([0, 1, 2, 3]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  assert.deepEqual(await collect(body, boundary), [
    { name: "text", filename: undefined, contentType: undefined, data: Buffer.from("hello") },
    { name: "file0", filename: "a.mp4", contentType: "video/mp4", data: Buffer.from([0, 1, 2, 3]) },
  ])
})

test("multipartParts survives a boundary split across input chunks", async () => {
  const boundary = "split-boundary"
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file0"; filename="clip.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.alloc(70_000, 0x5a),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const parts: Array<{ name: string; data: Buffer }> = []
  const chunks = [body.subarray(0, 3), body.subarray(3, 61_000), body.subarray(61_000)]
  for await (const part of multipartParts(request(chunks), boundary)) {
    parts.push({ name: part.name, data: await readMultipartPart(part.data) })
  }
  assert.equal(parts.length, 1)
  assert.equal(parts[0]!.data.byteLength, 70_000)
  assert.equal(parts[0]!.data[0], 0x5a)
})

test("multipartParts permits an empty file field", async () => {
  const boundary = "empty-boundary"
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file0"; filename="empty.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--${boundary}--\r\n`,
  )
  const parts = await collect(body, boundary)
  assert.equal(parts.length, 1)
  assert.equal(parts[0]!.data.byteLength, 0)
})

test("multipartParts reports a missing closing boundary", async () => {
  const boundary = "unfinished"
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file0"; filename="cut.bin"\r\nContent-Type: application/octet-stream\r\n\r\nnot finished`,
  )
  await assert.rejects(async () => {
    for await (const part of multipartParts(request([body]), boundary)) {
      await readMultipartPart(part.data)
    }
  }, /缺少结束边界/)
})
