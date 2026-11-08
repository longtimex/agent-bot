import { AppType, CardActionHandler, Client, Domain, EventDispatcher, WSClient, generateChallenge } from "@larksuiteoapi/node-sdk"
import { AsyncLocalStorage } from "node:async_hooks"
import { resolve } from "node:path"
import type { BotConfig } from "./config.js"
import { FeishuService } from "./feishu.js"
import { FeishuOutbound, installFeishuTransformer } from "./feishuApi.js"
import { FeishuCallbackServer } from "./feishuCallback.js"
import { FeishuIdentityStore } from "./feishuIdentity.js"
import type { FeishuApiLike } from "./feishuTypes.js"
import type { ChannelIdResolver } from "./channelRegistry.js"
import type { Logger } from "./logger.js"
import type { TelegramBridge } from "./telegram.js"

/** The SDK logger is deliberately narrowed: its default logger writes raw request details. */
function sdkLogger(log: Logger): {
  debug: Logger["debug"]
  info: Logger["info"]
  warn: Logger["warn"]
  error: Logger["error"]
  trace: Logger["debug"]
} {
  return {
    debug: (...args) => log.debug("feishu sdk:", ...args),
    info: (...args) => log.debug("feishu sdk:", ...args),
    warn: (...args) => log.warn("feishu sdk:", ...args),
    error: (...args) => log.error("feishu sdk:", ...args),
    trace: (...args) => log.debug("feishu sdk:", ...args),
  }
}

export interface FeishuRuntime {
  service: FeishuService
  outbound: FeishuOutbound
  identities: FeishuIdentityStore
  client: FeishuApiLike
  callback?: FeishuCallbackServer
  start(): void
  stop(): Promise<void>
}

export interface FeishuConnection {
  client: FeishuApiLike
  identities: FeishuIdentityStore
  resolver: ChannelIdResolver
  outbound: FeishuOutbound
}

export interface FeishuRuntimeDeps {
  cfg: BotConfig
  bridge: TelegramBridge
  log: Logger
  connection?: FeishuConnection
}

export interface FeishuRuntimeOptions {
  /** Lets tests inject a WS implementation without opening a real tenant connection. */
  ws?: {
    start(params: { eventDispatcher: unknown }): Promise<void>
    close(params?: { force?: boolean }): void
  }
  /** Test seam: captures registered handlers instead of constructing an SDK dispatcher. */
  dispatcher?: {
    register(handles: Record<string, (event: unknown) => Promise<unknown> | unknown>): unknown
  }
  /** Test seam for the public card callback server. */
  callback?: FeishuCallbackServer
  /** Called when the long connection cannot start at all. */
  onFatal?: (err: Error) => void
}

/** Creates the API client and identity namespace before the bridge is constructed. */
export function createFeishuConnection(cfg: BotConfig, log: Logger): FeishuConnection | undefined {
  const feishu = cfg.feishu
  if (!feishu) return undefined
  const client = new Client({
    appId: feishu.appId,
    appSecret: feishu.appSecret,
    appType: AppType.SelfBuild,
    domain: Domain.Feishu,
    logger: sdkLogger(log),
  })
  const identities = new FeishuIdentityStore(resolve(cfg.dataDir, "feishu-identities.json"), log)
  const outbound = new FeishuOutbound(client)
  const resolver: ChannelIdResolver = {
    // Range alone is not enough: once a real Telegram id happens to be negative
    // the persisted allocation is the only safe source of truth.
    isFeishuId: (id) => identities.hasNumericId(id),
    receiveIdForChat: (chatId) => identities.chatExternalId(chatId),
    openIdForUser: (userId) => identities.userOpenId(userId),
    feishuOwnerChatId: () => identities.ownerChatId(),
    feishuOwnerUserId: () => identities.ownerUserId(),
  }
  return { client: client as unknown as FeishuApiLike, identities, resolver, outbound }
}

/**
 * Builds the Feishu transport around the same TelegramBridge the other two
 * control surfaces use. This is intentionally an adapter, not a second bot:
 * inbound events become synthetic grammY Updates and outbound Bot API calls
 * are intercepted by the transformer.
 */
export function createFeishuRuntime(deps: FeishuRuntimeDeps, options: FeishuRuntimeOptions = {}): FeishuRuntime | undefined {
  const cfg = deps.cfg.feishu
  if (!cfg) return undefined
  const connection = deps.connection ?? createFeishuConnection(deps.cfg, deps.log)
  if (!connection) return undefined

  installFeishuTransformer(deps.bridge.bot, connection.outbound, connection.resolver)

  const dispatcher = options.dispatcher ?? new EventDispatcher({ logger: sdkLogger(deps.log) })
  const ws =
    options.ws ??
    new WSClient({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      domain: Domain.Feishu,
      logger: sdkLogger(deps.log),
      autoReconnect: true,
      handshakeTimeoutMs: 20_000,
      wsConfig: { pingTimeout: 45 },
      onReady: () => {
        deps.log.info("Feishu long connection ready")
        deps.bridge.startBackgroundServices()
        void deps.bridge.announceStartup(connection.identities.ownerChatId(), "feishu")
      },
      onError: (err) => {
        deps.log.error("Feishu long connection stopped:", err.message)
        options.onFatal?.(err)
      },
      onReconnecting: () => deps.log.warn("Feishu long connection lost; reconnecting"),
      onReconnected: () => deps.log.info("Feishu long connection restored"),
    })

  const service = new FeishuService({
    cfg: deps.cfg,
    client: connection.client,
    ws,
    dispatcher,
    bridge: deps.bridge,
    log: deps.log,
    identities: connection.identities,
    outbound: connection.outbound,
    onFirstChat: () => {
      deps.bridge.startBackgroundServices()
      void deps.bridge.announceStartup(connection.identities.ownerChatId(), "feishu")
    },
    onFatal: options.onFatal,
  })
  const callbackConfig = cfg.callback
  const actionContext = new AsyncLocalStorage<{ handled: boolean }>()
  const cardHandler = callbackConfig
    ? new CardActionHandler(
        {
          verificationToken: callbackConfig.verificationToken,
          encryptKey: callbackConfig.encryptKey,
          logger: sdkLogger(deps.log),
        },
        async (raw: unknown) => {
          const context = actionContext.getStore()
          if (context) context.handled = true
          return service.handleCardAction(raw as never)
        },
      )
    : undefined
  const callback = callbackConfig
    ? (options.callback ??
      new FeishuCallbackServer({
        config: callbackConfig,
        log: deps.log,
        handle: async (raw) => {
          // Generate the challenge first: it validates the verification token
          // (or decrypts an encrypted body) before reflecting any value. Card
          // actions fall through to the SDK handler, which verifies signatures.
          let challenge: { isChallenge: boolean; challenge: { challenge: unknown } }
          try {
            challenge = generateChallenge(raw, {
              encryptKey: callbackConfig.encryptKey ?? "",
              verificationToken: callbackConfig.verificationToken,
            })
          } catch {
            return undefined
          }
          if (challenge.isChallenge) return challenge.challenge
          const context = { handled: false }
          const result = await actionContext.run(context, () => cardHandler?.invoke(raw))
          // The SDK returns undefined both for a rejected request and for a
          // handler that has no card update to return. The marker preserves
          // that distinction so the HTTP layer can answer 403 only when the
          // card handler never ran.
          if (!context.handled) return undefined
          return result ?? {}
        },
      }))
    : undefined

  return {
    service,
    outbound: connection.outbound,
    identities: connection.identities,
    client: connection.client,
    callback,
    start: () => {
      service.start()
      void callback?.start().catch((err: unknown) => {
        deps.log.error("飞书卡片回调启动失败：", err instanceof Error ? err.message : String(err))
      })
      // Feishu-only deployments cannot wait for Telegram polling to start
      // reminders and schedules; they are transport-neutral shared services.
      deps.bridge.startBackgroundServices()
    },
    stop: async () => {
      service.close()
      await callback?.stop().catch((err: unknown) => {
        deps.log.warn("飞书卡片回调停止失败：", err instanceof Error ? err.message : String(err))
      })
    },
  }
}
