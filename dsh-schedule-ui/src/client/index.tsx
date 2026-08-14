/**
 * Schedule task manager, browser half: a third conversation view tab (beside
 * Chat and Trajectory) that lists, creates, edits, pauses, resumes, and deletes
 * this session's scheduled tasks — one-shot (`after` / `at`) and calendar
 * recurring (`daily` / `weekly` / `monthly` / `yearly`).
 */
import React, { useCallback, useEffect, useState } from 'react'

export const inject = ['slots']

interface Selector {
  afterSeconds?: number
  at?: string
}

interface Recurrence {
  kind: 'daily' | 'weekly' | 'monthly' | 'yearly'
  time: string
  days?: number[]
  day?: number
  month?: number
}

interface Task {
  taskId: string
  prompt: string
  mode: 'once' | 'recurring'
  selector?: Selector
  recurrence?: Recurrence
  maxRuns?: number
  runCount: number
  timezone: string
  skipWeekends?: boolean
  excludeDates?: string[]
  status: 'active' | 'paused' | 'done'
  scheduledAt?: string
  state?: 'scheduled' | 'overdue'
  createdAt: number
}

interface CreateInput {
  prompt: string
  mode: 'once' | 'recurring'
  selector?: Selector
  recurrence?: Recurrence
  maxRuns?: number
  timezone: string
  skipWeekends?: boolean
  excludeDates?: string[]
}

type ListOutcome = { ok: true; items: Task[] } | { ok: false; message: string }
type MutationOutcome = { ok: true; item?: Task } | { ok: false; message: string }

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await response.json()) as T
}

const WEEKDAYS = [
  [1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'], [5, '周五'], [6, '周六'], [7, '周日'],
] as const

function selectorLabel(selector: Selector): string {
  if (selector.afterSeconds !== undefined) return `延时 ${selector.afterSeconds} 秒`
  if (selector.at !== undefined) return `绝对时间 ${selector.at}`
  return '未设置'
}

function recurrenceLabel(recurrence: Recurrence): string {
  if (recurrence.kind === 'daily') return `每天 ${recurrence.time}`
  if (recurrence.kind === 'weekly') {
    const names = (recurrence.days ?? []).map((d) => WEEKDAYS.find((w) => w[0] === d)?.[1] ?? d).join('、')
    return `每周 ${names} ${recurrence.time}`
  }
  if (recurrence.kind === 'monthly') return `每月 ${recurrence.day} 号 ${recurrence.time}`
  return `每年 ${recurrence.month} 月 ${recurrence.day} 日 ${recurrence.time}`
}

function runLabel(task: Task): string {
  if (task.mode === 'once') return '一次性'
  const runs = task.maxRuns !== undefined ? ` / ${task.maxRuns} 次` : ''
  return `循环 · 已触发 ${task.runCount}${runs}`
}

function timeLabel(scheduledAt: string): string {
  const value = new Date(scheduledAt)
  return Number.isNaN(value.getTime()) ? scheduledAt : value.toLocaleString()
}

const STATUS_LABEL: Record<Task['status'], string> = {
  active: '运行中',
  paused: '已暂停',
  done: '已完成',
}

const CSS = [
  '.dsu-root{padding:16px;max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary)}',
  '.dsu-title{margin:0;font-size:1rem}',
  '.dsu-muted{color:var(--dsw-alias-label-secondary);margin:0}',
  '.dsu-error{color:var(--dsw-alias-state-error-primary);margin:0}',
  '.dsu-section-title{font-size:.85rem;color:var(--dsw-alias-label-secondary);margin:12px 0 4px}',
  '.dsu-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
  '.dsu-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:6px}',
  '.dsu-card-head{display:flex;align-items:baseline;gap:8px}',
  '.dsu-prompt{flex:1;font-weight:500;overflow-wrap:anywhere}',
  '.dsu-badge{font-size:.75em;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
  '.dsu-badge-active{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
  '.dsu-badge-paused{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
  '.dsu-meta{font-size:.82em;color:var(--dsw-alias-label-secondary)}',
  '.dsu-actions{display:flex;gap:6px;flex-wrap:wrap}',
  '.dsu-btn{padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:.82em}',
  '.dsu-btn:hover{border-color:var(--dsw-alias-border-l2)}',
  '.dsu-btn-danger{color:var(--dsw-alias-state-error-primary)}',
  '.dsu-form{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1)}',
  '.dsu-field{display:flex;flex-direction:column;gap:2px;font-size:.85em;color:var(--dsw-alias-label-secondary)}',
  '.dsu-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
  '.dsu-input{padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}',
  '.dsu-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
  '.dsu-select{padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}',
  '.dsu-check{display:inline-flex;align-items:center;gap:4px;font-size:.85em;color:var(--dsw-alias-label-primary)}',
  '.dsu-submit{padding:6px 10px;border:none;border-radius:6px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);cursor:pointer;font:inherit}',
  '.dsu-submit:disabled{opacity:.5;cursor:not-allowed}',
  '.dsu-hint{font-size:.78em;color:var(--dsw-alias-label-secondary);margin:0}',
].join('\n')

interface FormProps {
  initial?: Task
  submitLabel: string
  onSubmit: (input: CreateInput) => Promise<void>
  onCancel?: () => void
}

function TaskForm({ initial, submitLabel, onSubmit, onCancel }: FormProps) {
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [mode, setMode] = useState<'once' | 'recurring'>(initial?.mode ?? 'once')
  const [onceKind, setOnceKind] = useState<'after' | 'at'>(
    initial?.selector?.afterSeconds !== undefined ? 'after' : 'at',
  )
  const [afterSeconds, setAfterSeconds] = useState(initial?.selector?.afterSeconds?.toString() ?? '')
  const [at, setAt] = useState(initial?.selector?.at ?? '')
  const [recurKind, setRecurKind] = useState<Recurrence['kind']>(initial?.recurrence?.kind ?? 'daily')
  const [time, setTime] = useState(initial?.recurrence?.time ?? '09:00')
  const [weekDays, setWeekDays] = useState<number[]>(initial?.recurrence?.days ?? [1, 2, 3, 4, 5])
  const [monthDay, setMonthDay] = useState(initial?.recurrence?.day?.toString() ?? '1')
  const [yearMonth, setYearMonth] = useState(initial?.recurrence?.month?.toString() ?? '1')
  const [yearDay, setYearDay] = useState(initial?.recurrence?.day?.toString() ?? '1')
  const [skipWeekends, setSkipWeekends] = useState(initial?.skipWeekends ?? false)
  const [excludeDates, setExcludeDates] = useState((initial?.excludeDates ?? []).join(', '))
  const [maxRuns, setMaxRuns] = useState(initial?.maxRuns?.toString() ?? '')

  const toggleWeekday = (day: number): void => {
    setWeekDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()))
  }

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const input: CreateInput = {
      prompt,
      mode,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
    if (mode === 'once') {
      const selector: Selector = {}
      if (onceKind === 'after' && afterSeconds !== '') selector.afterSeconds = Number(afterSeconds)
      if (onceKind === 'at' && at !== '') selector.at = at
      input.selector = selector
    } else {
      const recurrence: Recurrence = { kind: recurKind, time }
      if (recurKind === 'weekly') recurrence.days = weekDays
      if (recurKind === 'monthly') recurrence.day = Number(monthDay)
      if (recurKind === 'yearly') {
        recurrence.month = Number(yearMonth)
        recurrence.day = Number(yearDay)
      }
      input.recurrence = recurrence
      if (maxRuns !== '') input.maxRuns = Number(maxRuns)
      input.skipWeekends = skipWeekends
      const dates = excludeDates.split(',').map((s) => s.trim()).filter((s) => s !== '')
      if (dates.length > 0) input.excludeDates = dates
    }
    await onSubmit(input)
  }

  return (
    <form className="dsu-form" onSubmit={(event) => { void submit(event) }}>
      <label className="dsu-field">
        提醒内容
        <input className="dsu-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="到点后要提醒的内容" />
      </label>

      <div className="dsu-row">
        <label className="dsu-field">
          类型
          <select className="dsu-select" value={mode} onChange={(event) => setMode(event.target.value as 'once' | 'recurring')}>
            <option value="once">一次性</option>
            <option value="recurring">循环</option>
          </select>
        </label>
      </div>

      {mode === 'once' ? (
        <>
          <div className="dsu-row">
            <label className="dsu-field">
              触发方式
              <select className="dsu-select" value={onceKind} onChange={(event) => setOnceKind(event.target.value as 'after' | 'at')}>
                <option value="after">延时（秒）</option>
                <option value="at">绝对时间</option>
              </select>
            </label>
            {onceKind === 'after' ? (
              <label className="dsu-field">
                延时（秒）
                <input className="dsu-input" type="number" value={afterSeconds} onChange={(event) => setAfterSeconds(event.target.value)} placeholder="例如 3600" />
              </label>
            ) : (
              <label className="dsu-field">
                绝对时间（RFC 3339）
                <input className="dsu-input" value={at} onChange={(event) => setAt(event.target.value)} placeholder="2026-08-14T20:00:00+08:00" />
              </label>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="dsu-row">
            <label className="dsu-field">
              频率
              <select className="dsu-select" value={recurKind} onChange={(event) => setRecurKind(event.target.value as Recurrence['kind'])}>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
                <option value="yearly">每年</option>
              </select>
            </label>
            <label className="dsu-field">
              时刻
              <input className="dsu-input" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
            </label>
          </div>

          {recurKind === 'weekly' ? (
            <div className="dsu-row">
              {WEEKDAYS.map(([value, label]) => (
                <label key={value} className="dsu-check">
                  <input type="checkbox" checked={weekDays.includes(value)} onChange={() => toggleWeekday(value)} />
                  {label}
                </label>
              ))}
            </div>
          ) : null}

          {recurKind === 'monthly' ? (
            <label className="dsu-field">
              几号（1–31）
              <input className="dsu-input" type="number" min={1} max={31} value={monthDay} onChange={(event) => setMonthDay(event.target.value)} />
            </label>
          ) : null}

          {recurKind === 'yearly' ? (
            <div className="dsu-row">
              <label className="dsu-field">
                月（1–12）
                <input className="dsu-input" type="number" min={1} max={12} value={yearMonth} onChange={(event) => setYearMonth(event.target.value)} />
              </label>
              <label className="dsu-field">
                日（1–31）
                <input className="dsu-input" type="number" min={1} max={31} value={yearDay} onChange={(event) => setYearDay(event.target.value)} />
              </label>
            </div>
          ) : null}

          <div className="dsu-row">
            <label className="dsu-check">
              <input type="checkbox" checked={skipWeekends} onChange={(event) => setSkipWeekends(event.target.checked)} />
              跳过周末（周六日）
            </label>
            <label className="dsu-field" style={{ flex: 1 }}>
              排除日期（逗号分隔，YYYY-MM-DD）
              <input className="dsu-input" value={excludeDates} onChange={(event) => setExcludeDates(event.target.value)} placeholder="2026-10-01, 2026-10-02" />
            </label>
          </div>

          <label className="dsu-field">
            触发次数（留空 = 无限）
            <input className="dsu-input" type="number" min={1} value={maxRuns} onChange={(event) => setMaxRuns(event.target.value)} placeholder="例如 5" />
          </label>
        </>
      )}

      <p className="dsu-hint">时区按本机（{Intl.DateTimeFormat().resolvedOptions().timeZone}）计算。</p>

      <div className="dsu-actions">
        <button type="submit" className="dsu-submit" disabled={prompt.trim().length === 0}>{submitLabel}</button>
        {onCancel !== undefined ? <button type="button" className="dsu-btn" onClick={onCancel}>取消</button> : null}
      </div>
    </form>
  )
}

interface SchedulePanelProps {
  readonly sessionId: string
}

function SchedulePanel({ sessionId }: SchedulePanelProps) {
  const [items, setItems] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [editingId, setEditingId] = useState<string | undefined>()

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    const outcome = await post<ListOutcome>('/schedule/tasks', { sessionId })
    if (outcome.ok) setItems(outcome.items)
    else setError(outcome.message)
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const mutate = async (fn: () => Promise<MutationOutcome>): Promise<void> => {
    const outcome = await fn()
    if (outcome.ok) await refresh()
    else setError(outcome.message)
  }

  const onCreate = async (input: CreateInput): Promise<void> => {
    await mutate(() => post<MutationOutcome>('/schedule/create', { sessionId, ...input }))
  }

  const onEdit = async (input: CreateInput): Promise<void> => {
    if (editingId === undefined) return
    await mutate(() => post<MutationOutcome>('/schedule/edit', { sessionId, taskId: editingId, ...input }))
    setEditingId(undefined)
  }

  const onToggle = (task: Task): void => {
    const path = task.status === 'active' ? '/schedule/pause' : '/schedule/resume'
    void mutate(() => post<MutationOutcome>(path, { sessionId, taskId: task.taskId }))
  }

  const onDelete = (task: Task): void => {
    void mutate(() => post<MutationOutcome>('/schedule/delete', { sessionId, taskId: task.taskId }))
  }

  const byStatus = (status: Task['status']): Task[] => items.filter((item) => item.status === status)

  const renderCard = (task: Task): React.ReactNode => {
    if (editingId === task.taskId) {
      return (
        <TaskForm
          key={task.taskId}
          initial={task}
          submitLabel="保存"
          onSubmit={onEdit}
          onCancel={() => setEditingId(undefined)}
        />
      )
    }
    const schedule = task.mode === 'recurring' && task.recurrence !== undefined ? recurrenceLabel(task.recurrence) : selectorLabel(task.selector ?? {})
    const extras: string[] = []
    if (task.skipWeekends === true) extras.push('跳过周末')
    if ((task.excludeDates ?? []).length > 0) extras.push(`排除 ${task.excludeDates?.join(', ')}`)
    return (
      <li key={task.taskId} className="dsu-card">
        <div className="dsu-card-head">
          <span className="dsu-prompt">{task.prompt}</span>
          <span className={`dsu-badge ${task.status === 'active' ? 'dsu-badge-active' : task.status === 'paused' ? 'dsu-badge-paused' : ''}`}>{STATUS_LABEL[task.status]}</span>
        </div>
        <div className="dsu-meta">
          {schedule} · {runLabel(task)}
          {task.scheduledAt !== undefined ? ` · ${task.state === 'overdue' ? '已到期' : '下次'} ${timeLabel(task.scheduledAt)}` : ''}
          {extras.length > 0 ? ` · ${extras.join(' · ')}` : ''}
        </div>
        <div className="dsu-actions">
          {task.status !== 'done' ? (
            <button type="button" className="dsu-btn" onClick={() => onToggle(task)}>
              {task.status === 'active' ? '暂停' : '启动'}
            </button>
          ) : null}
          {task.status !== 'done' ? (
            <button type="button" className="dsu-btn" onClick={() => setEditingId(task.taskId)}>修改</button>
          ) : null}
          <button type="button" className="dsu-btn dsu-btn-danger" onClick={() => onDelete(task)}>删除</button>
        </div>
      </li>
    )
  }

  const active = byStatus('active')
  const paused = byStatus('paused')
  const done = byStatus('done')

  return (
    <div className="dsu-root">
      <h2 className="dsu-title">定时任务</h2>
      {loading ? <p className="dsu-muted">加载中…</p> : null}
      {error !== undefined ? <p className="dsu-error">{error}</p> : null}

      {!loading && items.length === 0 ? <p className="dsu-muted">还没有定时任务，先新建一个吧。</p> : null}

      {active.length > 0 ? <h3 className="dsu-section-title">运行中</h3> : null}
      <ul className="dsu-list">{active.map(renderCard)}</ul>

      {paused.length > 0 ? <h3 className="dsu-section-title">已暂停</h3> : null}
      <ul className="dsu-list">{paused.map(renderCard)}</ul>

      {done.length > 0 ? <h3 className="dsu-section-title">已完成</h3> : null}
      <ul className="dsu-list">{done.map(renderCard)}</ul>

      <h3 className="dsu-section-title">新建定时任务</h3>
      <TaskForm submitLabel="创建" onSubmit={onCreate} />
    </div>
  )
}

/**
 * Client plugin body: inject the panel CSS once, then register the third
 * conversation view tab. `slots.inject` waits for the declaration so the
 * contribution leaves with the plugin fiber.
 * @param ctx - client root context carrying the slot registry.
 */
export function apply(ctx: any): void {
  if (typeof document !== 'undefined' && document.getElementById('dsh-schedule-ui-css') === null) {
    const tag = document.createElement('style')
    tag.id = 'dsh-schedule-ui-css'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'schedule',
    order: 30,
    label: '定时任务',
  }, SchedulePanel))
}
