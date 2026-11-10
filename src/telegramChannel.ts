import { Bot } from "grammy"
import type { UserFromGetMe } from "grammy/types"
import type { BotConfig } from "./config.js"
import { channelOfChatId, type Channel, type ChannelIdResolver } from "./channelRegistry.js"
import type { FeishuResourceRef } from "./feishuAttachments.js"
import type { FeishuApiLike } from "./feishuTypes.js"

export const FEISHU_BOT_INFO: UserFromGetMe = {
  id: 0,
  is_bot: true,
  first_name: "Feishu Bot",
  username: "feishu_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

/** grammY needs a local identity before dispatching synthetic updates from Feishu. */
export function createChannelBot(token: string | undefined): Bot {
  return token ? new Bot(token) : new Bot("0:feishu-only", { botInfo: FEISHU_BOT_INFO })
}

/** grammY requires `me` before a synthetic update; an external Bot may not have fetched it. */
export function seedFeishuBotInfo(bot: Bot): void {
  if (!bot.isInited()) bot.botInfo = FEISHU_BOT_INFO
}

/** First configured Telegram owner, unless this is a Feishu-only deployment. */
export function resolveOwnerChatId(cfg: BotConfig, resolver?: ChannelIdResolver): number | undefined {
  if (cfg.telegram.token) {
    const first = [...cfg.telegram.allowUsers][0]
    const parsed = first ? Number(first) : Number.NaN
    if (Number.isInteger(parsed)) return parsed
  }
  return resolver?.feishuOwnerChatId?.()
}

/** Feishu chat and user ids are separate numeric namespaces. */
export function resolveOwnerUserId(
  cfg: BotConfig,
  resolver: ChannelIdResolver | undefined,
  ownerChatId: number | undefined,
): number | undefined {
  if (cfg.telegram.token) {
    const first = [...cfg.telegram.allowUsers][0]
    const parsed = first ? Number(first) : Number.NaN
    if (Number.isInteger(parsed)) return parsed
  }
  return resolver?.feishuOwnerUserId?.() ?? ownerChatId
}

/** Access checks must use the user identity, not the synthetic chat identity. */
export function isUserAllowed(cfg: BotConfig, userId: number, resolver?: ChannelIdResolver): boolean {
  if (channelOfChatId(userId, resolver) === "feishu") {
    const openId = resolver?.openIdForUser?.(userId)
    if (!openId) return false
    if (cfg.feishu?.allowAll) return true
    return cfg.feishu?.allowOpenIds.has(openId) ?? false
  }
  return cfg.telegram.allowAll || cfg.telegram.allowUsers.has(String(userId))
}

/**
 * Feishu resource downloads are kept outside the main bridge so the Telegram
 * transport file does not grow another adapter concern. The import stays lazy:
 * Telegram-only deployments never load the Feishu attachment module.
 */
export async function downloadFeishuAttachment(
  client: FeishuApiLike,
  ref: FeishuResourceRef,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const { downloadFeishuResource } = await import("./feishuAttachments.js")
  return downloadFeishuResource({ client, maxBytes }, ref, signal)
}

/** Disk-backed Feishu download; used by the attachment pipeline to avoid a full Buffer. */
export async function openFeishuAttachmentStream(
  client: FeishuApiLike,
  ref: FeishuResourceRef,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<AsyncIterable<Uint8Array>> {
  const { openFeishuResourceStream } = await import("./feishuAttachments.js")
  return openFeishuResourceStream({ client, maxBytes, signal }, ref)
}

export type { Channel }
