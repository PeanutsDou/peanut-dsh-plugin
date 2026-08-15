import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  billedInputTokens,
  bucketsOf,
  cacheHitRate,
  costedBucketsOf,
  deltaBuckets,
  emptyLedger,
  foldUsage,
  loadLedger,
  parseBalancePayload,
  ratesForUsage,
  saveLedger,
  zeroBuckets,
} from '../lib/index.js'

test('foldUsage replaces the same step sample instead of double counting', () => {
  let ledger = emptyLedger()
  const at = new Date('2026-08-15T05:00:00.000Z')
  // chunk usage lands first
  ledger = foldUsage(ledger, 's1', '会话一', 1, 2, {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
  }, at)
  // finalized assistant/message usage for the SAME turn/step replaces it
  ledger = foldUsage(ledger, 's1', '会话一', 1, 2, {
    inputTokens: 120,
    outputTokens: 60,
    cacheReadTokens: 400,
    cacheWriteTokens: 5,
  }, at)

  assert.deepEqual(ledger.allTime, {
    uncachedInputTokens: 120,
    outputTokens: 60,
    cacheReadTokens: 400,
    cacheWriteTokens: 5,
    // (120 + 5) * 3 + 400 * 0.025 + 60 * 6 = 745, per 1M
    costCny: 0.000745,
  })
  assert.equal(ledger.days['2026-08-15'].uncachedInputTokens, 120)
  assert.equal(ledger.months['2026-08'].outputTokens, 60)
  assert.equal(ledger.sessions.s1.outputTokens, 60)
  assert.equal(ledger.sessions.s1.costCny, 0.000745)
})

test('foldUsage clamps a downward revision to zero and never erases history', () => {
  let ledger = emptyLedger()
  const at = new Date('2026-08-15T05:00:00.000Z')
  ledger = foldUsage(ledger, 's1', 's1', 1, 1, { inputTokens: 100, outputTokens: 50 }, at)
  ledger = foldUsage(ledger, 's1', 's1', 1, 1, { inputTokens: 10, outputTokens: 5 }, at)
  assert.equal(ledger.allTime.inputTokens, undefined)
  assert.equal(ledger.allTime.uncachedInputTokens, 100)
  assert.equal(ledger.allTime.outputTokens, 50)
  assert.equal(ledger.allTime.costCny, 0.0006)
})

test('usage is attributed to the local calendar day and month of receipt', () => {
  let ledger = emptyLedger()
  const first = new Date(2026, 6, 31, 23, 59)
  const second = new Date(2026, 7, 1, 0, 1)
  ledger = foldUsage(ledger, 's1', 's1', 1, 1, { inputTokens: 10, outputTokens: 1 }, first)
  ledger = foldUsage(ledger, 's2', 's2', 1, 1, { inputTokens: 20, outputTokens: 2 }, second)
  assert.equal(ledger.days['2026-07-31'].uncachedInputTokens, 10)
  assert.equal(ledger.days['2026-08-01'].uncachedInputTokens, 20)
  assert.equal(ledger.months['2026-07'].outputTokens, 1)
  assert.equal(ledger.months['2026-08'].outputTokens, 2)
})

test('ledger save/load round-trips through an atomic file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-monitor-'))
  const file = path.join(dir, 'state.json')
  const ledger = foldUsage(emptyLedger(), 's1', '会话', 1, 1, {
    inputTokens: 300,
    outputTokens: 80,
    cacheReadTokens: 900,
    cacheWriteTokens: 7,
  }, new Date('2026-08-15T05:00:00.000Z'))
  saveLedger(ledger, file)
  const loaded = loadLedger(file)
  assert.deepEqual(loaded, ledger)
})

test('cache hit rate uses DSH billed-input vocabulary', () => {
  const bucket = { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 10 }
  assert.equal(billedInputTokens(bucket), 410)
  assert.ok(Math.abs((cacheHitRate(bucket) ?? 0) - 300 / 410) < 1e-9)
  assert.equal(cacheHitRate(zeroBuckets()), null)
  assert.deepEqual(bucketsOf({ inputTokens: -1, outputTokens: 2.9, cacheReadTokens: 4 }), {
    uncachedInputTokens: 0,
    outputTokens: 2,
    cacheReadTokens: 4,
    cacheWriteTokens: 0,
    costCny: 0,
  })
  assert.deepEqual(deltaBuckets({ uncachedInputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 0 }, {
    uncachedInputTokens: 9, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 0,
  }), zeroBuckets())
})

test('pricing uses legacy rates before the epoch and Beijing peak/off-peak after', () => {
  // 2026-08-17T01:00Z = Beijing 09:00, peak.
  const peak = ratesForUsage({
    priceEpoch: '2026-08-17',
    priceCacheHitPerM: 0.025,
    priceInputPerM: 3,
    priceOutputPerM: 6,
    offPeakCacheHitPerM: 0.15,
    offPeakInputPerM: 4.5,
    offPeakOutputPerM: 13.5,
    peakCacheHitPerM: 0.3,
    peakInputPerM: 9,
    peakOutputPerM: 27,
  }, new Date('2026-08-17T01:00:00.000Z'))
  assert.deepEqual(peak, { cacheHit: 0.3, input: 9, output: 27 })

  // 2026-08-17T04:00Z = Beijing 12:00, off-peak gap between 12 and 14.
  const offPeak = ratesForUsage({
    priceEpoch: '2026-08-17',
    priceCacheHitPerM: 0.025,
    priceInputPerM: 3,
    priceOutputPerM: 6,
    offPeakCacheHitPerM: 0.15,
    offPeakInputPerM: 4.5,
    offPeakOutputPerM: 13.5,
    peakCacheHitPerM: 0.3,
    peakInputPerM: 9,
    peakOutputPerM: 27,
  }, new Date('2026-08-17T04:00:00.000Z'))
  assert.deepEqual(offPeak, { cacheHit: 0.15, input: 4.5, output: 13.5 })

  const sample = costedBucketsOf({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }, new Date('2026-08-17T01:00:00.000Z'), {
    priceEpoch: '2026-08-17',
    priceCacheHitPerM: 0.025,
    priceInputPerM: 3,
    priceOutputPerM: 6,
    offPeakCacheHitPerM: 0.15,
    offPeakInputPerM: 4.5,
    offPeakOutputPerM: 13.5,
    peakCacheHitPerM: 0.3,
    peakInputPerM: 9,
    peakOutputPerM: 27,
  })
  assert.equal(sample.costCny, 9)
})

test('DeepSeek balance payload parses numeric strings and defaults currency', () => {
  const parsed = parseBalancePayload({
    is_available: true,
    balance_infos: [{
      currency: 'CNY',
      total_balance: '110.50',
      granted_balance: '10.00',
      topped_up_balance: '100.50',
    }],
  })
  assert.deepEqual(parsed, {
    available: true,
    currency: 'CNY',
    total: 110.5,
    granted: 10,
    toppedUp: 100.5,
  })
  assert.equal(parseBalancePayload({ is_available: false, balance_infos: [] }), undefined)
})
