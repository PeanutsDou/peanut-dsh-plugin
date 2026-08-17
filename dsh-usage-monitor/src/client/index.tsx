/**
 * dsh-usage-monitor — client half.
 *
 * Registers one entry into the frame-wide `shell.overlay` slot: a bottom
 * status bar (balance / today tokens / cache hit) plus a click-opened floating
 * panel with day/month/all-time details, recent history, and per-session top
 * consumers. A small settings card exposes balance polling knobs.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ClientContext, SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

export const name = 'dsh-usage-monitor-client'
export const inject = ['slots', 'settingsScope']

interface Buckets {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costCny: number
}

interface StatusData {
  ok: boolean
  generatedAt: number
  sysinfo?: {
    memPercent: number
    memTotalGb: number
    cpuPercent: number
    cpuCores: number
    gpu: { utilPercent: number; memUsedMb: number; memTotalMb: number } | null
    at: number
  }
  balance: {
    ok: boolean
    available?: boolean
    currency?: string
    total?: number
    granted?: number
    toppedUp?: number
    fetchedAt: number
    error?: string
  }
  usage: {
    today: Buckets
    month: Buckets
    allTime: Buckets
    todayCost: number
    weekCost: number
    monthCost: number
    allTimeCost: number
    todayCacheHitRate: number | null
    monthCacheHitRate: number | null
    allTimeCacheHitRate: number | null
    days: Array<{ date: string; buckets: Buckets; byModel?: Record<string, Buckets> }>
    months: Array<{ month: string; buckets: Buckets; byModel?: Record<string, Buckets> }>
    models: string[]
    modelCosts: Record<string, Buckets>
  }
}

interface SettingsSnapshot {
  available: boolean
  writable: boolean
  balanceUrl: string
  credentialRef: string
  balancePollMinutes: number
}

const zero: Buckets = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costCny: 0 }

function ensureStyles(): void {
  const id = 'dsh-usage-monitor-styles'
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = `
.dsh-usage-dock{position:fixed;z-index:1200;display:flex;flex-direction:column;align-items:flex-end;pointer-events:none}
.dsh-usage-bar{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;max-width:min(92vw,640px);padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 92%,transparent);color:var(--dsw-alias-label-primary);font:12px/1.5 system-ui;box-shadow:0 8px 30px rgba(0,0,0,.18);cursor:grab;pointer-events:auto;touch-action:none;backdrop-filter:blur(8px);user-select:none}
.dsh-usage-bar-row{display:flex;align-items:center;gap:10px;min-width:0;white-space:nowrap}
.dsh-usage-bar-sys{display:flex;justify-content:center;gap:12px;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dsh-usage-bar.dragging{cursor:grabbing;border-color:var(--dsw-alias-brand-primary)}
.dsh-usage-bar:hover{border-color:var(--dsw-alias-label-dimmed)}
.dsh-usage-bar:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-usage-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-success,#22c55e);flex:none}
.dsh-usage-dot.err{background:var(--dsw-alias-label-error,#ef4444)}
.dsh-usage-bar-parts{display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap}
.dsh-usage-panel{position:absolute;z-index:1200;width:min(92vw,460px);max-height:min(72vh,560px);overflow:auto;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 20px 60px rgba(0,0,0,.28);font:13px/1.6 system-ui;pointer-events:auto}
.dsh-usage-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 12px;font-size:14px;font-weight:600}
.dsh-usage-refresh{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:3px 10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.dsh-usage-refresh:hover{border-color:var(--dsw-alias-label-dimmed)}
.dsh-usage-section{margin:14px 0 0;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-usage-section h3{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:none}
.dsh-usage-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.dsh-usage-cell{min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3)}
.dsh-usage-k{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-usage-v{display:block;font-size:13px;font-weight:600}
.dsh-usage-table{width:100%;border-collapse:collapse;font-size:12px}
.dsh-usage-table th,.dsh-usage-table td{padding:4px 6px;text-align:right;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-usage-table th:first-child,.dsh-usage-table td:first-child{text-align:left}
.dsh-usage-table th{color:var(--dsw-alias-label-tertiary);font-weight:500}
.dsh-usage-chart{margin-top:2px}
.dsh-usage-chart-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-bottom:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-usage-chart-legend>span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.dsh-usage-chart-legend>span.total{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-usage-swatch{width:9px;height:9px;border-radius:50%;flex:none}
.dsh-usage-chart-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;font-size:12px;color:var(--dsw-alias-label-primary)}
.dsh-usage-metric{display:flex;gap:4px}
.dsh-usage-metric button{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;background:transparent;color:var(--dsw-alias-label-tertiary);font:12px/1.6 system-ui;cursor:pointer}
.dsh-usage-metric button.active{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:var(--dsw-alias-brand-primary,#3b82f6);color:#fff}
.dsh-usage-chart-box{position:relative;height:140px}
.dsh-usage-chart-box svg{display:block;width:100%;height:100%}
.dsh-usage-chart-tip{position:absolute;z-index:2;transform:translate(-50%,-115%);padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;line-height:1.5;white-space:nowrap;pointer-events:none;box-shadow:0 6px 18px rgba(0,0,0,.16)}
.dsh-usage-err{margin:0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-error,#ef4444) 14%,transparent);color:var(--dsw-alias-label-error,#ef4444)}
.dsh-usage-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}
.dsh-usage-card button{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;padding:14px 16px}
.dsh-usage-card-body{padding:0 16px 12px;display:flex;flex-direction:column;gap:10px}
.dsh-usage-field{display:flex;flex-direction:column;gap:6px}
.dsh-usage-field span{font-size:13px;font-weight:500}
.dsh-usage-field input{height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dsh-usage-field input:disabled{opacity:.5}
.dsh-usage-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
@media(max-width:520px){.dsh-usage-grid{grid-template-columns:repeat(2,1fr)}}
`
  document.head.append(style)
}

function tokens(bucket: Buckets): number {
  return bucket.uncachedInputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
}

function billedInput(bucket: Buckets): number {
  return bucket.uncachedInputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
}

function fmtTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 10000) return String(Math.round(value))
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function fmtMoney(value: number | undefined, currency: string | undefined): string {
  if (value === undefined) return '—'
  const symbol = currency === 'USD' ? '$' : '¥'
  return `${symbol}${value.toFixed(2)}`
}

function fmtCost(value: number | undefined): string {
  if (!Number.isFinite(value) || value === undefined) return '¥0.00'
  if (value < 0.01 && value > 0) return '<¥0.01'
  return `¥${value.toFixed(2)}`
}

function fmtPercent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

function fmtTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="dsh-usage-cell">
      <span className="dsh-usage-k">{label}</span>
      <span className="dsh-usage-v">{value}</span>
    </div>
  )
}

interface ChartRow {
  key: string
  costCny: number
  totalTokens: number
  byModel?: Record<string, Buckets>
}

/** Stable per-model line colors (indexed by the model list order). */
const PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6']

function LineChart({ title, rows, models }: { title: string; rows: ChartRow[]; models: string[] }) {
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost')
  const [hover, setHover] = useState<number | null>(null)

  const pick = (row: ChartRow, model: string | undefined): number => {
    if (model === undefined) return metric === 'cost' ? row.costCny : row.totalTokens
    const bucket = row.byModel?.[model]
    if (bucket === undefined) return 0
    return metric === 'cost' ? bucket.costCny : tokens(bucket)
  }

  const totalValues = rows.map(row => pick(row, undefined))
  const series = [
    { label: '总价', color: 'var(--dsw-alias-brand-primary,#3b82f6)', values: totalValues, total: true },
    ...models.map((model, index) => ({
      label: model,
      color: PALETTE[index % PALETTE.length],
      values: rows.map(row => pick(row, model)),
      total: false,
    })),
  ]
  const max = Math.max(1, ...series.flatMap(item => item.values))
  const width = 600
  const height = 150
  const padX = 8
  const padY = 10
  const step = rows.length > 1 ? (width - padX * 2) / (rows.length - 1) : 0
  const points = rows.map((row, index) => ({
    x: rows.length > 1 ? padX + index * step : width / 2,
    y: height - padY - (totalValues[index] ?? 0) / max * (height - padY * 2),
    row,
    value: totalValues[index] ?? 0,
  }))

  const onMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
    const index = Math.max(0, Math.min(rows.length - 1, Math.round(ratio * (rows.length - 1))))
    setHover(index)
  }

  const hovered = hover === null ? undefined : points[hover]
  const totalPolyline = points.map(point => `${point.x},${point.y}`).join(' ')
  const area = points.length > 0
    ? `${padX},${height - padY} ${totalPolyline} ${points[points.length - 1]?.x ?? padX},${height - padY}`
    : ''
  const lineOf = (values: number[]): string => values
    .map((value, index) => {
      const x = rows.length > 1 ? padX + index * step : width / 2
      const y = height - padY - value / max * (height - padY * 2)
      return `${x},${y}`
    })
    .join(' ')

  return (
    <div className="dsh-usage-chart">
      <div className="dsh-usage-chart-head">
        <span>{title}</span>
        <div className="dsh-usage-metric">
          <button type="button" className={metric === 'cost' ? 'active' : ''} onClick={() => { setMetric('cost') }}>花费</button>
          <button type="button" className={metric === 'tokens' ? 'active' : ''} onClick={() => { setMetric('tokens') }}>Token</button>
        </div>
      </div>
      <div className="dsh-usage-chart-legend">
        {series.map(item => (
          <span key={item.label} className={item.total ? 'total' : ''}>
            <span className="dsh-usage-swatch" style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
      <div className="dsh-usage-chart-box" onMouseMove={onMove} onMouseLeave={() => { setHover(null) }}>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label={`${title}折线图`}>
          <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} stroke="var(--dsw-alias-border-l2)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <polygon points={area} fill="color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 12%,transparent)" />
          {series.map(item => (
            <polyline
              key={item.label}
              points={lineOf(item.values)}
              fill="none"
              stroke={item.color}
              strokeWidth={item.total ? 2.5 : 1.5}
              strokeDasharray={item.total ? undefined : '4 3'}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              opacity={item.total ? 1 : 0.9}
            />
          ))}
          {hovered !== undefined ? (
            <g>
              <line x1={hovered.x} y1={padY} x2={hovered.x} y2={height - padY} stroke="var(--dsw-alias-label-dimmed)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <circle cx={hovered.x} cy={hovered.y} r="4" fill="var(--dsw-alias-brand-primary,#3b82f6)" stroke="var(--dsw-alias-bg-layer-2)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </g>
          ) : null}
        </svg>
        {hovered !== undefined ? (
          <div className="dsh-usage-chart-tip" style={{ left: `${hovered.x / width * 100}%`, top: `${hovered.y / height * 100}%` }}>
            <div>{hovered.row.key}</div>
            {series.map(item => (
              <div key={item.label} style={{ color: item.label === '总价' ? undefined : item.color }}>
                {item.label}: {metric === 'cost' ? fmtCost(item.values[hover as number]) : `${fmtTokens(item.values[hover as number] ?? 0)} tokens`}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function DetailPanel({ status, loading, onClose, onRefresh, anchorLeft, openUp }: {
  status: StatusData | null
  loading: boolean
  onClose: () => void
  onRefresh: () => void
  anchorLeft: boolean
  openUp: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (ref.current !== null && event.target instanceof Node && !ref.current.contains(event.target)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const balance = status?.balance
  const usage = status?.usage

  return (
    <div
      className="dsh-usage-panel"
      ref={ref}
      role="dialog"
      aria-label="DSH 用量与余额"
      style={{
        ...(openUp
          ? { top: 'auto', bottom: 'calc(100% + 10px)' }
          : { top: 'calc(100% + 10px)', bottom: 'auto' }),
        ...(anchorLeft ? { left: 0, right: 'auto' } : { left: 'auto', right: 0 }),
      }}
    >
      <h2 className="dsh-usage-title">
        <span>API 用量与余额</span>
        <button type="button" className="dsh-usage-refresh" disabled={loading} onClick={onRefresh}>
          {loading ? '刷新中…' : '刷新余额'}
        </button>
      </h2>

      {balance?.ok === false ? <p className="dsh-usage-err">余额：{balance.error ?? '查询失败'}（{fmtTime(balance.fetchedAt)}）</p> : null}
      {balance?.ok === true ? (
        <div className="dsh-usage-grid">
          <Stat label="余额" value={fmtMoney(balance.total, balance.currency)} />
          <Stat label="充值" value={fmtMoney(balance.toppedUp, balance.currency)} />
          <Stat label="赠送" value={fmtMoney(balance.granted, balance.currency)} />
        </div>
      ) : null}

      <section className="dsh-usage-section">
        <h3>花费（按官方价估算）</h3>
        <div className="dsh-usage-grid">
          <Stat label="今日" value={usage ? fmtCost(usage.todayCost) : '—'} />
          <Stat label="本周" value={usage ? fmtCost(usage.weekCost) : '—'} />
          <Stat label="本月" value={usage ? fmtCost(usage.monthCost) : '—'} />
          <Stat label="累计" value={usage ? fmtCost(usage.allTimeCost) : '—'} />
        </div>
      </section>

      <section className="dsh-usage-section">
        <h3>今日 Token</h3>
        <div className="dsh-usage-grid">
          <Stat label="输入(计费)" value={usage ? fmtTokens(billedInput(usage.today)) : '—'} />
          <Stat label="输出" value={usage ? fmtTokens(usage.today.outputTokens) : '—'} />
          <Stat label="缓存命中" value={usage ? fmtPercent(usage.todayCacheHitRate) : '—'} />
        </div>
      </section>

      <section className="dsh-usage-section">
        <h3>本月 / 累计 Token</h3>
        <div className="dsh-usage-grid">
          <Stat label="本月输入" value={usage ? fmtTokens(billedInput(usage.month)) : '—'} />
          <Stat label="本月输出" value={usage ? fmtTokens(usage.month.outputTokens) : '—'} />
          <Stat label="本月缓存" value={usage ? fmtPercent(usage.monthCacheHitRate) : '—'} />
          <Stat label="累计输入" value={usage ? fmtTokens(billedInput(usage.allTime)) : '—'} />
          <Stat label="累计输出" value={usage ? fmtTokens(usage.allTime.outputTokens) : '—'} />
          <Stat label="累计缓存" value={usage ? fmtPercent(usage.allTimeCacheHitRate) : '—'} />
        </div>
      </section>

      <section className="dsh-usage-section">
        <h3>各模型累计花费</h3>
        <div className="dsh-usage-grid" style={{ gridTemplateColumns: 'repeat(2,1fr)' }}>
          {usage && usage.models.length > 0
            ? usage.models.map((model, index) => {
              const buckets = usage.modelCosts[model]
              return (
                <div className="dsh-usage-cell" key={model}>
                  <span className="dsh-usage-k" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="dsh-usage-swatch" style={{ background: PALETTE[index % PALETTE.length] }} />
                    {model}
                  </span>
                  <span className="dsh-usage-v">{fmtCost(buckets?.costCny)}</span>
                </div>
              )
            })
            : <span className="dsh-usage-hint">暂无数据</span>}
        </div>
      </section>

      {usage && usage.days.length > 0 ? (
        <section className="dsh-usage-section">
          <LineChart
            title="最近 7 天"
            models={usage.models}
            rows={usage.days.map(day => ({
              key: day.date,
              costCny: day.buckets.costCny,
              totalTokens: tokens(day.buckets),
              byModel: day.byModel,
            }))}
          />
        </section>
      ) : null}

      {usage && usage.months.length > 0 ? (
        <section className="dsh-usage-section">
          <LineChart
            title="最近 12 个月"
            models={usage.models}
            rows={usage.months.map(month => ({
              key: month.month,
              costCny: month.buckets.costCny,
              totalTokens: tokens(month.buckets),
              byModel: month.byModel,
            }))}
          />
        </section>
      ) : null}
    </div>
  )
}

interface DockPosition {
  right: number
  bottom: number
}

const POSITION_KEY = 'dsh-usage-monitor-position'
const DEFAULT_POSITION: DockPosition = { right: 16, bottom: 12 }
const EDGE_GAP = 8

function readPosition(): DockPosition {
  try {
    const raw = localStorage.getItem(POSITION_KEY)
    if (raw === null) return { ...DEFAULT_POSITION }
    const parsed = JSON.parse(raw) as Partial<DockPosition>
    if (Number.isFinite(parsed.right) && Number.isFinite(parsed.bottom)
      && Number(parsed.right) >= 0 && Number(parsed.bottom) >= 0) {
      return { right: Number(parsed.right), bottom: Number(parsed.bottom) }
    }
  } catch { /* corrupted or storage unavailable */ }
  return { ...DEFAULT_POSITION }
}

function persistPosition(position: DockPosition): void {
  try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)) } catch { /* storage unavailable */ }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function clampPosition(position: DockPosition, width: number, height: number): DockPosition {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  return {
    right: clampNumber(position.right, 0, Math.max(0, viewportWidth - width - EDGE_GAP)),
    bottom: clampNumber(position.bottom, 0, Math.max(0, viewportHeight - height - EDGE_GAP)),
  }
}

function UsageMonitor(): JSX.Element {
  const [status, setStatus] = useState<StatusData | null>(null)
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [position, setPosition] = useState<DockPosition>(() => readPosition())
  const barRef = useRef<HTMLButtonElement | null>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: DockPosition } | null>(null)
  const movedRef = useRef(false)
  const latestRef = useRef(position)
  latestRef.current = position

  const barSize = useCallback(() => ({
    width: barRef.current?.offsetWidth ?? 640,
    height: barRef.current?.offsetHeight ?? 34,
  }), [])

  useLayoutEffect(() => {
    const size = barSize()
    setPosition(current => clampPosition(current, size.width, size.height))
  }, [barSize])

  useEffect(() => {
    const onResize = () => {
      const size = barSize()
      setPosition(current => clampPosition(current, size.width, size.height))
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [barSize])

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    const load = async () => {
      try {
        const response = await fetch('/plugins/dsh-usage-monitor/status', { cache: 'no-store', signal: controller.signal })
        if (!response.ok) return
        const data = await response.json() as StatusData
        if (!disposed) setStatus(data)
      } catch {
        /* transient network / restart — keep last snapshot */
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, open ? 3000 : 5000)
    return () => {
      disposed = true
      controller.abort()
      clearInterval(timer)
    }
  }, [open])

  const refreshBalance = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const response = await fetch('/plugins/dsh-usage-monitor/refresh-balance', {
        method: 'POST',
        cache: 'no-store',
      })
      if (response.ok) {
        const data = await response.json() as StatusData
        setStatus(data)
      }
    } catch {
      /* keep current */
    } finally {
      setRefreshing(false)
    }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: latestRef.current,
    }
    movedRef.current = false
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true
    const size = barSize()
    const next = clampPosition({
      right: drag.origin.right - dx,
      bottom: drag.origin.bottom - dy,
    }, size.width, size.height)
    latestRef.current = next
    setPosition(next)
  }

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    persistPosition(latestRef.current)
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
  }

  const usage = status?.usage
  const balance = status?.balance
  const balanceText = balance?.ok === true
    ? fmtMoney(balance.total, balance.currency)
    : '余额 —'
  const todayText = usage ? `今日 ${fmtTokens(billedInput(usage.today))} in / ${fmtTokens(usage.today.outputTokens)} out` : '用量加载中'
  const todayCostText = usage ? `今日花费 ${fmtCost(usage.todayCost)}` : ''
  const sysinfo = status?.sysinfo
  const sysText = sysinfo === undefined
    ? ''
    : [
      `内存 ${Math.round(sysinfo.memPercent)}%/${sysinfo.memTotalGb}G`,
      `CPU ${Math.round(sysinfo.cpuPercent)}%/${sysinfo.cpuCores}核`,
      sysinfo.gpu === null
        ? null
        : `GPU ${Math.round(sysinfo.gpu.utilPercent)}%/${(sysinfo.gpu.memTotalMb / 1024).toFixed(0)}G`,
    ].filter((part): part is string => part !== null).join(' · ')

  const rect = barRef.current?.getBoundingClientRect()
  const anchorLeft = rect === undefined ? false : rect.left + rect.width / 2 < window.innerWidth / 2
  const openUp = position.bottom < window.innerHeight / 2

  return (
    <div className="dsh-usage-dock" style={{ right: position.right, bottom: position.bottom }}>
      {open ? (
        <DetailPanel
          status={status}
          loading={refreshing}
          onClose={() => { setOpen(false) }}
          onRefresh={() => { void refreshBalance() }}
          anchorLeft={anchorLeft}
          openUp={openUp}
        />
      ) : null}
      <button
        ref={barRef}
        type="button"
        className={`dsh-usage-bar${dragging ? ' dragging' : ''}`}
        aria-expanded={open}
        aria-label="DSH API 用量与余额（可拖动）"
        title="拖动可改变位置，点击查看详情"
        onMouseDown={event => { event.stopPropagation() }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={() => {
          if (movedRef.current) {
            movedRef.current = false
            return
          }
          setOpen(current => !current)
        }}
      >
        <span className="dsh-usage-bar-row">
          <span className={balance?.ok === false ? 'dsh-usage-dot err' : 'dsh-usage-dot'} />
          <span className="dsh-usage-bar-parts">{balanceText}</span>
          {todayCostText ? <span className="dsh-usage-bar-parts">{todayCostText}</span> : null}
          <span className="dsh-usage-bar-parts">{todayText}</span>
        </span>
        {sysText ? <span className="dsh-usage-bar-sys">{sysText}</span> : null}
      </button>
    </div>
  )
}

function UsageSettingsCard(props: {
  useUsageMonitor: <R>(selector: (snapshot: SettingsSnapshot) => R) => R
  set: (field: string, value: unknown) => void
  clear: (field: string) => void
}) {
  const [open, setOpen] = useState(false)
  const state = props.useUsageMonitor(snapshot => snapshot)
  if (!state.available) return null
  const disabled = !state.writable
  const text = (field: string, value: string): void => {
    const trimmed = value.trim()
    if (trimmed === '') props.clear(field)
    else props.set(field, trimmed)
  }
  const minutes = (field: string, value: string): void => {
    if (value.trim() === '') { props.clear(field); return }
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) props.set(field, Math.round(parsed * 60000))
  }

  return (
    <li className="dsh-usage-card">
      <button type="button" aria-expanded={open} onClick={() => { setOpen(!open) }}>
        <span style={{ fontWeight: 600 }}>API 用量监控</span>
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
          底部状态栏、余额轮询与 token 日/月记账配置
        </div>
      </button>
      {open ? (
        <div className="dsh-usage-card-body">
          <label className="dsh-usage-field">
            <span>余额 API 地址</span>
            <input type="text" value={state.balanceUrl} disabled={disabled} onChange={event => { text('balanceUrl', event.currentTarget.value) }} />
            <p className="dsh-usage-hint">官方 DeepSeek 默认 https://api.deepseek.com，自定义网关按需修改。</p>
          </label>
          <label className="dsh-usage-field">
            <span>凭证引用</span>
            <input type="text" value={state.credentialRef} disabled={disabled} onChange={event => { text('credentialRef', event.currentTarget.value) }} />
            <p className="dsh-usage-hint">从 DSH credentials 服务解析的环境变量名，默认 DEEPSEEK_API_KEY。</p>
          </label>
          <label className="dsh-usage-field">
            <span>余额轮询间隔（分钟）</span>
            <input type="number" min="1" value={state.balancePollMinutes || ''} disabled={disabled} onChange={event => { minutes('balancePollMs', event.currentTarget.value) }} />
            <p className="dsh-usage-hint">默认 10 分钟；不建议低于 1 分钟。</p>
          </label>
          {!state.writable ? <p className="dsh-usage-hint">当前设置只读。</p> : null}
        </div>
      ) : null}
    </li>
  )
}

export function apply(ctx: ClientContext): void {
  ensureStyles()

  ctx.effect(() => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-usage-monitor-status',
  }, UsageMonitor), 'dsh-usage-monitor: overlay status bar')

  try {
    const scope = ctx.settingsScope.bind({ namespace: 'dsh-usage-monitor' }) as SettingsScope<unknown>
    const project = (): SettingsSnapshot => {
      const snap = scope.getSnapshot()
      const value = (snap.value ?? {}) as Record<string, unknown>
      return {
        available: snap.status === 'ready',
        writable: snap.writable,
        balanceUrl: typeof value.balanceUrl === 'string' ? value.balanceUrl : '',
        credentialRef: typeof value.credentialRef === 'string' ? value.credentialRef : '',
        balancePollMinutes: typeof value.balancePollMs === 'number' ? Math.max(1, Math.round(value.balancePollMs / 60000)) : 10,
      }
    }
    const store: SnapshotStore<SettingsSnapshot> = createSnapshotStore(project())
    scope.subscribe(() => { store.set(project()) })
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'dsh-usage-monitor',
      order: 50,
      inject: () => ({
        hooks: { usageMonitor: store },
        set: (field: string, value: unknown) => { void scope.set(field, value) },
        clear: (field: string) => { void scope.unset(field) },
      }),
    }, UsageSettingsCard))
  } catch (error) {
    console.error('[dsh-usage-monitor] settings card unavailable:', error)
  }
}
