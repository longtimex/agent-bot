import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { ApiServer, resolveApiToken, resolveEncKey } from "./api.js"
import { AgentCliRegistry, AgentCliService } from "./agentCli.js"
import { pruneInbox } from "./attachments.js"
import { CcSwitchService, redactSecrets } from "./ccswitch.js"
import { MagpieService } from "./magpie.js"
import { ConfigError, hasControlClientEvidence, loadConfig, StartupConfigError, type BotConfig } from "./config.js"
import { createFeishuConnection, createFeishuRuntime, type FeishuRuntime } from "./feishuRuntime.js"
import { acquireLock } from "./lock.js"
import { createLogger, pruneRotatedLogs, rotateLogIfNeeded } from "./logger.js"
import { pruneOutbox } from "./media.js"
import { ModelAdmin } from "./modelAdmin.js"
import { Opencode } from "./opencode.js"
import { ProxyService } from "./proxy.js"
import { canRunSetup, setupFromCli } from "./setup.js"
import { SessionStore } from "./store.js"
import { TelegramBridge } from "./telegram.js"
import { appVersion } from "./version.js"

function setupHint(detail: string): string {
  return (
    `${detail}\n\n首次连接控制端：\n` +
    "导引式配置：在终端运行 npm run setup（或 npm run clients），可多选 Telegram、安卓 App、飞书。\n\n" +
    "Telegram：向 @BotFather 发送 /newbot 获取 Token，向 @userinfobot 获取数字用户 ID，填写 TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOW_USERS。\n\n" +
    "安卓 App：设置 API_ENABLED=1，并把 API_BIND 设为手机可达的具体地址，或填写 API_PUBLIC_URL；只监听 0.0.0.0 / :: 无法自动得到配对地址。也可在向导中生成 API_TOKEN 后直接配对。\n\n" +
    "飞书：在开放平台创建企业自建应用，启用机器人能力，填写 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_ALLOW_OPEN_IDS。"
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
    // Any partial client block (bad Feishu credentials, a loopback-only API, ...) needs its own
    // validation error, not a first-run wizard that could overwrite the operator's choices.
    if (hasControlClientEvidence(process.env)) throw err
    if (!canRunSetup()) throw new ConfigError(setupHint(err.message))

    console.log("检测到尚未配置控制端，进入首次连接向导…\n")
    const result = await setupFromCli()
    if (!result.ok) {
      throw new ConfigError("未完成控制端配置。可重新运行 npm run setup 或 npm run clients。")
    }
    // loadEnvFile does not override values that were already present (sometimes empty) in the
    // process environment, so apply what the wizard wrote before re-reading the config.
    for (const [key, value] of Object.entries(result.updates ?? {})) process.env[key] = value
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
  const magpie = new MagpieService({
    bin: cfg.magpie.bin,
    gatewayUrl: cfg.magpie.gatewayUrl,
    projectDir: process.cwd(),
  })
  if (!magpie.available) {
    log.info("magpie CLI 未安装；/magpie 面板可用但需要先安装 magpie")
  }
  if (!ccswitch.available) {
    log.info("cc-switch CLI 未安装；/cc 面板可用但需要先运行 npm run cc-switch:install")
  }
  const models = new ModelAdmin(
    resolve(cfg.dataDir, "models.json"),
    process.cwd(),
    cfg.opencode.agent ?? "assistant",
    store,
  )

  const feishuConnection = createFeishuConnection(cfg, log)
  const tgBridge = new TelegramBridge(
    cfg,
    oc,
    agents,
    store,
    log,
    proxies,
    undefined,
    ccswitch,
    models,
    undefined,
    undefined,
    magpie,
    feishuConnection?.resolver,
    feishuConnection?.client,
  )

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
          magpie,
          fetchMedia: (target) => tgBridge.fetchRemoteMedia(target),
          access: {
            list: () => tgBridge.accessState,
            add: (ids) => tgBridge.addAccess(ids),
            remove: (ids) => tgBridge.removeAccess(ids),
          },
          ownerChatId: () => tgBridge.ownerChatId,
          ownerUserId: () => tgBridge.ownerUserId,
          channel: feishuConnection?.resolver,
          version: appVersion(),
        },
        resolveApiToken(cfg),
        resolveEncKey(cfg),
      )
      await apiServer.start()
    } catch (err) {
      apiServer = undefined
      log.error(`failed to start the HTTP API: ${(err as Error).message} (聊天控制端继续正常运行)`)
    }
  }

  // Feishu is optional and independent. It is created after the API so a fatal
  // long-connection failure can tell whether another control surface remains.
  let feishu: FeishuRuntime | undefined
  let shuttingDown = false
  const shutdown = async (signal: string, code = 0): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`received ${signal}, shutting down`)
    process.exitCode = code
    clearInterval(pruneTimer)
    if (logTimer) clearInterval(logTimer)
    await feishu?.stop()
    await agents.dispose(1_000).catch(() => {})
    proxies.dispose()
    if (apiServer) await apiServer.stop().catch(() => {})
    await tgBridge.stop().catch(() => {})
    releaseLock()
    setTimeout(() => process.exit(code), 100).unref()
  }

  try {
    feishu = createFeishuRuntime(
      { cfg, bridge: tgBridge, log, connection: feishuConnection },
      {
        onFatal: (err) => {
          log.error(`飞书控制端不可用：${err.message}`)
          if (cfg.telegram.token || apiServer) {
            log.error("飞书长连接已停止，但 Telegram 或 HTTP API 仍可使用")
            return
          }
          void shutdown(`Feishu long connection stopped (${err.message})`, 1).catch((fatal: unknown) => {
            console.error(`shutdown failed: ${fatalText(fatal)}`)
            process.exit(1)
          })
        },
      },
    )
  } catch (err) {
    log.error(`Failed to configure Feishu: ${(err as Error).message}`)
  }

  let telegramReconnecting = false
  try {
    const started = await tgBridge.start({
      // A polling loop that stopped for good must not linger: systemd/the restart
      // script only recover when the process actually exits.
      onFatal: (err) => {
        // A Telegram outage is not fatal when Feishu or the App can still
        // drive the same bridge. Exit only when no control surface remains.
        if (feishu || apiServer) {
          log.error(`Telegram polling stopped (${err.message}); other control surfaces remain available`)
          return
        }
        void shutdown(`polling stopped (${err.message})`, 1).catch((fatal: unknown) => {
          console.error(`shutdown failed: ${fatalText(fatal)}`)
          process.exit(1)
        })
      },
    })
    telegramReconnecting = started.reconnecting
  } catch (err) {
    log.error((err as Error).message)
    if (!feishu && !apiServer) {
      await shutdown("startup failure", 1).catch(() => {})
      return
    }
    log.error("Telegram 启动失败，但飞书/HTTP API 仍可使用")
  }

  feishu?.start()
  if (cfg.feishu && !feishu) {
    // A configured but unusable Feishu client must not silently leave a process
    // supervising nothing when Telegram is absent.
    if (!cfg.telegram.token && !apiServer) {
      log.error("飞书未成功初始化，且没有 Telegram 或 HTTP API 可用，退出以便修复配置")
      await shutdown("Feishu unavailable and no other control surface", 1).catch(() => {})
      return
    }
  }
  if (telegramReconnecting && !feishu && !apiServer) {
    // Telegram is down and there is no HTTP API or Feishu to serve: nothing
    // would answer on any channel, so the supervisor's restart is the way back.
    log.error("Telegram 未连接，且飞书与 HTTP API 均不可用，退出以便重启恢复")
    await shutdown("Telegram unavailable and no other control surface", 1).catch(() => {})
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
