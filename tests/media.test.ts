import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import {
  assertUrlAllowed,
  isPrivateAddress,
  parseReply,
  pinnedLookup,
  pruneOutbox,
  resolveMedia,
  safeMediaTarget,
} from "../src/media.js"

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

test("safeMediaTarget keeps a signed URL out of the chat and the log", () => {
  // The query of an agent-supplied link normally carries the signature itself
  assert.equal(
    safeMediaTarget("https://cdn.example.com/a/b.png?X-Amz-Signature=deadbeefefbe&token=sk-abcdefghijkl"),
    "https://cdn.example.com/a/b.png",
  )
  // `host` drops the authority's userinfo, so inline credentials never survive
  assert.equal(safeMediaTarget("http://user:hunter2@10.0.0.9/x"), "http://10.0.0.9/x")
  assert.equal(safeMediaTarget("not a url"), "[无效链接]")
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
    assert.throws(() => resolveMedia("file", "none.bin", join(dir, "no-outbox"), 1024), /不存在/)
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
    "::7f00:1",
    "0:0:0:0:0:0:0:1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::10.0.0.1",
    "ff02::1",
    "2002:7f00:1::",
    "2001:0:4136:e378::1",
  ]
  for (const ip of blocked) assert.equal(isPrivateAddress(ip), true, ip)

  for (const ip of [
    "8.8.8.8",
    "1.1.1.1",
    "2001:4860:4860::8888",
    "64:ff9b::808:808",
    "2002:808:808::",
  ]) {
    assert.equal(isPrivateAddress(ip), false, ip)
  }
})

test("assertUrlAllowed blocks internal targets and non-http schemes", async () => {
  await assert.rejects(assertUrlAllowed("http://127.0.0.1:4096/session", false), /内网/)
  await assert.rejects(assertUrlAllowed("http://169.254.169.254/latest/meta-data", false), /内网/)
  await assert.rejects(assertUrlAllowed("http://[::1]/x", false), /内网/)
  // Node normalizes [::127.0.0.1] to [::7f00:1]; it must still be recognized as loopback
  await assert.rejects(assertUrlAllowed("http://[::127.0.0.1]/x", false), /内网/)
  await assert.rejects(assertUrlAllowed("http://[64:ff9b::127.0.0.1]/x", false), /内网/)
  await assert.rejects(assertUrlAllowed("file:///etc/passwd", false), /http/)
  await assert.rejects(assertUrlAllowed("http://user:pass@1.1.1.1/a.png", false), /认证/)

  const allowed = await assertUrlAllowed("https://1.1.1.1/a.png", false)
  assert.equal(allowed.url.hostname, "1.1.1.1")
  // A literal IP needs no pinning; the socket already targets that address
  assert.deepEqual(allowed.pins, [])

  const bypass = await assertUrlAllowed("http://127.0.0.1/x", true)
  assert.equal(bypass.url.hostname, "127.0.0.1")
  assert.deepEqual(bypass.pins, [])
})

test("pinnedLookup only ever returns the validated addresses", async () => {
  const lookup = pinnedLookup("Example.COM", ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])
  const call = (
    host: string,
    options: { family?: number },
  ): Promise<{ address: string; family: number }> =>
    new Promise((resolvePromise, reject) => {
      lookup(host, options, (err, address, family) => {
        if (err || !address || typeof address === "object") reject(err ?? new Error("unexpected"))
        else resolvePromise({ address, family: family ?? 0 })
      })
    })

  assert.deepEqual(await call("example.com", {}), { address: "93.184.216.34", family: 4 })
  assert.deepEqual(await call("EXAMPLE.com", { family: 6 }), {
    address: "2606:2800:220:1:248:1893:25c8:1946",
    family: 6,
  })
  // Another host (e.g. a redirect target) must never resolve through this lookup
  await assert.rejects(call("127.0.0.1", {}), /已校验的主机/)

  const v4Only = pinnedLookup("onlyv4.example", ["93.184.216.34"])
  await assert.rejects(
    new Promise<unknown>((resolvePromise, reject) => {
      v4Only("onlyv4.example", { family: 6 }, (err) => (err ? reject(err) : resolvePromise("ok")))
    }),
    /没有可用的已校验地址/,
  )
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

test("resolveMedia accepts a symlinked outbox directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-media-"))
  const store = join(dir, "media-store")
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, "a.png"), Buffer.from([1, 2, 3]))
  const outbox = join(dir, "outbox")
  symlinkSync(store, outbox)

  try {
    const media = resolveMedia("image", "outbox/a.png", outbox, 1024)
    assert.equal(media.name, "a.png")
    assert.equal(media.size, 3)
    assert.equal(media.hostPath, join(store, "a.png"))
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
    assert.equal(existsSync(join(outbox, "old.jpg")), false)
    assert.equal(existsSync(join(outbox, "sample.png")), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("pruneOutbox walks nested directories without following symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-prune-"))
  const outbox = join(dir, "outbox")
  const outside = join(dir, "outside")
  mkdirSync(join(outbox, "nested", "deep"), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outbox, "top.txt"), "top")
  writeFileSync(join(outbox, "nested", "old.png"), "old")
  writeFileSync(join(outbox, "nested", "deep", "old.jpg"), "old")
  writeFileSync(join(outside, "keep.txt"), "keep")
  symlinkSync(outside, join(outbox, "link"))

  try {
    assert.equal(pruneOutbox(outbox, -1), 3)
    assert.equal(existsSync(join(outbox, "top.txt")), false)
    assert.equal(existsSync(join(outbox, "nested", "old.png")), false)
    assert.equal(existsSync(join(outbox, "nested", "deep", "old.jpg")), false)
    assert.equal(existsSync(join(outside, "keep.txt")), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("parseReply treats an over-long directive target as plain text", () => {
  const result = parseReply(`[[ file:${"a".repeat(1200)}]]`)

  assert.deepEqual(result.parts, [{ type: "text", text: `[[ file:${"a".repeat(1200)}]]` }])
})

test("parseReply scans stray directive prefixes without stalling", () => {
  // An unclosed `[[ image:` used to make the engine walk to the end of the reply,
  // so a long model reply full of them blocked every other chat for seconds
  const filler = "x".repeat(100_000)
  const input = Array.from({ length: 100 }, () => `[[ image:${filler}`).join("")
  const started = performance.now()
  const result = parseReply(input)
  const elapsed = performance.now() - started

  assert.equal(result.parts.filter((part) => part.type === "media").length, 0)
  assert.ok(elapsed < 250, `${Math.round(elapsed)} ms spent scanning stray directive prefixes`)
})

test("resolveMedia filters a filename the remote server supplies", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-outbox-"))
  try {
    const outbox = join(dir, "outbox")
    mkdirSync(outbox, { recursive: true })
    const media = resolveMedia("image", "https://example.com/a/%0A%2Fetc%2Fpasswd.png", outbox, 1024)

    assert.equal(media.name, "passwd.png", "a remote name must not smuggle newlines or path separators")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("parseReply leaves a directive inside a fenced code block as text", () => {
  const reply = [
    "用法示例：",
    "```",
    "[[image:outbox/a.png]]",
    "```",
    "真实图片 [[file:outbox/b.pdf]]",
  ].join("\n")

  const result = parseReply(reply)
  assert.equal(result.dropped, 0, "an example is not a malformed directive")
  assert.deepEqual(
    result.parts.filter((part) => part.type === "media"),
    [{ type: "media", kind: "file", target: "outbox/b.pdf" }],
  )
  const text = result.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
  assert.match(text, /\[\[image:outbox\/a\.png\]\]/, "the example must reach the chat verbatim")
})

test("parseReply leaves a directive inside inline code as text", () => {
  const result = parseReply("运行 `[[voice:outbox/a.mp3]]` 即可")

  assert.deepEqual(result.parts, [{ type: "text", text: "运行 `[[voice:outbox/a.mp3]]` 即可" }])
  assert.equal(result.dropped, 0)
})

test("parseReply treats an unterminated fence as covering the rest of the reply", () => {
  const reply = ["说明：", "```", "[[video:outbox/a.mp4]]"].join("\n")

  const result = parseReply(reply)
  assert.equal(result.parts.filter((part) => part.type === "media").length, 0)
})
