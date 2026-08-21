/**
 * dsh-usage-monitor — host half.
 *
 * - Tracks DeepSeek provider usage from durable session events into per-day /
 *   per-month / all-time buckets, replacing a step's earlier sample so
 *   `assistant/chunk` usage followed by `assistant/message` usage never double
 *   counts (the same strategy as the built-in token meter).
 * - Polls the DeepSeek balance endpoint with the configured credential and
 *   serves a small JSON status route for the browser half.
 * - Never exposes the API key to the client.
 *
 * @module @peanutsdou/dsh-usage-monitor
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildLibraryStatus, refreshLibrary } from './plugin-library'

export const name = 'dsh-usage-monitor'
export const inject = ['settings', 'credentials', 'webServer', 'sessions']

/** Plugin configuration (settings.yaml, editable via the plugin card). */
export interface UsageMonitorConfig {
  balanceUrl: string
  credentialRef: string
  balancePollMs: number
  /** Root of the personal plugin library manifest (`library.json`). */
  libraryRoot: string
  /** CNY per 1M tokens before the peak/off-peak schedule starts (deepseek-v4-pro). */
  priceCacheHitPerM: number
  priceInputPerM: number
  priceOutputPerM: number
  /** Peak/off-peak schedule starts on this Beijing date (YYYY-MM-DD). */
  priceEpoch: string
  offPeakCacheHitPerM: number
  offPeakInputPerM: number
  offPeakOutputPerM: number
  peakCacheHitPerM: number
  peakInputPerM: number
  peakOutputPerM: number
  /** deepseek-v4-flash legacy / off-peak / peak prices (CNY per 1M tokens). */
  flashPriceCacheHitPerM: number
  flashPriceInputPerM: number
  flashPriceOutputPerM: number
  flashOffPeakCacheHitPerM: number
  flashOffPeakInputPerM: number
  flashOffPeakOutputPerM: number
  flashPeakCacheHitPerM: number
  flashPeakInputPerM: number
  flashPeakOutputPerM: number
}

export const ConfigSchema: z<UsageMonitorConfig> = z.object({
  balanceUrl: z.string().default('https://api.deepseek.com'),
  credentialRef: z.string().default('DEEPSEEK_API_KEY'),
  balancePollMs: z.number().default(600000),
  libraryRoot: z.string().default('D:\\douzhongjun\\dsh-plugin-library'),
  priceCacheHitPerM: z.number().default(0.025),
  priceInputPerM: z.number().default(3),
  priceOutputPerM: z.number().default(6),
  priceEpoch: z.string().default('2026-08-17'),
  offPeakCacheHitPerM: z.number().default(0.15),
  offPeakInputPerM: z.number().default(4.5),
  offPeakOutputPerM: z.number().default(13.5),
  peakCacheHitPerM: z.number().default(0.3),
  peakInputPerM: z.number().default(9),
  peakOutputPerM: z.number().default(27),
  flashPriceCacheHitPerM: z.number().default(0.02),
  flashPriceInputPerM: z.number().default(1),
  flashPriceOutputPerM: z.number().default(2),
  flashOffPeakCacheHitPerM: z.number().default(0.05),
  flashOffPeakInputPerM: z.number().default(1.5),
  flashOffPeakOutputPerM: z.number().default(4.5),
  flashPeakCacheHitPerM: z.number().default(0.1),
  flashPeakInputPerM: z.number().default(3),
  flashPeakOutputPerM: z.number().default(9),
})

export const DEFAULT_CONFIG: UsageMonitorConfig = {
  balanceUrl: 'https://api.deepseek.com',
  credentialRef: 'DEEPSEEK_API_KEY',
  balancePollMs: 600000,
  libraryRoot: 'D:\\douzhongjun\\dsh-plugin-library',
  // Official deepseek-v4-pro prices before 2026-08-17.
  priceCacheHitPerM: 0.025,
  priceInputPerM: 3,
  priceOutputPerM: 6,
  priceEpoch: '2026-08-17',
  // Official deepseek-v4-pro peak/off-peak prices from 2026-08-17.
  offPeakCacheHitPerM: 0.15,
  offPeakInputPerM: 4.5,
  offPeakOutputPerM: 13.5,
  peakCacheHitPerM: 0.3,
  peakInputPerM: 9,
  peakOutputPerM: 27,
  // Official deepseek-v4-flash prices before / after 2026-08-17.
  flashPriceCacheHitPerM: 0.02,
  flashPriceInputPerM: 1,
  flashPriceOutputPerM: 2,
  flashOffPeakCacheHitPerM: 0.05,
  flashOffPeakInputPerM: 1.5,
  flashOffPeakOutputPerM: 4.5,
  flashPeakCacheHitPerM: 0.1,
  flashPeakInputPerM: 3,
  flashPeakOutputPerM: 9,
}

/** Provider-neutral token buckets (same vocabulary as the built-in token meter). */
export interface TokenBuckets {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Token buckets plus estimated spend in CNY. */
export interface CostedBuckets extends TokenBuckets {
  costCny: number
}

/** Provider usage in the same shape as DSH's TokenUsage. */
export interface TokenUsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

interface SessionRow extends CostedBuckets {
  id: string
  label: string
  updatedAt: number
}

export interface LedgerState {
  version: 4
  allTime: CostedBuckets
  days: Record<string, CostedBuckets>
  months: Record<string, CostedBuckets>
  sessions: Record<string, SessionRow>
  /** Last buckets per `sessionId:turn:step`, used for replace-not-add folding. */
  lastStep: Record<string, CostedBuckets>
  /** The same totals split per model id (from `request/header` snapshots). */
  byModel: {
    allTime: Record<string, CostedBuckets>
    days: Record<string, Record<string, CostedBuckets>>
    months: Record<string, Record<string, CostedBuckets>>
  }
}

export interface BalanceSnapshot {
  ok: boolean
  available?: boolean
  currency?: string
  total?: number
  granted?: number
  toppedUp?: number
  fetchedAt: number
  error?: string
}

/** Live machine state sampled by the host: memory / CPU / NVIDIA GPU. */
export interface SysInfoSnapshot {
  memPercent: number
  /** Total physical memory in GB (rounded), e.g. 48. */
  memTotalGb: number
  cpuPercent: number
  /** Logical CPU core count, e.g. 16. */
  cpuCores: number
  gpu: { model: string | null; utilPercent: number; memUsedMb: number; memTotalMb: number } | null
  at: number
}

/** Per-core [idleMs, totalMs] snapshot for CPU-usage delta math. */
type CpuSample = Array<[number, number]>

function readCpuSample(): CpuSample {
  return os.cpus().map(core => {
    const t = core.times
    const total = t.user + t.nice + t.sys + t.idle + t.irq
    return [t.idle, total]
  })
}

function cpuUsagePercent(prev: CpuSample, cur: CpuSample): number {
  if (prev.length === 0 || prev.length !== cur.length) return 0
  let idleDelta = 0
  let totalDelta = 0
  for (let i = 0; i < cur.length; i++) {
    const before = prev[i]
    const after = cur[i]
    if (before === undefined || after === undefined) continue
    idleDelta += Math.max(0, after[0] - before[0])
    totalDelta += Math.max(0, after[1] - before[1])
  }
  if (totalDelta <= 0) return 0
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10
}

/** Short NVIDIA model label from the full name, e.g. "RTX 4070 Ti" → "RTX 4070Ti". */
export function extractGpuModel(name: string): string | null {
  const match = name.match(/\b(RTX|GTX|Quadro|Tesla|A)\s*(\d+)\s*(Ti|Super|S|Max-Q)?\b/i)
  if (match === null) return null
  const series = match[1]?.toUpperCase() ?? ''
  const digits = match[2] ?? ''
  const suffix = (match[3] ?? '').replace(/\s+/g, '')
  return series === 'A' ? `A${digits}${suffix}` : `${series} ${digits}${suffix}`
}

/** Parse the first `nvidia-smi --format=csv,noheader,nounits` line (name + stats). */
export function parseNvidiaSmi(line: string): { model: string | null; utilPercent: number; memUsedMb: number; memTotalMb: number } | null {
  const comma = line.indexOf(',')
  const name = (comma === -1 ? line : line.slice(0, comma)).trim()
  const stats = (comma === -1 ? '' : line.slice(comma + 1)).split(',').map(part => Number(part.trim()))
  if (stats.length < 3 || stats.some(part => !Number.isFinite(part))) return null
  const [utilPercent, memUsedMb, memTotalMb] = stats
  if (utilPercent === undefined || memUsedMb === undefined || memTotalMb === undefined) return null
  return { model: extractGpuModel(name), utilPercent, memUsedMb, memTotalMb }
}

function readNvidiaGpu(): Promise<{ model: string | null; utilPercent: number; memUsedMb: number; memTotalMb: number } | null> {
  return new Promise(resolve => {
    execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], {
      timeout: 3000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      const line = String(stdout).split(/\r?\n/).map(line => line.trim()).find(line => line !== '')
      resolve(line === undefined ? null : parseNvidiaSmi(line))
    })
  })
}

/** Build one machine-state sampler; call `sample()` before every read. */
export function createSysSampler(): { sample: () => Promise<SysInfoSnapshot> } {
  let prevCpu = readCpuSample()
  let gpuCache: SysInfoSnapshot['gpu'] | undefined
  let gpuAt = 0
  return {
    async sample(): Promise<SysInfoSnapshot> {
      const curCpu = readCpuSample()
      const cpuPercent = cpuUsagePercent(prevCpu, curCpu)
      prevCpu = curCpu
      const totalMem = os.totalmem()
      const freeMem = os.freemem()
      const memPercent = totalMem === 0 ? 0 : Math.round((1 - freeMem / totalMem) * 1000) / 10
      const memTotalGb = Math.round(totalMem / (1024 * 1024 * 1024))
      // GPU polls spawn a process: refresh at most once per 5 seconds.
      if (gpuCache === undefined || Date.now() - gpuAt > 5000) {
        gpuCache = await readNvidiaGpu()
        gpuAt = Date.now()
      }
      return { memPercent, memTotalGb, cpuPercent, cpuCores: os.cpus().length, gpu: gpuCache ?? null, at: Date.now() }
    },
  }
}

/** Parse DeepSeek /user/balance payload; exported for tests. */
export function parseBalancePayload(data: unknown): Omit<BalanceSnapshot, 'ok' | 'fetchedAt' | 'error'> | undefined {
  const record = (data ?? {}) as {
    is_available?: unknown
    balance_infos?: Array<{
      currency?: unknown
      total_balance?: unknown
      granted_balance?: unknown
      topped_up_balance?: unknown
    }>
  }
  const info = Array.isArray(record.balance_infos) ? record.balance_infos[0] : undefined
  if (info === undefined) return undefined
  const num = (value: unknown): number => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return {
    available: record.is_available === true,
    currency: typeof info.currency === 'string' ? info.currency : 'CNY',
    total: num(info.total_balance),
    granted: num(info.granted_balance),
    toppedUp: num(info.topped_up_balance),
  }
}

function homeDir(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function stateFilePath(): string {
  return path.join(homeDir(), 'usage-monitor', 'state.json')
}

export function zeroBuckets(): CostedBuckets {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 0 }
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export function bucketsOf(usage: TokenUsageLike): CostedBuckets {
  return {
    uncachedInputTokens: nonNegativeInt(usage.inputTokens),
    outputTokens: nonNegativeInt(usage.outputTokens),
    cacheReadTokens: nonNegativeInt(usage.cacheReadTokens ?? 0),
    cacheWriteTokens: nonNegativeInt(usage.cacheWriteTokens ?? 0),
    costCny: 0,
  }
}

export interface PricingRates {
  cacheHit: number
  input: number
  output: number
}

const LEGACY_RATES: PricingRates = {
  cacheHit: DEFAULT_CONFIG.priceCacheHitPerM,
  input: DEFAULT_CONFIG.priceInputPerM,
  output: DEFAULT_CONFIG.priceOutputPerM,
}

/** Which official DeepSeek V4 price table a model id belongs to. */
export function modelRateKind(model: string): 'flash' | 'pro' {
  const id = model.trim().toLowerCase()
  if (id.includes('flash') || id === 'deepseek-chat') return 'flash'
  return 'pro'
}

function beijingParts(date: Date): { dayKey: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string): string => parts.find(part => part.type === type)?.value ?? '0'
  return {
    dayKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  }
}

function isPeakHour(hour: number): boolean {
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/**
 * Effective CNY-per-1M pricing for one event:
 *  - before `priceEpoch` use the model's legacy prices;
 *  - after the epoch use the model's official Beijing peak/off-peak schedule.
 *
 * deepseek-v4-flash has its own (lower) official price table; the previous
 * implementation accidentally charged it with the deepseek-v4-pro table,
 * which is exactly 3x the flash price in every peak/off-peak slot.
 */
export function ratesForUsage(config: UsageMonitorConfig, at: Date, model = 'deepseek-v4-pro'): PricingRates {
  const beijing = beijingParts(at)
  const flash = modelRateKind(model) === 'flash'
  if (beijing.dayKey < config.priceEpoch) {
    return flash
      ? { cacheHit: config.flashPriceCacheHitPerM, input: config.flashPriceInputPerM, output: config.flashPriceOutputPerM }
      : { cacheHit: config.priceCacheHitPerM, input: config.priceInputPerM, output: config.priceOutputPerM }
  }
  if (isPeakHour(beijing.hour)) {
    return flash
      ? { cacheHit: config.flashPeakCacheHitPerM, input: config.flashPeakInputPerM, output: config.flashPeakOutputPerM }
      : { cacheHit: config.peakCacheHitPerM, input: config.peakInputPerM, output: config.peakOutputPerM }
  }
  return flash
    ? { cacheHit: config.flashOffPeakCacheHitPerM, input: config.flashOffPeakInputPerM, output: config.flashOffPeakOutputPerM }
    : { cacheHit: config.offPeakCacheHitPerM, input: config.offPeakInputPerM, output: config.offPeakOutputPerM }
}

/** Estimated spend for one usage sample. Cache-write tokens are billed as uncached input. */
export function costForBuckets(tokens: TokenBuckets, rates: PricingRates): number {
  const cny = (
    (tokens.uncachedInputTokens + tokens.cacheWriteTokens) * rates.input
    + tokens.cacheReadTokens * rates.cacheHit
    + tokens.outputTokens * rates.output
  ) / 1_000_000
  return Math.round(cny * 1_000_000) / 1_000_000
}

/** Token + cost buckets for one usage sample at a point in time. */
export function costedBucketsOf(usage: TokenUsageLike, at: Date, config: UsageMonitorConfig = DEFAULT_CONFIG, model = 'deepseek-v4-pro'): CostedBuckets {
  const tokens = bucketsOf(usage)
  return { ...tokens, costCny: costForBuckets(tokens, ratesForUsage(config, at, model)) }
}

/** Signed bucket delta (tokens and cost), clamped at zero so revisions cannot erase history. */
export function deltaBuckets(next: CostedBuckets, previous?: CostedBuckets): CostedBuckets {
  const base = previous ?? zeroBuckets()
  return {
    uncachedInputTokens: Math.max(0, next.uncachedInputTokens - base.uncachedInputTokens),
    outputTokens: Math.max(0, next.outputTokens - base.outputTokens),
    cacheReadTokens: Math.max(0, next.cacheReadTokens - base.cacheReadTokens),
    cacheWriteTokens: Math.max(0, next.cacheWriteTokens - base.cacheWriteTokens),
    costCny: Math.max(0, next.costCny - base.costCny),
  }
}

function addBuckets(target: CostedBuckets, delta: CostedBuckets): CostedBuckets {
  return {
    uncachedInputTokens: target.uncachedInputTokens + delta.uncachedInputTokens,
    outputTokens: target.outputTokens + delta.outputTokens,
    cacheReadTokens: target.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + delta.cacheWriteTokens,
    costCny: Math.round((target.costCny + delta.costCny) * 1_000_000) / 1_000_000,
  }
}

function isZero(delta: CostedBuckets): boolean {
  return delta.uncachedInputTokens === 0
    && delta.outputTokens === 0
    && delta.cacheReadTokens === 0
    && delta.cacheWriteTokens === 0
    && delta.costCny === 0
}

function totalTokens(bucket: TokenBuckets): number {
  return bucket.uncachedInputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
}

/** Billed input under DSH's own cache vocabulary: input + cache read + cache write. */
export function billedInputTokens(bucket: TokenBuckets): number {
  return bucket.uncachedInputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
}

export function cacheHitRate(bucket: TokenBuckets): number | null {
  const billed = billedInputTokens(bucket)
  return billed === 0 ? null : bucket.cacheReadTokens / billed
}

function localDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function localMonthKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function sanitizeBuckets(value: unknown): CostedBuckets {
  const record = (value ?? {}) as Record<string, unknown>
  const tokens = {
    uncachedInputTokens: nonNegativeInt(Number(record.uncachedInputTokens)),
    outputTokens: nonNegativeInt(Number(record.outputTokens)),
    cacheReadTokens: nonNegativeInt(Number(record.cacheReadTokens)),
    cacheWriteTokens: nonNegativeInt(Number(record.cacheWriteTokens)),
  }
  // v1 ledgers have no cost field: backfill with the pre-epoch legacy price.
  const cost = Number(record.costCny)
  return {
    ...tokens,
    costCny: Number.isFinite(cost) && cost >= 0 ? cost : costForBuckets(tokens, LEGACY_RATES),
  }
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/**
 * v3 tracked per-model tokens but priced every model with the
 * deepseek-v4-pro table. For the official default tables, flash prices are
 * exactly one third of pro prices in every peak/off-peak slot, so a stored
 * flash `costCny` can be corrected exactly by dividing by 3 (tokens stay the
 * same). Custom price tables are left untouched because their peak/off-peak
 * split is not stored per bucket.
 */
function migrateV3FlashPricing(ledger: LedgerState, config: UsageMonitorConfig): LedgerState {
  const isDefaultPricing = config.priceEpoch === '2026-08-17'
    && config.offPeakCacheHitPerM === 0.15 && config.offPeakInputPerM === 4.5 && config.offPeakOutputPerM === 13.5
    && config.peakCacheHitPerM === 0.3 && config.peakInputPerM === 9 && config.peakOutputPerM === 27
    && config.flashOffPeakCacheHitPerM === 0.05 && config.flashOffPeakInputPerM === 1.5 && config.flashOffPeakOutputPerM === 4.5
    && config.flashPeakCacheHitPerM === 0.1 && config.flashPeakInputPerM === 3 && config.flashPeakOutputPerM === 9
  if (!isDefaultPricing) return ledger
  const hasFlashBuckets = Object.values(ledger.byModel.days).some(models =>
    Object.keys(models).some(model => modelRateKind(model) === 'flash'),
  )
  if (!hasFlashBuckets) return ledger

  const days = { ...ledger.days }
  const months = { ...ledger.months }
  const byModel = {
    allTime: { ...ledger.byModel.allTime },
    days: Object.fromEntries(Object.entries(ledger.byModel.days).map(([day, models]) => [day, { ...models }])),
    months: Object.fromEntries(Object.entries(ledger.byModel.months).map(([month, models]) => [month, { ...models }])),
  }

  const reprice = (bucket: CostedBuckets): { bucket: CostedBuckets; delta: number } => {
    const corrected = roundCost(bucket.costCny / 3)
    return { bucket: { ...bucket, costCny: corrected }, delta: corrected - bucket.costCny }
  }

  for (const [model, bucket] of Object.entries(byModel.allTime)) {
    if (modelRateKind(model) !== 'flash') continue
    const { bucket: corrected } = reprice(bucket)
    byModel.allTime[model] = corrected
    // The all-time aggregate is recomputed from corrected day totals below,
    // so this delta is intentionally not applied again here.
  }

  for (const [day, models] of Object.entries(byModel.days)) {
    let dayDelta = 0
    for (const [model, bucket] of Object.entries(models)) {
      if (modelRateKind(model) !== 'flash') continue
      const { bucket: corrected, delta } = reprice(bucket)
      byModel.days[day]![model] = corrected
      dayDelta += delta
    }
    if (dayDelta !== 0 && days[day] !== undefined) {
      days[day] = { ...days[day]!, costCny: Math.max(0, roundCost(days[day]!.costCny + dayDelta)) }
    }
  }

  for (const [month, models] of Object.entries(byModel.months)) {
    let monthDelta = 0
    for (const [model, bucket] of Object.entries(models)) {
      if (modelRateKind(model) !== 'flash') continue
      const { bucket: corrected, delta } = reprice(bucket)
      byModel.months[month]![model] = corrected
      monthDelta += delta
    }
    if (monthDelta !== 0 && months[month] !== undefined) {
      months[month] = { ...months[month]!, costCny: Math.max(0, roundCost(months[month]!.costCny + monthDelta)) }
    }
  }

  // Keep all-time and month aggregates consistent with the corrected days.
  const allTimeCost = roundCost(Object.values(days).reduce((sum, bucket) => sum + bucket.costCny, 0))
  const monthCosts = new Map<string, number>()
  for (const [day, bucket] of Object.entries(days)) {
    const month = day.slice(0, 7)
    monthCosts.set(month, (monthCosts.get(month) ?? 0) + bucket.costCny)
  }
  for (const [month, bucket] of Object.entries(months)) {
    const next = monthCosts.get(month)
    if (next !== undefined) months[month] = { ...bucket, costCny: roundCost(next) }
  }

  return {
    ...ledger,
    allTime: { ...ledger.allTime, costCny: allTimeCost },
    days,
    months,
    byModel,
  }
}

function sanitizeLedger(value: unknown, config: UsageMonitorConfig = DEFAULT_CONFIG): LedgerState {
  const record = (value ?? {}) as Record<string, unknown>
  const days: Record<string, CostedBuckets> = {}
  const months: Record<string, CostedBuckets> = {}
  const sessions: Record<string, SessionRow> = {}
  const lastStep: Record<string, CostedBuckets> = {}
  const byModel = { allTime: {} as Record<string, CostedBuckets>, days: {} as Record<string, Record<string, CostedBuckets>>, months: {} as Record<string, Record<string, CostedBuckets>> }
  for (const [key, raw] of Object.entries((record.days ?? {}) as Record<string, unknown>)) days[key] = sanitizeBuckets(raw)
  for (const [key, raw] of Object.entries((record.months ?? {}) as Record<string, unknown>)) months[key] = sanitizeBuckets(raw)
  for (const [key, raw] of Object.entries((record.sessions ?? {}) as Record<string, unknown>)) {
    const row = (raw ?? {}) as Record<string, unknown>
    sessions[key] = {
      ...sanitizeBuckets(raw),
      id: typeof row.id === 'string' ? row.id : key,
      label: typeof row.label === 'string' ? row.label : key.slice(0, 12),
      updatedAt: Number.isFinite(Number(row.updatedAt)) ? Number(row.updatedAt) : 0,
    }
  }
  for (const [key, raw] of Object.entries((record.lastStep ?? {}) as Record<string, unknown>)) lastStep[key] = sanitizeBuckets(raw)
  const rawByModel = (record.byModel ?? {}) as Record<string, unknown>
  const rawModelAllTime = (rawByModel.allTime ?? {}) as Record<string, unknown>
  const rawModelDays = (rawByModel.days ?? {}) as Record<string, unknown>
  const rawModelMonths = (rawByModel.months ?? {}) as Record<string, unknown>
  for (const [key, raw] of Object.entries(rawModelAllTime)) byModel.allTime[key] = sanitizeBuckets(raw)
  for (const [key, raw] of Object.entries(rawModelDays)) {
    byModel.days[key] = {}
    for (const [model, buckets] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
      byModel.days[key][model] = sanitizeBuckets(buckets)
    }
  }
  for (const [key, raw] of Object.entries(rawModelMonths)) {
    byModel.months[key] = {}
    for (const [model, buckets] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
      byModel.months[key][model] = sanitizeBuckets(buckets)
    }
  }
  const sourceVersion = Number(record.version)
  let ledger: LedgerState = {
    version: 4,
    allTime: sanitizeBuckets(record.allTime),
    days,
    months,
    sessions,
    lastStep,
    byModel,
  }
  // Only v3 has the byModel buckets and the pro-priced-flash bug this
  // migration repairs; older ledgers must keep their legacy all-time cost.
  if (sourceVersion === 3) {
    ledger = migrateV3FlashPricing(ledger, config)
  }
  return ledger
}

export function emptyLedger(): LedgerState {
  return {
    version: 4,
    allTime: zeroBuckets(),
    days: {},
    months: {},
    sessions: {},
    lastStep: {},
    byModel: { allTime: {}, days: {}, months: {} },
  }
}

export function loadLedger(file = stateFilePath(), config: UsageMonitorConfig = DEFAULT_CONFIG): LedgerState {
  try {
    return sanitizeLedger(JSON.parse(fs.readFileSync(file, 'utf8')), config)
  } catch {
    return emptyLedger()
  }
}

/** Atomic-enough whole-file save: temp + rename, fallback replace on Windows. */
export function saveLedger(ledger: LedgerState, file = stateFilePath()): void {
  const data = JSON.stringify(ledger, null, 2) + '\n'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch {
    fs.rmSync(file, { force: true })
    fs.renameSync(tmp, file)
  }
}

/**
 * Pure fold: replace the step's previous buckets and allocate the clamped delta
 * into all-time, local day/month, and per-session rows, plus the per-model
 * split under `byModel`. Exported for tests.
 */
export function foldUsage(
  ledger: LedgerState,
  sessionId: string,
  label: string,
  turn: number,
  step: number,
  usage: TokenUsageLike,
  model = 'unknown',
  at = new Date(),
  config: UsageMonitorConfig = DEFAULT_CONFIG,
): LedgerState {
  const next = costedBucketsOf(usage, at, config, model)
  const key = `${sessionId}:${turn}:${step}`
  const delta = deltaBuckets(next, ledger.lastStep[key])
  if (isZero(delta)) return ledger

  const dayKey = localDayKey(at)
  const monthKey = localMonthKey(at)
  const existing = ledger.sessions[sessionId]
  const sessionRow: SessionRow = {
    ...addBuckets(existing ?? zeroBuckets(), delta),
    id: sessionId,
    label: label || existing?.label || sessionId.slice(0, 12),
    updatedAt: at.getTime(),
  }

  const days = { ...ledger.days }
  days[dayKey] = addBuckets(days[dayKey] ?? zeroBuckets(), delta)
  const months = { ...ledger.months }
  months[monthKey] = addBuckets(months[monthKey] ?? zeroBuckets(), delta)

  const byModel = ledger.byModel
  const modelDays = { ...byModel.days }
  const modelDay = { ...(modelDays[dayKey] ?? {}) }
  modelDay[model] = addBuckets(modelDay[model] ?? zeroBuckets(), delta)
  modelDays[dayKey] = modelDay
  const modelMonths = { ...byModel.months }
  const modelMonth = { ...(modelMonths[monthKey] ?? {}) }
  modelMonth[model] = addBuckets(modelMonth[model] ?? zeroBuckets(), delta)
  modelMonths[monthKey] = modelMonth

  return {
    ...ledger,
    allTime: addBuckets(ledger.allTime, delta),
    days,
    months,
    sessions: { ...ledger.sessions, [sessionId]: sessionRow },
    lastStep: { ...ledger.lastStep, [key]: next },
    byModel: {
      allTime: { ...byModel.allTime, [model]: addBuckets(byModel.allTime[model] ?? zeroBuckets(), delta) },
      days: modelDays,
      months: modelMonths,
    },
  }
}

function usageOfEvent(rawEvent: unknown): { turn: number; step: number; usage: TokenUsageLike } | undefined {
  const event = rawEvent as {
    type?: string
    data?: {
      turn?: unknown
      step?: unknown
      usage?: unknown
      chunk?: { type?: string; usage?: unknown }
    }
  }
  if (event.type === 'assistant/message') {
    const usage = event.data?.usage
    if (usage === undefined) return undefined
    return {
      turn: Number(event.data?.turn),
      step: Number(event.data?.step),
      usage: usage as TokenUsageLike,
    }
  }
  if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
    const usage = event.data.chunk.usage
    if (usage === undefined) return undefined
    return {
      turn: Number(event.data.turn),
      step: Number(event.data.step),
      usage: usage as TokenUsageLike,
    }
  }
  return undefined
}

function titleOfEvent(rawEvent: unknown): string | undefined {
  const event = rawEvent as { type?: string; data?: { title?: unknown } }
  if (event.type !== 'session/title') return undefined
  return typeof event.data?.title === 'string' ? event.data.title : undefined
}

function sessionLabel(rawSession: unknown, sessionId: string): string {
  const session = rawSession as { header?: { cwd?: unknown } } | undefined
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') return path.basename(cwd) + ' · ' + sessionId.slice(0, 12)
  return sessionId.slice(0, 12)
}

/** Recent calendar days, zero-filled, oldest first. */
function recentDays(ledger: LedgerState, count: number, now = new Date()): Array<{ date: string; buckets: CostedBuckets }> {
  const out: Array<{ date: string; buckets: CostedBuckets }> = []
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = localDayKey(date)
    out.push({ date: key, buckets: ledger.days[key] ?? zeroBuckets() })
  }
  return out
}

/** Recent calendar months, zero-filled, oldest first. */
function recentMonths(ledger: LedgerState, count: number, now = new Date()): Array<{ month: string; buckets: CostedBuckets }> {
  const out: Array<{ month: string; buckets: CostedBuckets }> = []
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = localMonthKey(date)
    out.push({ month: key, buckets: ledger.months[key] ?? zeroBuckets() })
  }
  return out
}

function pruneLastStep(ledger: LedgerState): LedgerState {
  const keys = Object.keys(ledger.lastStep)
  if (keys.length <= 5000) return ledger
  const next = { ...ledger.lastStep }
  for (const key of keys.slice(0, keys.length - 5000)) delete next[key]
  return { ...ledger, lastStep: next }
}

interface HttpRequest {
  method?: string
  url?: string
}

interface HttpResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Buffer): void
}

export function apply(ctx: Context, config?: Partial<UsageMonitorConfig>): void {
  const staticConfig: UsageMonitorConfig = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  const ledgerFile = stateFilePath()
  let ledger = pruneLastStep(loadLedger(ledgerFile, staticConfig))
  let saveTimer: NodeJS.Timeout | undefined
  let balance: BalanceSnapshot = { ok: false, fetchedAt: 0, error: 'not fetched yet' }
  let balanceInFlight: Promise<BalanceSnapshot> | undefined
  let pollTimer: NodeJS.Timeout | undefined
  const sysSampler = createSysSampler()

  let resolveConfig: () => UsageMonitorConfig = () => staticConfig
  const dynamic = (): UsageMonitorConfig => resolveConfig()

  const scheduleSave = (): void => {
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      try { saveLedger(ledger, ledgerFile) } catch (error) {
        console.error('[dsh-usage-monitor] failed to save ledger:', error)
      }
    }, 2000)
  }

  const flushSave = (): void => {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
    try { saveLedger(ledger, ledgerFile) } catch (error) {
      console.error('[dsh-usage-monitor] failed to save ledger:', error)
    }
  }

  try {
    installSettingsSection(ctx, settingsNamespace('dsh-usage-monitor'), ConfigSchema, DEFAULT_CONFIG, {
      setSource: (get) => { resolveConfig = get },
      onChange: () => {},
    })
  } catch (error) {
    console.error('[dsh-usage-monitor] settings section unavailable:', error)
  }

  // Current model id, tracked from `request/header` snapshots so usage events
  // fold into the right per-model bucket. Unknown until the first header.
  let currentModel = 'unknown'

  ctx.on('session/event', (rawSession: unknown, rawEvent: unknown) => {
    const event = rawEvent as {
      type?: string
      data?: {
        header?: { config?: { model?: unknown } }
        title?: unknown
      }
    }
    if (event.type === 'request/header') {
      const model = event.data?.header?.config?.model
      if (typeof model === 'string' && model !== '') currentModel = model
      return
    }
    const sessionId = (rawSession as { id?: unknown } | undefined)?.id
    const title = titleOfEvent(rawEvent)
    if (title !== undefined && typeof sessionId === 'string') {
      const existing = ledger.sessions[sessionId]
      if (existing !== undefined && existing.label !== title) {
        ledger = { ...ledger, sessions: { ...ledger.sessions, [sessionId]: { ...existing, label: title } } }
        scheduleSave()
      }
      return
    }
    if (typeof sessionId !== 'string') return
    const sample = usageOfEvent(rawEvent)
    if (sample === undefined || !Number.isFinite(sample.turn) || !Number.isFinite(sample.step)) return
    ledger = foldUsage(ledger, sessionId, sessionLabel(rawSession, sessionId), sample.turn, sample.step, sample.usage, currentModel, new Date(), dynamic())
    scheduleSave()
  })

  const refreshBalance = async (): Promise<BalanceSnapshot> => {
    if (balanceInFlight !== undefined) return balanceInFlight
    balanceInFlight = (async () => {
      const config = dynamic()
      let base: string
      try {
        const parsed = new URL(config.balanceUrl)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
        base = parsed.href
      } catch {
        balance = { ok: false, fetchedAt: Date.now(), error: 'balance URL invalid' }
        return balance
      }
      const credentials = ctx.get('credentials') as unknown as {
        resolve: (ref: unknown) => Promise<{ value: string } | undefined>
      } | undefined
      let key = ''
      try {
        const hit = credentials === undefined ? undefined : await credentials.resolve(credentialRef(config.credentialRef))
        key = hit?.value ?? ''
      } catch (error) {
        balance = { ok: false, fetchedAt: Date.now(), error: 'credential resolve failed' }
        return balance
      }
      if (key === '') {
        balance = { ok: false, fetchedAt: Date.now(), error: 'credential missing' }
        return balance
      }
      try {
        const response = await fetch(new URL('user/balance', base.endsWith('/') ? base : base + '/'), {
          method: 'GET',
          headers: { accept: 'application/json', authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10000),
        })
        if (!response.ok) {
          balance = { ok: false, fetchedAt: Date.now(), error: `balance HTTP ${response.status}` }
          return balance
        }
        const data = await response.json() as unknown
        const parsed = parseBalancePayload(data)
        if (parsed === undefined) {
          balance = { ok: false, fetchedAt: Date.now(), error: 'balance response malformed' }
          return balance
        }
        balance = { ok: true, fetchedAt: Date.now(), ...parsed }
      } catch {
        balance = { ok: false, fetchedAt: Date.now(), error: 'balance fetch failed' }
      }
      return balance
    })()
    try {
      return await balanceInFlight
    } finally {
      balanceInFlight = undefined
    }
  }

  const scheduleBalancePoll = (): void => {
    const delay = Math.max(60000, dynamic().balancePollMs || 600000)
    pollTimer = setTimeout(() => {
      void refreshBalance().finally(scheduleBalancePoll)
    }, delay)
    pollTimer.unref?.()
  }

  void refreshBalance()
  scheduleBalancePoll()

  const buildStatus = async () => {
    const now = new Date()
    const today = ledger.days[localDayKey(now)] ?? zeroBuckets()
    const month = ledger.months[localMonthKey(now)] ?? zeroBuckets()
    const days = recentDays(ledger, 7, now)
    const weekCost = days.reduce((sum, row) => sum + row.buckets.costCny, 0)
    const models = Object.keys(ledger.byModel.allTime).sort()
    const modelCosts: Record<string, CostedBuckets> = {}
    for (const model of models) modelCosts[model] = ledger.byModel.allTime[model] ?? zeroBuckets()
    return {
      ok: true,
      generatedAt: now.getTime(),
      balance,
      sysinfo: await sysSampler.sample(),
      usage: {
        today,
        month,
        allTime: ledger.allTime,
        todayCost: today.costCny,
        weekCost: Math.round(weekCost * 1_000_000) / 1_000_000,
        monthCost: month.costCny,
        allTimeCost: ledger.allTime.costCny,
        todayCacheHitRate: cacheHitRate(today),
        monthCacheHitRate: cacheHitRate(month),
        allTimeCacheHitRate: cacheHitRate(ledger.allTime),
        days: days.map(row => ({ date: row.date, buckets: row.buckets, byModel: ledger.byModel.days[row.date] ?? {} })),
        months: recentMonths(ledger, 12, now).map(row => ({ month: row.month, buckets: row.buckets, byModel: ledger.byModel.months[row.month] ?? {} })),
        models,
        modelCosts,
      },
    }
  }

  const webServer = ctx.get('webServer') as { register: (route: WebRoute) => () => void } | undefined
  if (webServer !== undefined) {
    ctx.effect(() => {
      const disposeStatus = webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-usage-monitor/status',
        handler: async (_req: HttpRequest, res: HttpResponse) => {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(await buildStatus()))
        },
      })
      const disposeRefresh = webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-usage-monitor/refresh-balance',
        handler: async (_req: HttpRequest, res: HttpResponse) => {
          if ((_req.method ?? 'GET') !== 'POST') {
            res.writeHead(405, { allow: 'POST' })
            res.end('method not allowed')
            return
          }
          await refreshBalance()
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(await buildStatus()))
        },
      })
      const disposeLibrary = webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-usage-monitor/plugin-library',
        handler: async (_req: HttpRequest, res: HttpResponse) => {
          try {
            const library = await buildLibraryStatus(dynamic().libraryRoot)
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(library))
          } catch (error) {
            res.writeHead(500, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          }
        },
      })
      const disposeLibraryRefresh = webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-usage-monitor/plugin-library/refresh',
        handler: async (_req: HttpRequest, res: HttpResponse) => {
          if ((_req.method ?? 'GET') !== 'POST') {
            res.writeHead(405, { allow: 'POST' })
            res.end('method not allowed')
            return
          }
          try {
            const library = await refreshLibrary(dynamic().libraryRoot)
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(library))
          } catch (error) {
            res.writeHead(500, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          }
        },
      })
      return () => {
        disposeStatus()
        disposeRefresh()
        disposeLibrary()
        disposeLibraryRefresh()
      }
    }, 'dsh-usage-monitor: status routes')
  }

  ctx.effect(() => () => {
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    flushSave()
  }, 'dsh-usage-monitor: lifecycle')
}
