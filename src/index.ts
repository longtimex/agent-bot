import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { pruneInbox } from "./attachments.js"
import { loadConfig } from "./config.js"
import { acquireLock } from "./lock.js"
import { createLogger, pruneRotatedLogs, rotateLogIfNeeded } from "./logger.js"
import { pruneOutbox } from "./media.js"
import { Opencode } from "./opencode.js"
import { ProxyService } from "./proxy.js"
import { QoderService } from "./qoder.js"
import { SessionStore } from "./store.js"
import { TelegramBridge } from "./telegram.js"

async function main(): Promise<void> {
  const cfg = loadConfig()
  const log = createLogger(cfg.logLevel)
  mkdirSync(cfg.dataDir, { recursive: true })
  mkdirSync(cfg.outboxDir, { recursive: true })
  mkdirSync(cfg.inboxDir, { recursive: true })

  const releaseLock = acquireLock(resolve(cfg.dataDir, "bot.lock"), log)
  process.once("exit", releaseLock)

  const pruneFiles = (): void => {
    const outbox = pruneOutbox(cfg.outboxDir)
    if (outbox > 0) log.info(`pruned ${outbox} expired file(s) from outbox`)
    const inbox = pruneInbox(cfg.inboxDir)
    if (inbox > 0) log.info(`pruned ${inbox} expired file(s) from inbox`)
  }

  pruneFiles()
  const pruneTimer = setInterval(pruneFiles, 24 * 60 * 60 * 1000).unref()

  // restart.sh passes the redirected log path so long-running instances still rotate
  const logFile = process.env.BOT_LOG_FILE
  if (logFile) {
    const pruned = pruneRotatedLogs(logFile)
    if (pruned > 0) log.info(`pruned ${pruned} old rotated log(s)`)
  }
  const logTimer = logFile
    ? setInterval(() => {
        const rotated = rotateLogIfNeeded(logFile)
        if (rotated) {
          log.info(`rotated log ${logFile} -> ${rotated}`)
          pruneRotatedLogs(logFile)
        }
      }, 60_000).unref()
    : undefined

  const oc = new Opencode(cfg.opencode.url, cfg.opencode.username, cfg.opencode.password)
  if (await oc.health()) {
    log.info(`opencode server reachable at ${cfg.opencode.url}`)
  } else {
    log.warn(`opencode server not reachable at ${cfg.opencode.url}; start it with: npm run serve`)
  }

  const store = new SessionStore(resolve(cfg.dataDir, "sessions.json"), log)
  const proxies = new ProxyService(resolve(cfg.dataDir, "proxies.json"), log)
  const qoder = new QoderService(process.cwd(), store, log, cfg.taskTimeoutMs, cfg.taskMaxTimeoutMs, () =>
    proxies.env(),
  )

  const tgBridge = new TelegramBridge(cfg, oc, qoder, store, log, proxies)
  await tgBridge.start()

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`received ${signal}, shutting down`)
    clearInterval(pruneTimer)
    if (logTimer) clearInterval(logTimer)
    qoder.dispose()
    proxies.dispose()
    await tgBridge.stop().catch(() => {})
    releaseLock()
    setTimeout(() => process.exit(0), 100).unref()
  }

  process.once("SIGINT", () => {
    shutdown("SIGINT").catch(() => process.exit(0))
  })
  process.once("SIGTERM", () => {
    shutdown("SIGTERM").catch(() => process.exit(0))
  })
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
