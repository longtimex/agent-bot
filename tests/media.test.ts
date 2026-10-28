import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { assertUrlAllowed, isPrivateAddress, parseReply, pruneOutbox, resolveMedia } from "../src/media.js"

test("parseReply extracts media in order", () => {
  const result = parseReply("看图\n[[image:outbox/a.png]]\n说明")

  assert.deepEqual(result.parts, [
    { type: "text", text: "看图" },
    { type: "media", kind: "image", target: "outbox/a.png" },
    { type: "text", text: "说明" },
  ])
  assert.equal(result.dropped, 0)
})

test("parseReply handles only directives and mixed text", () => {
  assert.deepEqual(parseReply("[[voice:outbox/a.mp3]]").parts, [
    { type: "media", kind: "voice", target: "outbox/a.mp3" },
  ])

  assert.deepEqual(parseReply("[[video:outbox/a.mp4]]").parts, [
    { type: "media", kind: "video", target: "outbox/a.mp4" },
  ])

  const mixed = parseReply("前[[file:outbox/a.pdf]]后")
  assert.deepEqual(mixed.parts, [
    { type: "text", text: "前" },
    { type: "media", kind: "file", target: "outbox/a.pdf" },
    { type: "text", text: "后" },
  ])
})

test("parseReply caps media at five per reply", () => {
  const input = Array.from({ length: 6 }, (_, i) => `[[image:outbox/${i}.png]]`).join("\n")
  const result = parseReply(input)

  assert.equal(result.parts.length, 5)
  assert.equal(result.dropped, 1)
})

test("parseReply ignores malformed directives", () => {
  assert.equal(parseReply("[[image:]]").dropped, 1)
  assert.deepEqual(parseReply("普通文本").parts, [{ type: "text", text: "普通文本" }])
})

test("resolveMedia returns the host path for files inside outbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-media-"))
  const outbox = join(dir, "outbox")
  mkdirSync(outbox, { recursive: true })
  writeFileSync(join(outbox, "a.png"), Buffer.from([1, 2, 3]))

  try {
    const media = resolveMedia("image", "outbox/a.png", outbox, 1024)
    assert.equal(media.name, "a.png")
    assert.equal(media.size, 3)
    assert.equal(media.isUrl, false)
    assert.equal(media.target, resolve(outbox, "a.png"))
    assert.equal(media.hostPath, resolve(outbox, "a.png"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveMedia accepts absolute paths only inside outbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-media-"))
  const outbox = join(dir, "outbox")
  mkdirSync(outbox, { recursive: true })
  writeFileSync(join(outbox, "a.txt"), "hello")

  try {
    const media = resolveMedia("file", join(outbox, "a.txt"), outbox, 1024)
    assert.equal(media.name, "a.txt")
    assert.throws(() => resolveMedia("file", join(dir, "secret.txt"), outbox, 1024), /outbox/)
    assert.throws(() => resolveMedia("file", "../secret.txt", outbox, 1024), /outbox/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveMedia rejects missing and oversized files", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-media-"))
  const outbox = join(dir, "outbox")
  mkdirSync(outbox, { recursive: true })
  writeFileSync(join(outbox, "big.bin"), Buffer.alloc(64))

  try {
    assert.throws(() => resolveMedia("file", "outbox/none.bin", outbox, 1024), /不存在/)
    assert.throws(() => resolveMedia("file", "outbox/big.bin", outbox, 10), /限制/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveMedia accepts outbox prefix variants", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-media-"))
  const outbox = join(dir, "outbox")
  mkdirSync(outbox, { recursive: true })
  writeFileSync(join(outbox, "pic.jpg"), Buffer.from([1, 2, 3, 4]))

  try {
    assert.equal(resolveMedia("image", "outbox/pic.jpg", outbox, 1024).name, "pic.jpg")
    assert.equal(resolveMedia("image", "data/outbox/pic.jpg", outbox, 1024).name, "pic.jpg")
    assert.equal(resolveMedia("image", "./data/outbox/pic.jpg", outbox, 1024).name, "pic.jpg")
    assert.equal(resolveMedia("image", "pic.jpg", outbox, 1024).name, "pic.jpg")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("isPrivateAddress flags loopback, private and link-local ranges", () => {
  const blocked = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::127.0.0.1",
    "2002:7f00:1::",
    "2001:0:4136:e378::1",
  ]
  for (const ip of blocked) assert.equal(isPrivateAddress(ip), true, ip)

  for (const ip of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateAddress(ip), false, ip)
  }
})

test("assertUrlAllowed blocks internal targets and non-http schemes", async () => {
  await assert.rejects(assertUrlAllowed("http://127.0.0.1:4096/session", false), /内网/)
  await assert.rejects(assertUrlAllowed("http://169.254.169.254/latest/meta-data", false), /内网/)
  await assert.rejects(assertUrlAllowed("http://[::1]/x", false), /内网/)
  await assert.rejects(assertUrlAllowed("file:///etc/passwd", false), /http/)
  await assert.rejects(assertUrlAllowed("http://user:pass@1.1.1.1/a.png", false), /认证/)

  const allowed = await assertUrlAllowed("https://1.1.1.1/a.png", false)
  assert.equal(allowed.hostname, "1.1.1.1")

  const bypass = await assertUrlAllowed("http://127.0.0.1/x", true)
  assert.equal(bypass.hostname, "127.0.0.1")
})

test("resolveMedia keeps remote URLs and derives a file name", () => {
  const media = resolveMedia("file", "https://example.com/files/report.pdf", "/tmp", 1024)
  assert.equal(media.isUrl, true)
  assert.equal(media.name, "report.pdf")
  assert.equal(media.target, "https://example.com/files/report.pdf")
})

test("resolveMedia rejects symlinks escaping outbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-media-"))
  const outbox = join(dir, "outbox")
  mkdirSync(outbox, { recursive: true })
  writeFileSync(join(dir, "secret.txt"), "top secret")
  symlinkSync(join(dir, "secret.txt"), join(outbox, "link.txt"))

  try {
    assert.throws(() => resolveMedia("file", "outbox/link.txt", outbox, 1024), /outbox/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("pruneOutbox deletes files older than maxAge but keeps protected ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-prune-"))
  const outbox = join(dir, "outbox")
  mkdirSync(outbox, { recursive: true })
  writeFileSync(join(outbox, "sample.png"), "sample")
  writeFileSync(join(outbox, "old.jpg"), "old")

  try {
    // maxAgeMs = 0 will prune any non-protected file
    const pruned = pruneOutbox(outbox, -1)
    assert.equal(pruned, 1)
    assert.ok(join(outbox, "sample.png"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
