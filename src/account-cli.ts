import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import process from "node:process"
import { AccountStore } from "./accounts.js"
import { loadDotEnvFile } from "./config.js"
import { createLogger } from "./logger.js"

/**
 * Read-only access to the account vault for a task runner.
 *
 * An agent should not have to parse `data/accounts.json` and find the key beside it: that is
 * both easy to get wrong and impossible to audit. This CLI hands out one entry at a time and
 * appends a line to `data/account-access.log`, so a leaked credential can be traced to the
 * moment it was read.
 *
 * It never writes to the vault. Creating and editing stay in `/account` and the App.
 */
const USAGE = `用法：
  npm run -s account -- list [分类]          列出名称、分类与账号
  npm run -s account -- get <名称>           只输出密码，便于 $(...) 取用
  npm run -s account -- get <名称> --json    输出账号、密码、网址、备注与自定义字段
  npm run -s account -- tags                 列出全部标签

只读：新增、修改、删除请用 /account 或 App 的账号库。每次取用都会记入 data/account-access.log。`

const MAX_LOG_BYTES = 256 * 1024

function loadStore(): AccountStore {
  loadDotEnvFile()
  const dataDir = resolve(process.env.DATA_DIR ?? "./data")
  return new AccountStore(
    join(dataDir, "accounts.json"),
    join(dataDir, "accounts.key"),
    createLogger("warn"),
  )
}

/** One line per read, rotated by truncation so a long-lived task never fills the disk. */
function audit(dataDir: string, action: string, subject: string): void {
  const path = join(dataDir, "account-access.log")
  try {
    if (existsSync(path) && readFileSync(path).length > MAX_LOG_BYTES) writeFileSync(path, "")
    const at = new Date().toISOString()
    appendFileSync(path, `${at}\t${action}\t${subject}\tpid=${process.ppid}\tcwd=${process.cwd()}\n`)
  } catch {
    // An audit failure must not hide the credential the caller asked for
  }
}

function main(argv: string[]): number {
  const [command, ...rest] = argv
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(`${USAGE}\n`)
    return command ? 0 : 1
  }
  const dataDir = resolve(process.env.DATA_DIR ?? "./data")
  const store = loadStore()

  if (command === "list" || command === "ls") {
    const category = rest.join(" ").trim() || undefined
    const entries = store.list(category)
    if (entries.length === 0) {
      process.stdout.write(category ? `分类「${category}」下没有条目。\n` : "账号库还是空的。\n")
      return 0
    }
    for (const entry of entries) {
      const tags = entry.tags.length ? ` [${entry.tags.join(", ")}]` : ""
      process.stdout.write(`${entry.name}\t${entry.category}\t${entry.username || "-"}${tags}\n`)
    }
    return 0
  }

  if (command === "tags") {
    const tags = store.tags()
    if (tags.length === 0) {
      process.stdout.write("还没有标签。\n")
      return 0
    }
    for (const tag of tags) process.stdout.write(`${tag.name}\t${tag.count}\n`)
    return 0
  }

  if (command === "get" || command === "show") {
    const json = rest.includes("--json")
    const name = rest.filter((arg) => arg !== "--json").join(" ").trim()
    if (!name) {
      process.stderr.write(`缺少名称。\n${USAGE}\n`)
      return 1
    }
    const revealed = store.reveal(name)
    if (!revealed) {
      process.stderr.write(`没有找到「${name}」。\n`)
      return 1
    }
    audit(dataDir, command, revealed.entry.name)
    if (json) {
      process.stdout.write(`${JSON.stringify({
        name: revealed.entry.name,
        username: revealed.entry.username,
        password: revealed.password,
        category: revealed.entry.category,
        url: revealed.entry.url ?? null,
        notes: revealed.entry.notes ?? null,
        tags: revealed.entry.tags,
        extras: revealed.entry.extras,
      }, null, 2)}\n`)
      return 0
    }
    if (!revealed.password) {
      process.stderr.write(`「${revealed.entry.name}」没有保存密码。\n`)
      return 1
    }
    // A bare password on stdout is what makes `$(npm run -s account -- get x)` work
    process.stdout.write(`${revealed.password}\n`)
    return 0
  }

  process.stderr.write(`未知命令「${command}」。\n${USAGE}\n`)
  return 1
}

process.exitCode = main(process.argv.slice(2))
