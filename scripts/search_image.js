#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs"
import { resolve, join } from "node:path"

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error("用法: node scripts/search_image.js <搜索关键词> [保存文件名]")
  process.exit(1)
}

const query = args[0]
const outboxDir = resolve(process.cwd(), "data/outbox")
mkdirSync(outboxDir, { recursive: true })

let filename = args[1]
if (!filename) {
  filename = `search_${Date.now()}.jpg`
}
if (!filename.includes(".")) {
  filename += ".jpg"
}

const outputPath = join(outboxDir, filename)

async function run() {
  const res1 = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    signal: AbortSignal.timeout(10000),
  })
  const html = await res1.text()
  const vqdMatch = html.match(/vqd=([0-9-]+)/) || html.match(/vqd="([^"]+)"/) || html.match(/vqd=([^&]+)/)
  if (!vqdMatch) {
    throw new Error("无法获取搜索令牌")
  }

  const vqd = vqdMatch[1]
  const res2 = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    signal: AbortSignal.timeout(10000),
  })
  const data = await res2.json()
  const results = data.results || []
  if (results.length === 0) {
    throw new Error(`未找到关于 "${query}" 的图片`)
  }

  for (const item of results.slice(0, 8)) {
    try {
      const imgRes = await fetch(item.image, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(8000),
      })
      if (!imgRes.ok) continue
      const buf = Buffer.from(await imgRes.arrayBuffer())
      if (buf.length < 2000) continue

      writeFileSync(outputPath, buf)
      console.log(`成功下载图片到: outbox/${filename} (${Math.round(buf.length / 1024)}KB)`)
      return
    } catch {
      // try next
    }
  }

  throw new Error("找到图片结果但均未能成功下载")
}

run().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
