import { randomBytes } from "node:crypto"
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * The data directory's one local secret (`accounts.key`): 32 random bytes, hex-encoded.
 *
 * The account vault, the relay ("中转站") credentials and the per-model endpoint keys all
 * encrypt with it, and each used to create it its own way. The vault linked a staged file into
 * place while the other two took a lock and then overwrote the path with writeFileSync. The
 * vault never took that lock, so a store could overwrite a key the vault had just linked and
 * already encrypted with, and every one of those passwords was lost. A plain write could also
 * be read half-written by another process and rejected as malformed.
 *
 * There is now exactly one way to create it: write a staged copy, then hard-link it into place.
 * link() refuses an existing target, so the first creator wins, every other caller adopts that
 * key, and no reader can ever see a partial file. An existing key is never replaced, even a
 * malformed one: regenerating it would silently orphan everything encrypted under it.
 */
export interface SecretKeyOptions {
  /** Told once when this call created the key. */
  onCreate?: (path: string) => void
}

const KEY_RE = /^[0-9a-f]{64}$/i

function readKey(path: string): Buffer {
  const raw = readFileSync(path, "utf8").trim()
  if (!KEY_RE.test(raw)) throw new Error(`账号密钥 ${path} 格式无效，请从备份恢复该文件。`)
  return Buffer.from(raw, "hex")
}

export function loadOrCreateSecretKey(path: string, options: SecretKeyOptions = {}): Buffer {
  if (existsSync(path)) return readKey(path)
  mkdirSync(dirname(path), { recursive: true })
  const key = randomBytes(32)
  const staging = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  writeFileSync(staging, `${key.toString("hex")}\n`, { mode: 0o600 })
  try {
    linkSync(staging, path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    // Another process created it first: use that key, never our own
    return readKey(path)
  } finally {
    try {
      unlinkSync(staging)
    } catch {
      // staging already gone
    }
  }
  options.onCreate?.(path)
  return key
}
