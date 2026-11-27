import { randomBytes } from "node:crypto"
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"

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

/** The stores that keep ciphertext under this key, all in the key's own directory. */
const ENCRYPTED_STORES = ["accounts.json", "agent-providers.json", "agent-custom-models.json"]

/**
 * Which of those stores already hold ciphertext. A missing key beside them is not a fresh
 * install: it was lost, or a backup was restored without it. Generating a new one then made the
 * old secrets permanently undecryptable and mixed a second key into the same files, so a later
 * restore of the right key could no longer recover everything either.
 */
function storesWithCiphertext(keyPath: string): string[] {
  const dir = dirname(keyPath)
  return ENCRYPTED_STORES.filter((name) => {
    try {
      return /"secret"\s*:\s*"[^"]+"/.test(readFileSync(join(dir, name), "utf8"))
    } catch {
      return false
    }
  })
}

function readKey(path: string): Buffer {
  const raw = readFileSync(path, "utf8").trim()
  if (!KEY_RE.test(raw)) throw new Error(`账号密钥 ${path} 格式无效，请从备份恢复该文件。`)
  return Buffer.from(raw, "hex")
}

export function loadOrCreateSecretKey(path: string, options: SecretKeyOptions = {}): Buffer {
  if (existsSync(path)) return readKey(path)
  const orphaned = storesWithCiphertext(path)
  if (orphaned.length > 0) {
    throw new Error(
      `账号密钥 ${path} 不存在，但 ${orphaned.join("、")} 里已有加密数据：请从备份恢复 accounts.key。` +
        "不会自动生成新密钥，否则这些数据将永久无法解密。",
    )
  }
  mkdirSync(dirname(path), { recursive: true })
  const key = randomBytes(32)
  const keyHex = `${key.toString("hex")}\n`
  const staging = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  writeFileSync(staging, keyHex, { mode: 0o600 })
  try {
    linkSync(staging, path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EEXIST") return readKey(path)
    // Filesystems or sandboxes that disallow hard links still support O_EXCL creation.
    if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") {
      try {
        const fd = openSync(path, "wx", 0o600)
        try {
          writeSync(fd, keyHex)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      } catch (openErr) {
        if ((openErr as NodeJS.ErrnoException).code === "EEXIST") return readKey(path)
        throw openErr
      }
    } else {
      throw err
    }
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
