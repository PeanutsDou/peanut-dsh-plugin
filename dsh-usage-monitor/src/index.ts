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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-usage-monitor'
export const inject = ['settings', 'credentials', 'webServer', 'sessions']

/** Plugin configuration (settings.yaml, editable via the plugin card). */
export interface UsageMonitorConfig {
  balanceUrl: string
  credentialRef: string
  balancePollMs: number
}

export const ConfigSchema: z<UsageMonitorConfig> = z.object({
  balanceUrl: z.string().default('https://api.deepseek.com'),
  credentialRef: z.string().default('DEEPSEEK_API_KEY'),
  balancePollMs: z.number().default(600000),
})

export const DEFAULT_CONFIG: UsageMonitorConfig = {
  balanceUrl: 'https://api.deepseek.com',
  credentialRef: 'DEEPSEEK_API_KEY',
  balancePollMs: 600000,
}

/** Provider-neutral token buckets (same vocabulary as the built-in token meter). */
export interface TokenBuckets {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Provider usage in the same shape as DSH's TokenUsage. */
export interface TokenUsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

interface SessionRow extends TokenBuckets {
  id: string
  label: string
  updatedAt: number
}

export interface LedgerState {
  version: 1
  allTime: TokenBuckets
  days: Record<string, TokenBuckets>
  months: Record<string, TokenBuckets>
  sessions: Record<string, SessionRow>
  /** Last buckets per `sessionId:turn:step`, used for replace-not-add folding. */
  lastStep: Record<string, TokenBuckets>
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

export function zeroBuckets(): TokenBuckets {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

export function bucketsOf(usage: TokenUsageLike): TokenBuckets {
  return {
    uncachedInputTokens: nonNegativeInt(usage.inputTokens),
    outputTokens: nonNegativeInt(usage.outputTokens),
    cacheReadTokens: nonNegativeInt(usage.cacheReadTokens ?? 0),
    cacheWriteTokens: nonNegativeInt(usage.cacheWriteTokens ?? 0),
  }
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Signed bucket delta, clamped at zero so a provider revision can never erase history. */
export function deltaBuckets(next: TokenBuckets, previous?: TokenBuckets): TokenBuckets {
  const base = previous ?? zeroBuckets()
  return {
    uncachedInputTokens: Math.max(0, next.uncachedInputTokens - base.uncachedInputTokens),
    outputTokens: Math.max(0, next.outputTokens - base.outputTokens),
    cacheReadTokens: Math.max(0, next.cacheReadTokens - base.cacheReadTokens),
    cacheWriteTokens: Math.max(0, next.cacheWriteTokens - base.cacheWriteTokens),
  }
}

function addBuckets(target: TokenBuckets, delta: TokenBuckets): TokenBuckets {
  return {
    uncachedInputTokens: target.uncachedInputTokens + delta.uncachedInputTokens,
    outputTokens: target.outputTokens + delta.outputTokens,
    cacheReadTokens: target.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + delta.cacheWriteTokens,
  }
}

function isZero(delta: TokenBuckets): boolean {
  return delta.uncachedInputTokens === 0
    && delta.outputTokens === 0
    && delta.cacheReadTokens === 0
    && delta.cacheWriteTokens === 0
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

function sanitizeBuckets(value: unknown): TokenBuckets {
  const record = (value ?? {}) as Record<string, unknown>
  return {
    uncachedInputTokens: nonNegativeInt(Number(record.uncachedInputTokens)),
    outputTokens: nonNegativeInt(Number(record.outputTokens)),
    cacheReadTokens: nonNegativeInt(Number(record.cacheReadTokens)),
    cacheWriteTokens: nonNegativeInt(Number(record.cacheWriteTokens)),
  }
}

function sanitizeLedger(value: unknown): LedgerState {
  const record = (value ?? {}) as Record<string, unknown>
  const days: Record<string, TokenBuckets> = {}
  const months: Record<string, TokenBuckets> = {}
  const sessions: Record<string, SessionRow> = {}
  const lastStep: Record<string, TokenBuckets> = {}
  for (const [key, raw] of Object.entries((record.days ?? {}) as Record<string, unknown>)) days[key] = sanitizeBuckets(raw)
  for (const [key, raw] of Object.entries((record.months ?? {}) as Record<string, unknown>)) months[key] = sanitizeBuckets(raw)
  for (const [key, raw] of Object.entries((record.sessions ?? {}) as Record<string, unknown>)) {
    const row = (raw ?? {}) as Record<string, unknown>
    sessions[key] = {
      ...sanitizeBuckets(raw),
      id: typeof row.id === 'string' ? row.id : key,
      label: typeof row.label === 'string' ? row.label : key.slice(0, 8),
      updatedAt: Number.isFinite(Number(row.updatedAt)) ? Number(row.updatedAt) : 0,
    }
  }
  for (const [key, raw] of Object.entries((record.lastStep ?? {}) as Record<string, unknown>)) lastStep[key] = sanitizeBuckets(raw)
  return {
    version: 1,
    allTime: sanitizeBuckets(record.allTime),
    days,
    months,
    sessions,
    lastStep,
  }
}

export function emptyLedger(): LedgerState {
  return {
    version: 1,
    allTime: zeroBuckets(),
    days: {},
    months: {},
    sessions: {},
    lastStep: {},
  }
}

export function loadLedger(file = stateFilePath()): LedgerState {
  try {
    return sanitizeLedger(JSON.parse(fs.readFileSync(file, 'utf8')))
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
 * into all-time, local day/month, and per-session rows. Exported for tests.
 */
export function foldUsage(
  ledger: LedgerState,
  sessionId: string,
  label: string,
  turn: number,
  step: number,
  usage: TokenUsageLike,
  at = new Date(),
): LedgerState {
  const next = bucketsOf(usage)
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

  return {
    ...ledger,
    allTime: addBuckets(ledger.allTime, delta),
    days,
    months,
    sessions: { ...ledger.sessions, [sessionId]: sessionRow },
    lastStep: { ...ledger.lastStep, [key]: next },
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
function recentDays(ledger: LedgerState, count: number, now = new Date()): Array<{ date: string; buckets: TokenBuckets }> {
  const out: Array<{ date: string; buckets: TokenBuckets }> = []
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = localDayKey(date)
    out.push({ date: key, buckets: ledger.days[key] ?? zeroBuckets() })
  }
  return out
}

/** Recent calendar months, zero-filled, oldest first. */
function recentMonths(ledger: LedgerState, count: number, now = new Date()): Array<{ month: string; buckets: TokenBuckets }> {
  const out: Array<{ month: string; buckets: TokenBuckets }> = []
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = localMonthKey(date)
    out.push({ month: key, buckets: ledger.months[key] ?? zeroBuckets() })
  }
  return out
}

function topSessions(ledger: LedgerState, count: number): Array<{ id: string; label: string; buckets: TokenBuckets; tokens: number }> {
  return Object.values(ledger.sessions)
    .sort((a, b) => totalTokens(b) - totalTokens(a))
    .slice(0, count)
    .map(row => ({
      id: row.id,
      label: row.label,
      buckets: {
        uncachedInputTokens: row.uncachedInputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
      },
      tokens: totalTokens(row),
    }))
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
  const ledgerFile = stateFilePath()
  let ledger = pruneLastStep(loadLedger(ledgerFile))
  let saveTimer: NodeJS.Timeout | undefined
  let balance: BalanceSnapshot = { ok: false, fetchedAt: 0, error: 'not fetched yet' }
  let balanceInFlight: Promise<BalanceSnapshot> | undefined
  let pollTimer: NodeJS.Timeout | undefined

  const staticConfig: UsageMonitorConfig = { ...DEFAULT_CONFIG, ...(config ?? {}) }
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

  ctx.on('session/event', (rawSession: unknown, rawEvent: unknown) => {
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
    ledger = foldUsage(ledger, sessionId, sessionLabel(rawSession, sessionId), sample.turn, sample.step, sample.usage)
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

  const buildStatus = () => {
    const now = new Date()
    const today = ledger.days[localDayKey(now)] ?? zeroBuckets()
    const month = ledger.months[localMonthKey(now)] ?? zeroBuckets()
    return {
      ok: true,
      generatedAt: now.getTime(),
      balance,
      usage: {
        today,
        month,
        allTime: ledger.allTime,
        todayCacheHitRate: cacheHitRate(today),
        monthCacheHitRate: cacheHitRate(month),
        allTimeCacheHitRate: cacheHitRate(ledger.allTime),
        days: recentDays(ledger, 7, now),
        months: recentMonths(ledger, 12, now),
        topSessions: topSessions(ledger, 5),
      },
    }
  }

  const webServer = ctx.get('webServer') as { register: (route: WebRoute) => () => void } | undefined
  if (webServer !== undefined) {
    ctx.effect(() => {
      const disposeStatus = webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-usage-monitor/status',
        handler: (_req: HttpRequest, res: HttpResponse) => {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(buildStatus()))
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
          res.end(JSON.stringify(buildStatus()))
        },
      })
      return () => {
        disposeStatus()
        disposeRefresh()
      }
    }, 'dsh-usage-monitor: status routes')
  }

  ctx.effect(() => () => {
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    flushSave()
  }, 'dsh-usage-monitor: lifecycle')
}
