import { mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ApiServer, resolveApiToken } from "./api.js"
import { AgentCliRegistry, AgentCliService } from "./agentCli.js"
import { pruneInbox } from "./attachments.js"
import { CcSwitchService, redactSecrets } from "./ccswitch.js"
import { ConfigError, loadConfig, StartupConfigError, type BotConfig } from "./config.js"
import { acquireLock } from "./lock.js"
import { createLogger, pruneRotatedLogs, rotateLogIfNeeded } from "./logger.js"
import { pruneOutbox } from "./media.js"
import { ModelAdmin } from "./modelAdmin.js"
import { Opencode } from "./opencode.js"
import { ProxyService } from "./proxy.js"
import { canRunSetup, setupFromCli } from "./setup.js"
import { SessionStore } from "./store.js"
import { TelegramBridge } from "./telegram.js"

function setupHint(detail: string): string {
  return (
    `${detail}\n\n首次连接 Telegram Bot：\n` +
    "1. 在 Telegram 向 @BotFather 发送 /newbot，复制返回的 HTTP API Token\n" +
    "2. 向 @userinfobot 发送任意消息，获取你的数字用户 ID\n" +
    "3. 在 .env 中填写 TELEGRAM_BOT_TOKEN 与 TELEGRAM_ALLOW_USERS\n" +
    "在终端中运行 npm run setup 可进入交互式连接向导。"
  )
}

let botToken: string | undefined

/** Crash output lands in bot.log and is read by whoever tails it, so it must never carry credentials. */
function fatalText(err: unknown): string {
  const raw = err instanceof Error ? (err.stack ?? err.message) : String(err)
  const redacted = redactSecrets(raw)
  return botToken ? redacted.split(botToken).join("***") : redacted
}

function installCrashGuards(): void {
  process.on("unhandledRejection", (reason) => {
    // One stray rejection must not take down other chats' in-flight tasks
    console.error(`unhandled rejection (kept running): ${fatalText(reason)}`)
  })
  process.on("uncaughtException", (err) => {
    console.error(`uncaught exception, exiting: ${fatalText(err)}`)
    process.exit(1)
  })
}

async function loadConfigOrSetup(): Promise<BotConfig> {
  try {
    return loadConfig()
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    if (!canRunSetup()) throw new ConfigError(setupHint(err.message))

    console.log("检测到尚未完成 Telegram 连接配置，进入首次连接向导…\n")
    const result = await setupFromCli()
    if (!result.ok || !result.token || !result.users?.length) {
      throw new ConfigError("未完成 Telegram 连接配置。可重新运行 npm run setup。")
    }
    // loadEnvFile does not override existing (possibly empty) environment values
    process.env.TELEGRAM_BOT_TOKEN = result.token
    process.env.TELEGRAM_ALLOW_USERS = result.users.join(",")
    console.log("\n✅ 配置已就绪，继续启动 Bot…\n")
    return loadConfig()
  }
}

async function main(): Promise<void> {
  installCrashGuards()
  const cfg = await loadConfigOrSetup()
  botToken = cfg.telegram.token
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
  const agentRegistry = new AgentCliRegistry({ path: cfg.agentCli.configPath, log })
  const agents = new AgentCliService(
    process.cwd(),
    store,
    log,
    cfg.taskTimeoutMs,
    cfg.taskMaxTimeoutMs,
    () => proxies.env(),
    agentRegistry,
  )
  const allProfiles = agentRegistry.list()
  const detectedAgents = allProfiles.filter((profile) => agentRegistry.binPath(profile))
  const installable = allProfiles.filter((profile) => profile.installSpec && !agentRegistry.binPath(profile))
  log.info(
    `agent CLI detection: ${detectedAgents.length}/${allProfiles.length} installed` +
      (detectedAgents.length > 0 ? ` (${detectedAgents.map((profile) => profile.label).join(", ")})` : ""),
  )
  if (installable.length > 0) {
    log.info(
      `installable from Telegram with /agents install <id>: ${installable.map((profile) => profile.id).join(", ")}`,
    )
  }
  log.info("recommended engine: opencode (multi-model, tools, attachments, scheduling)")
  const ccswitch = new CcSwitchService({
    bin: cfg.ccswitch.bin,
    app: cfg.ccswitch.app,
    projectDir: process.cwd(),
  })
  if (!ccswitch.available) {
    log.info("cc-switch CLI 未安装；/cc 面板可用但需要先运行 npm run cc-switch:install")
  }
  const models = new ModelAdmin(
    resolve(cfg.dataDir, "models.json"),
    process.cwd(),
    cfg.opencode.agent ?? "assistant",
    store,
  )

  const tgBridge = new TelegramBridge(cfg, oc, agents, store, log, proxies, undefined, ccswitch, models)

  let apiServer: ApiServer | undefined
  if (cfg.api.enabled) {
    try {
      apiServer = new ApiServer(
        {
          cfg,
          oc,
          agents,
          store,
          log,
          usage: tgBridge.usageStore,
          history: tgBridge.historyStore,
          reminders: tgBridge.sharedReminders,
          schedules: tgBridge.sharedSchedules,
          models,
          timezone: () => tgBridge.currentTimezone,
          setTimezone: (zone) => tgBridge.setTimezone(zone),
          ops: tgBridge.opsService,
          installer: tgBridge.agentInstaller,
          proxies,
          aliases: tgBridge.aliasStore,
          ccswitch: tgBridge.ccSwitch,
          fetchMedia: (target) => tgBridge.fetchRemoteMedia(target),
          access: {
            list: () => tgBridge.accessState,
            add: (ids) => tgBridge.addAccess(ids),
            remove: (ids) => tgBridge.removeAccess(ids),
          },
          ownerChatId: tgBridge.ownerChatId,
        },
        resolveApiToken(cfg),
      )
      await apiServer.start()
    } catch (err) {
      apiServer = undefined
      log.error(`failed to start the HTTP API: ${(err as Error).message} (Telegram 继续正常运行)`)
    }
  }

  const shutdown = async (signal: string, code = 0): Promise<void> => {
    log.info(`received ${signal}, shutting down`)
    process.exitCode = code
    clearInterval(pruneTimer)
    if (logTimer) clearInterval(logTimer)
    agents.dispose()
    proxies.dispose()
    if (apiServer) await apiServer.stop().catch(() => {})
    await tgBridge.stop().catch(() => {})
    releaseLock()
    setTimeout(() => process.exit(code), 100).unref()
  }

  try {
    await tgBridge.start({
      // A polling loop that stopped for good must not linger: systemd/the restart
      // script only recover when the process actually exits.
      onFatal: (err) => {
        void shutdown(`polling stopped (${err.message})`, 1).catch((fatal: unknown) => {
          console.error(`shutdown failed: ${fatalText(fatal)}`)
          process.exit(1)
        })
      },
    })
  } catch (err) {
    log.error((err as Error).message)
    await shutdown("startup failure", 1).catch(() => {})
    return
  }

  const onSignal = (signal: string): void => {
    shutdown(signal).catch((err: unknown) => {
      console.error(`shutdown failed: ${fatalText(err)}`)
      process.exit(1)
    })
  }
  process.once("SIGINT", () => onSignal("SIGINT"))
  process.once("SIGTERM", () => onSignal("SIGTERM"))
}

main().catch((err: unknown) => {
  // Startup configuration problems already carry user-facing guidance: no stack
  console.error(err instanceof StartupConfigError ? err.message : fatalText(err))
  process.exit(1)
})
