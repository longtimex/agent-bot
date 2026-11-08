import { isFeishuNumericId } from "./feishuIdentity.js"

export type Channel = "telegram" | "feishu"

export interface ChannelIdResolver {
  isFeishuId(id: number): boolean
  /** Feishu receive id for a synthetic chat id, used by the Bot API transformer. */
  receiveIdForChat?(chatId: number): string | undefined
  /** Synthetic chat id for a mapped Feishu user, letting the owner fall back without a chat mapping. */
  chatIdForUser?(userId: number): number | undefined
  /** First mapped Feishu chat, used when no Telegram owner exists. */
  feishuOwnerChatId?(): number | undefined
  /** Feishu user id that owns the persisted notification chat. */
  feishuOwnerUserId?(): number | undefined
  /** Feishu open_id behind a synthetic user id. */
  openIdForUser?(userId: number): string | undefined
}

/** A numeric id is Feishu when it comes from the Feishu identity namespace. */
export function channelOfChatId(chatId: number, resolver?: ChannelIdResolver): Channel {
  return (resolver?.isFeishuId(chatId) ?? isFeishuNumericId(chatId)) ? "feishu" : "telegram"
}

export function sessionKeyForChat(chatId: number, resolver?: ChannelIdResolver): string {
  return `${channelOfChatId(chatId, resolver) === "feishu" ? "fs" : "tg"}:${chatId}`
}

export function userKeyForChat(chatId: number, resolver?: ChannelIdResolver): string {
  return sessionKeyForChat(chatId, resolver)
}

export function parseSessionKey(key: string): { channel: Channel; chatId: number } | undefined {
  const match = /^(tg|fs):(-?\d+)$/.exec(key)
  if (!match) return undefined
  const chatId = Number(match[2])
  if (!Number.isSafeInteger(chatId)) return undefined
  return { channel: match[1] === "fs" ? "feishu" : "telegram", chatId }
}
