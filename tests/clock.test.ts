import assert from "node:assert/strict"
import test from "node:test"
import { configureFileClock, fileStamp } from "../src/clock.js"

// 2026-11-23T01:02:03.045Z: 09:02 in Shanghai, still the 22nd in New York
const AT = Date.UTC(2026, 10, 23, 1, 2, 3, 45)

test("fileStamp formats in the configured zone, not the host's", () => {
  configureFileClock(() => "Asia/Shanghai")
  try {
    assert.equal(fileStamp(AT), "20261123-090203")
    configureFileClock(() => "America/New_York")
    assert.equal(fileStamp(AT), "20261122-200203")
  } finally {
    configureFileClock(undefined)
  }
})

test("fileStamp honours the precision options", () => {
  assert.equal(fileStamp(AT, { timeZone: "UTC", seconds: false }), "20261123-0102")
  assert.equal(fileStamp(AT, { timeZone: "UTC", millis: true }), "20261123-010203045")
  assert.equal(fileStamp(new Date(AT), { timeZone: "UTC" }), "20261123-010203")
})

test("fileStamp renders midnight as 00, never 24", () => {
  assert.equal(fileStamp(Date.UTC(2026, 0, 1, 0, 0, 0), { timeZone: "UTC" }), "20260101-000000")
})

test("an invalid or empty zone falls back instead of throwing", () => {
  configureFileClock(() => "Not/AZone")
  try {
    assert.equal(fileStamp(AT), "20261123-090203")
    configureFileClock(() => "  ")
    assert.equal(fileStamp(AT), "20261123-090203")
  } finally {
    configureFileClock(undefined)
  }
})
