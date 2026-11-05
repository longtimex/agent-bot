/**
 * Mirrors `LocalStore.saveMessages`'s trimming of the stored chat, which cannot be executed here
 * (it lives in Kotlin). appParity.test.ts pins the steps against the shipped source.
 */
const MAX_HISTORY_BYTES = 2 * 1024 * 1024

/**
 * Keeps the newest rows that fit the budget. `encoded` is the per-row JSON the App writes, so its
 * length is what the budget measures; `+ 1` is the comma separating rows.
 */
export function capHistory<T>(rows: readonly T[], encoded: (row: T) => string, budget = MAX_HISTORY_BYTES): T[] {
  let bytes = 0
  let from = 0
  const newest = rows.length - 1
  for (let index = newest; index >= 0; index--) {
    bytes += encoded(rows[index]!).length + 1
    if (index < newest && bytes > budget) {
      from = index + 1
      break
    }
  }
  return rows.slice(from)
}
