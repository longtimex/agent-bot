/**
 * A 1:1 mirror of `ApiFormat.normalizeBaseUrl` (android/.../data/ApiClient.kt), which
 * tests/appParity.test.ts pins to the Kotlin source so the two cannot drift. The App runs this
 * on whatever the user typed or pasted, and the address the bot's `/api` reply prints is
 * `<base>/api/v1` — including when the bot sits behind a proxy at a subpath. Only this mirror
 * can be executed here, so the deployment proof goes through it.
 */
export function normalizeAppBaseUrl(raw: string): string {
  let value = raw.trim()
  if (value.length === 0) return value
  if (!value.startsWith("http://") && !value.startsWith("https://")) value = `http://${value}`
  value = value.replace(/\/+$/, "")
  const stripped = stripSuffix(stripSuffix(value, "/api/v1"), "/api")
  return /^https?:\/\/[^/]+(\/[^/]+)*$/.test(stripped) ? stripped : value
}

function stripSuffix(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, value.length - suffix.length) : value
}

/** What ApiClient.url() then does with the stored base. */
export function appRequestUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/api/v1${path}`
}
