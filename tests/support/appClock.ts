/**
 * A 1:1 mirror of `ApiClient.observeServerClock` / `ApiClient.serverNow`
 * (android/.../data/ApiClient.kt), which tests/appParity.test.ts pins to the Kotlin source so the
 * two cannot drift. Task timestamps are written by the bot's clock and the phone never syncs with
 * it, so every duration in the App is measured against this offset; only the mirror can be executed
 * here, so the proof of the arithmetic goes through it.
 */
const DAY_MS = 24 * 3600_000

/**
 * The new offset, or null when this answer must not move the clock — an absent header, one that
 * is not a date, or a proxy whose clock is a day off, which would do more damage than the skew it
 * is meant to correct.
 */
export function appClockOffsetFrom(header: string | null | undefined, dateMillis: number | null, deviceNowMs: number): number | null {
  if (!header || dateMillis === null) return null
  const delta = dateMillis - deviceNowMs
  return Math.abs(delta) < DAY_MS ? delta : null
}

export function appServerNow(deviceNowMs: number, offsetMs: number): number {
  return deviceNowMs + offsetMs
}
