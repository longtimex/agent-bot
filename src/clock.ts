/**
 * Wall-clock stamps for file names (rotated logs, backups, exports).
 *
 * These used to read the host's local time (Date#getHours and friends), while reminders,
 * schedules and daily reports use REMINDER_TIMEZONE. On a VPS left at UTC with
 * REMINDER_TIMEZONE=Asia/Shanghai, a backup taken at 09:00 was named 0100, so the files
 * never matched the times the bot itself showed. Every file stamp now goes through here.
 *
 * This module is deliberately dependency-free so the logger can use it.
 */

const FALLBACK_TIMEZONE = "Asia/Shanghai"

let resolveZone: () => string | undefined = () => process.env.REMINDER_TIMEZONE

/** Called once by the entry point with the live timezone, so /timezone changes apply at once. */
export function configureFileClock(zone: (() => string | undefined) | undefined): void {
  resolveZone = zone ?? (() => process.env.REMINDER_TIMEZONE)
}

function validZone(zone: string | undefined): string {
  const candidate = zone?.trim()
  if (!candidate) return FALLBACK_TIMEZONE
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate })
    return candidate
  } catch {
    return FALLBACK_TIMEZONE
  }
}

export interface FileStampOptions {
  /** Include seconds (HHMMSS); default true. */
  seconds?: boolean
  /** Append milliseconds, for names that must not collide within one second. */
  millis?: boolean
  /** Override the configured zone (tests, or callers that already hold one). */
  timeZone?: string
}

/** `YYYYMMDD-HHMM[SS][mmm]` in the configured timezone; sorts chronologically within a zone. */
export function fileStamp(now: number | Date = Date.now(), options: FileStampOptions = {}): string {
  const at = typeof now === "number" ? now : now.getTime()
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: validZone(options.timeZone ?? resolveZone()),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const parts: Record<string, string> = {}
  for (const part of fmt.formatToParts(at)) parts[part.type] = part.value
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0")
  // Some ICU builds render midnight as hour "24" under hour12:false
  const hour = pad(Number(parts.hour) % 24)
  let stamp = `${parts.year}${parts.month}${parts.day}-${hour}${parts.minute}`
  if (options.seconds !== false) stamp += parts.second
  if (options.millis) stamp += pad(new Date(at).getUTCMilliseconds(), 3)
  return stamp
}
