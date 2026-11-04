import assert from "node:assert/strict"
import test from "node:test"
import { AuthFailureLimiter } from "../src/apiRateLimit.js"

test("AuthFailureLimiter blocks a client once the failure budget is used", () => {
  const limiter = new AuthFailureLimiter({ maxFailures: 2, windowMs: 1_000, blockMs: 5_000 })
  const now = 10_000

  assert.deepEqual(limiter.recordFailure("1.2.3.4", now), { allowed: true, retryAfterSec: 0 })
  const blocked = limiter.recordFailure("1.2.3.4", now + 1)
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.retryAfterSec, 5)

  assert.equal(limiter.check("1.2.3.4", now + 2).allowed, false)
  assert.equal(limiter.check("1.2.3.5", now + 2).allowed, true, "other clients stay usable")
})

test("AuthFailureLimiter forgets a window once it has passed", () => {
  const limiter = new AuthFailureLimiter({ maxFailures: 2, windowMs: 1_000, blockMs: 60_000 })

  limiter.recordFailure("client", 0)
  assert.equal(limiter.recordFailure("client", 1_001).allowed, true, "the old failure is outside the window")
  assert.equal(limiter.check("client", 1_002).allowed, true)
})

test("AuthFailureLimiter clears on success and can prune expired keys", () => {
  const limiter = new AuthFailureLimiter({ maxFailures: 3, windowMs: 1_000, blockMs: 60_000 })
  limiter.recordFailure("a", 0)
  limiter.recordFailure("b", 0)
  limiter.recordSuccess("a")
  assert.equal(limiter.check("a", 0).allowed, true)

  assert.equal(limiter.prune(2_000), 1, "b's window expired")
  assert.equal(limiter.size, 0)
})

test("AuthFailureLimiter stays bounded under address rotation", () => {
  const limiter = new AuthFailureLimiter({ maxFailures: 100, windowMs: 60_000, maxKeys: 3 })
  for (let i = 0; i < 20; i++) limiter.recordFailure(`ip-${i}`, 0)
  assert.equal(limiter.size, 3)
  assert.equal(limiter.check("ip-19", 0).allowed, true, "the newest key is still tracked")
})
