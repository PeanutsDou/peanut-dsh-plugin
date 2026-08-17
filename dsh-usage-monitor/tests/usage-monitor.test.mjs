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
  DEFAULT_CONFIG,
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
  }, 'deepseek-v4-flash', at)
  // finalized assistant/message usage for the SAME turn/step replaces it
  ledger = foldUsage(ledger, 's1', '会话一', 1, 2, {
    inputTokens: 120,
    outputTokens: 60,
    cacheReadTokens: 400,
    cacheWriteTokens: 5,
  }, 'deepseek-v4-flash', at)

  assert.deepEqual(ledger.allTime, {
    uncachedInputTokens: 120,
    outputTokens: 60,
    cacheReadTokens: 400,
    cacheWriteTokens: 5,
    // flash legacy prices: (120 + 5) * 1 + 400 * 0.02 + 60 * 2 = 253, per 1M
    costCny: 0.000253,
  })
  assert.equal(ledger.days['2026-08-15'].uncachedInputTokens, 120)
  assert.equal(ledger.months['2026-08'].outputTokens, 60)
  assert.equal(ledger.sessions.s1.outputTokens, 60)
  assert.equal(ledger.sessions.s1.costCny, 0.000253)
})

test('foldUsage clamps a downward revision to zero and never erases history', () => {
  let ledger = emptyLedger()
  const at = new Date('2026-08-15T05:00:00.000Z')
  ledger = foldUsage(ledger, 's1', 's1', 1, 1, { inputTokens: 100, outputTokens: 50 }, 'deepseek-v4-flash', at)
  ledger = foldUsage(ledger, 's1', 's1', 1, 1, { inputTokens: 10, outputTokens: 5 }, 'deepseek-v4-flash', at)
  assert.equal(ledger.allTime.inputTokens, undefined)
  assert.equal(ledger.allTime.uncachedInputTokens, 100)
  assert.equal(ledger.allTime.outputTokens, 50)
  // flash legacy prices: 100 * 1 + 50 * 2 = 200, per 1M
  assert.equal(ledger.allTime.costCny, 0.0002)
})

test('usage is attributed to the local calendar day and month of receipt', () => {
  let ledger = emptyLedger()
  const first = new Date(2026, 6, 31, 23, 59)
  const second = new Date(2026, 7, 1, 0, 1)
  ledger = foldUsage(ledger, 's1', 's1', 1, 1, { inputTokens: 10, outputTokens: 1 }, 'flash', first)
  ledger = foldUsage(ledger, 's2', 's2', 1, 1, { inputTokens: 20, outputTokens: 2 }, 'pro', second)
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
  }, 'model-a', new Date('2026-08-15T05:00:00.000Z'))
  saveLedger(ledger, file)
  const loaded = loadLedger(file)
  assert.deepEqual(loaded, ledger)
})

test('foldUsage splits buckets per model and the total stays the sum', () => {
  let ledger = emptyLedger()
  const at = new Date('2026-08-15T05:00:00.000Z')
  ledger = foldUsage(ledger, 's1', 's1', 1, 1, { inputTokens: 100, outputTokens: 50 }, 'deepseek-v4-flash', at)
  ledger = foldUsage(ledger, 's1', 's1', 2, 1, { inputTokens: 200, outputTokens: 100 }, 'deepseek-v4-pro', at)
  assert.equal(ledger.allTime.uncachedInputTokens, 300)
  assert.equal(ledger.byModel.allTime['deepseek-v4-flash'].uncachedInputTokens, 100)
  assert.equal(ledger.byModel.allTime['deepseek-v4-pro'].uncachedInputTokens, 200)
  assert.equal(ledger.byModel.days['2026-08-15']['deepseek-v4-pro'].outputTokens, 100)
  assert.equal(ledger.byModel.months['2026-08']['deepseek-v4-flash'].outputTokens, 50)
  // total cost equals the sum of the per-model costs
  const total = ledger.allTime.costCny
  const split = Object.values(ledger.byModel.allTime).reduce((sum, bucket) => sum + bucket.costCny, 0)
  assert.ok(Math.abs(total - split) < 1e-9)
})

test('a v2 ledger without byModel loads as an empty per-model split', () => {
  const v2 = {
    version: 2,
    allTime: { uncachedInputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 0.0001 },
    days: {},
    months: {},
    sessions: {},
    lastStep: {},
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-monitor-'))
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(file, JSON.stringify(v2))
  const loaded = loadLedger(file)
  assert.equal(loaded.version, 4)
  assert.deepEqual(loaded.byModel, { allTime: {}, days: {}, months: {} })
  assert.equal(loaded.allTime.uncachedInputTokens, 5)
  assert.equal(loaded.allTime.costCny, 0.0001)
})

test('v3 flash buckets priced with pro rates are corrected on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-monitor-v3-'))
  const file = path.join(dir, 'state.json')
  const flash = {
    uncachedInputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
    // v3 charged flash with pro peak prices: 9 + 27 + 0.3 = 36.3.
    costCny: 36.3,
  }
  const pro = {
    uncachedInputTokens: 500_000,
    outputTokens: 200_000,
    cacheReadTokens: 100_000,
    cacheWriteTokens: 0,
    costCny: 9.93,
  }
  const v3 = {
    version: 3,
    allTime: { ...flash, costCny: 46.23 },
    days: { '2026-08-17': { ...flash, costCny: 46.23 } },
    months: { '2026-08': { ...flash, costCny: 46.23 } },
    sessions: {},
    lastStep: {},
    byModel: {
      allTime: { 'deepseek-v4-flash': flash, 'deepseek-v4-pro': pro },
      days: { '2026-08-17': { 'deepseek-v4-flash': flash, 'deepseek-v4-pro': pro } },
      months: { '2026-08': { 'deepseek-v4-flash': flash, 'deepseek-v4-pro': pro } },
    },
  }
  fs.writeFileSync(file, JSON.stringify(v3))

  const loaded = loadLedger(file, DEFAULT_CONFIG)
  assert.equal(loaded.version, 4)
  assert.equal(loaded.allTime.costCny, 36.3 / 3 + 9.93)
  assert.equal(loaded.days['2026-08-17'].costCny, 36.3 / 3 + 9.93)
  assert.equal(loaded.months['2026-08'].costCny, 36.3 / 3 + 9.93)
  assert.equal(loaded.byModel.allTime['deepseek-v4-flash'].costCny, 12.1)
  assert.equal(loaded.byModel.days['2026-08-17']['deepseek-v4-flash'].costCny, 12.1)
  assert.equal(loaded.byModel.months['2026-08']['deepseek-v4-flash'].costCny, 12.1)
  assert.equal(loaded.byModel.allTime['deepseek-v4-pro'].costCny, 9.93)
  assert.equal(loaded.allTime.uncachedInputTokens, 1_000_000)

  // Persist as v4, then reload: the corrected format must not migrate again.
  saveLedger(loaded, file)
  const reloaded = loadLedger(file, DEFAULT_CONFIG)
  assert.equal(reloaded.byModel.allTime['deepseek-v4-flash'].costCny, 12.1)
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

test('flash usage is priced with the flash table, not the pro table', () => {
  const config = { ...DEFAULT_CONFIG }

  // 2026-08-17T01:00Z = Beijing 09:00, peak.
  assert.deepEqual(
    ratesForUsage(config, new Date('2026-08-17T01:00:00.000Z'), 'deepseek-v4-flash'),
    { cacheHit: 0.1, input: 3, output: 9 },
  )
  // 2026-08-17T04:00Z = Beijing 12:00, off-peak gap between 12 and 14.
  assert.deepEqual(
    ratesForUsage(config, new Date('2026-08-17T04:00:00.000Z'), 'deepseek-v4-flash'),
    { cacheHit: 0.05, input: 1.5, output: 4.5 },
  )
  // Before the epoch use the legacy flash price table.
  assert.deepEqual(
    ratesForUsage(config, new Date('2026-08-16T01:00:00.000Z'), 'deepseek-v4-flash'),
    { cacheHit: 0.02, input: 1, output: 2 },
  )

  const flash = costedBucketsOf(
    { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
    new Date('2026-08-17T01:00:00.000Z'),
    config,
    'deepseek-v4-flash',
  )
  const pro = costedBucketsOf(
    { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
    new Date('2026-08-17T01:00:00.000Z'),
    config,
    'deepseek-v4-pro',
  )
  assert.equal(flash.costCny, 3)
  assert.equal(pro.costCny, 9)
})

test('foldUsage records flash cost with the flash peak price', () => {
  const ledger = foldUsage(emptyLedger(), 's1', '会话一', 1, 1, {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
  }, 'deepseek-v4-flash', new Date('2026-08-17T01:00:00.000Z'))
  assert.equal(ledger.allTime.costCny, 3)
  assert.equal(ledger.byModel.allTime['deepseek-v4-flash'].costCny, 3)
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
