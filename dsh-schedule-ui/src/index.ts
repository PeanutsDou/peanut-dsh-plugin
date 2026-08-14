/**
 * Schedule task manager, host half. Owns a persistent task store (JSON under
 * the DSH home, keyed by Session) and uses the shipped `dsh-schedule` only as a
 * one-shot firing engine:
 *
 * - one-shot tasks (`after_seconds` / `at`) register once and fire once;
 * - recurring tasks (`daily` / `weekly` / `monthly` / `yearly`) schedule their
 *   NEXT occurrence as a one-shot `at`, and the dispatch listener chains the
 *   following occurrence, honouring run-count limits and exclusions.
 *
 * The Session's `schedule/change` stream is the source of truth for the actual
 * active reminders (including model-created ones); the store adds definitions,
 * status, and recurrence bookkeeping on top.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldScheduleEvents, scheduleView } from '@deepseek-ai/dsh-schedule'
import type { ScheduleView } from '@deepseek-ai/dsh-schedule'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
// Type-only: pull the `ctx.webServer`, `ctx.tools`, and `ctx.sessionPersistence` Context merges.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-persistence'

export const name = 'schedule-ui'
export const inject = ['webServer', 'agents', 'sessionPersistence']

interface OnceSelector {
  afterSeconds?: number
  at?: string
}

type Recurrence =
  | { readonly kind: 'daily'; readonly time: string }
  | { readonly kind: 'weekly'; readonly days: number[]; readonly time: string }
  | { readonly kind: 'monthly'; readonly day: number; readonly time: string }
  | { readonly kind: 'yearly'; readonly month: number; readonly day: number; readonly time: string }

interface StoredTask {
  readonly taskId: string
  readonly prompt: string
  readonly mode: 'once' | 'recurring'
  readonly selector?: OnceSelector
  readonly recurrence?: Recurrence
  readonly maxRuns?: number
  readonly runCount: number
  readonly timezone: string
  readonly skipWeekends?: boolean
  readonly excludeDates?: string[]
  readonly status: 'active' | 'paused' | 'done'
  readonly scheduleId?: string
  readonly createdAt: number
}

interface TaskView {
  readonly taskId: string
  readonly prompt: string
  readonly mode: 'once' | 'recurring'
  readonly selector?: OnceSelector
  readonly recurrence?: Recurrence
  readonly maxRuns?: number
  readonly runCount: number
  readonly timezone: string
  readonly skipWeekends?: boolean
  readonly excludeDates?: string[]
  readonly status: 'active' | 'paused' | 'done'
  readonly scheduledAt?: string
  readonly state?: 'scheduled' | 'overdue'
  readonly createdAt: number
}

type Store = Record<string, StoredTask[]>

const STORE_PATH = dshHomePath('schedule-ui', 'tasks.json')
const MAX_SCAN_DAYS = 800

function loadStore(): Store {
  try {
    const parsed: unknown = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

function saveStore(store: Store): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2))
}

function json(res: any, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readJson(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: any) => {
      data += chunk
    })
    req.on('end', () => {
      if (data.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch (error: unknown) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** Local calendar fields of one instant in one IANA zone. */
function localFields(epochMs: number, timezone: string): { dateStr: string; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(epochMs)
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
  }
}

function dateToEpoch(dateStr: string): number {
  return Date.parse(`${dateStr}T00:00:00Z`)
}

function epochToDate(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10)
}

function addDays(dateStr: string, n: number): string {
  return epochToDate(dateToEpoch(dateStr) + n * 86_400_000)
}

/** ISO weekday (1=Mon..7=Sun) of a local date in one zone. */
function isoWeekday(dateStr: string, timezone: string): number {
  const wd = localFields(dateToEpoch(dateStr) + 12 * 3600 * 1000, timezone).weekday
  return wd === 0 ? 7 : wd
}

function matchesRecurrence(recurrence: Recurrence, dateStr: string, timezone: string): boolean {
  switch (recurrence.kind) {
    case 'daily': return true
    case 'weekly': return recurrence.days.includes(isoWeekday(dateStr, timezone))
    case 'monthly': return Number(dateStr.slice(8, 10)) === recurrence.day
    case 'yearly':
      return Number(dateStr.slice(5, 7)) === recurrence.month && Number(dateStr.slice(8, 10)) === recurrence.day
  }
}

function isExcluded(dateStr: string, skipWeekends: boolean | undefined, excludeDates: string[] | undefined, timezone: string): boolean {
  if (skipWeekends === true) {
    const wd = isoWeekday(dateStr, timezone)
    if (wd === 6 || wd === 7) return true
  }
  return excludeDates?.includes(dateStr) === true
}

/** Next local occurrence (date + HH:mm) for a recurrence, or null when none within the scan window. */
function nextOccurrence(recurrence: Recurrence, timezone: string, skipWeekends: boolean | undefined, excludeDates: string[] | undefined, fromMs: number): { date: string; time: string } | null {
  const now = localFields(fromMs, timezone)
  const [hh, mm] = recurrence.time.split(':').map(Number)
  const targetMin = hh * 60 + mm
  const nowMin = now.hour * 60 + now.minute
  let date = now.dateStr
  for (let i = 0; i < MAX_SCAN_DAYS; i += 1) {
    if (matchesRecurrence(recurrence, date, timezone)) {
      const isToday = date === now.dateStr
      if ((!isToday || targetMin > nowMin) && !isExcluded(date, skipWeekends, excludeDates, timezone)) {
        return { date, time: recurrence.time }
      }
    }
    date = addDays(date, 1)
  }
  return null
}

function foldReminders(events: readonly SessionEvent[], seedLength: number): ScheduleView[] {
  try {
    const folded = foldScheduleEvents(events, seedLength)
    const now = Date.now()
    return folded.active.map((record) => scheduleView(record, now))
  } catch {
    return []
  }
}

async function foldCold(ctx: Context, sessionId: string): Promise<ScheduleView[]> {
  try {
    const inspected = await ctx.sessionPersistence.inspect(SessionId(sessionId))
    return foldReminders(inspected.events, inspected.meta.seedLength ?? 0)
  } catch {
    return []
  }
}

async function runScheduleTool(
  agent: Agent,
  name: 'schedule_create' | 'schedule_delete',
  args: unknown,
): Promise<{ value: any } | { error: string }> {
  const tools = agent.ctx.tools
  if (tools === undefined) return { error: 'the tools service is unavailable' }
  const result = await tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`schedule-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) return { error: 'the schedule operation failed' }
  const value = result.value
  if (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'code' in value
    && (value as { code?: string }).code !== 'schedule_not_found'
  ) {
    return { error: (value as { message?: string }).message ?? 'the schedule operation failed' }
  }
  return { value }
}

/** The `schedule_create` arguments for a one-shot selector or a local `at` occurrence. */
function createArgs(task: { prompt: string; selector?: OnceSelector } | { prompt: string; at: { date: string; time: string; time_zone: string } }): Record<string, unknown> {
  if ('selector' in task && task.selector !== undefined) {
    const args: Record<string, unknown> = { prompt: task.prompt }
    const selector = task.selector
    if (selector.afterSeconds !== undefined) args.after_seconds = selector.afterSeconds
    if (selector.at !== undefined) args.at = selector.at
    return args
  }
  const local = task as { prompt: string; at: { date: string; time: string; time_zone: string } }
  return { prompt: local.prompt, at: { date: local.at.date, time: `${local.at.time}:00`, time_zone: local.at.time_zone } }
}

function selectorCount(selector: OnceSelector): number {
  return Number(selector.afterSeconds !== undefined) + Number(selector.at !== undefined)
}

function normalizeSelector(body: any): { selector?: OnceSelector; error?: string } {
  if (body.selector === undefined) return {}
  const selector = body.selector as OnceSelector
  const count = selectorCount(selector)
  if (count !== 1) return { error: 'selector must set exactly one of afterSeconds or at' }
  return { selector }
}

function normalizeRecurrence(body: any): { recurrence?: Recurrence; error?: string } {
  if (body.recurrence === undefined) return {}
  const recurrence = body.recurrence as Recurrence
  const time = typeof recurrence.time === 'string' && /^\d{2}:\d{2}$/.test(recurrence.time) ? recurrence.time : undefined
  if (time === undefined) return { error: 'recurrence.time must be HH:mm' }
  switch (recurrence.kind) {
    case 'daily':
      return { recurrence: { kind: 'daily', time } }
    case 'weekly': {
      const days = recurrence.days
      if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
        return { error: 'recurrence.days must be a non-empty list of 1..7' }
      }
      return { recurrence: { kind: 'weekly', days, time } }
    }
    case 'monthly': {
      const day = recurrence.day
      if (!Number.isInteger(day) || day < 1 || day > 31) return { error: 'recurrence.day must be 1..31' }
      return { recurrence: { kind: 'monthly', day, time } }
    }
    case 'yearly': {
      const month = recurrence.month
      const day = recurrence.day
      if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) {
        return { error: 'recurrence.month must be 1..12 and day 1..31' }
      }
      return { recurrence: { kind: 'yearly', month, day, time } }
    }
    default:
      return { error: 'recurrence.kind must be daily, weekly, monthly, or yearly' }
  }
}

function normalizeTaskInput(body: any): { prompt: string; mode: 'once' | 'recurring'; selector?: OnceSelector; recurrence?: Recurrence; error?: string } {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt.length === 0) return { prompt: '', mode: 'once', error: 'prompt is required' }
  const mode = body.mode === 'recurring' ? 'recurring' : 'once'
  if (mode === 'recurring') {
    const { recurrence, error } = normalizeRecurrence(body)
    if (error !== undefined) return { prompt, mode, error }
    return { prompt, mode, recurrence }
  }
  const { selector, error } = normalizeSelector(body)
  if (error !== undefined) return { prompt, mode, error }
  return { prompt, mode, selector }
}

function timezone(body: any): string {
  return typeof body.timezone === 'string' && body.timezone.trim() !== '' ? body.timezone : 'UTC'
}

function toTaskView(task: StoredTask, fold: Map<string, { scheduledAt: string; state: 'scheduled' | 'overdue' }>): TaskView {
  const active = task.scheduleId !== undefined ? fold.get(task.scheduleId) : undefined
  return {
    taskId: task.taskId,
    prompt: task.prompt,
    mode: task.mode,
    ...(task.selector !== undefined ? { selector: task.selector } : {}),
    ...(task.recurrence !== undefined ? { recurrence: task.recurrence } : {}),
    ...(task.maxRuns !== undefined ? { maxRuns: task.maxRuns } : {}),
    runCount: task.runCount,
    timezone: task.timezone,
    ...(task.skipWeekends !== undefined ? { skipWeekends: task.skipWeekends } : {}),
    ...(task.excludeDates !== undefined ? { excludeDates: task.excludeDates } : {}),
    status: task.status,
    ...(active !== undefined ? { scheduledAt: active.scheduledAt, state: active.state } : {}),
    createdAt: task.createdAt,
  }
}

/** Deterministic model content for a task value. */
function renderTaskValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Generic pending card for the model-facing tool. */
function presentTask(title: string, rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'other', ...(rawInput === undefined ? {} : { rawInput }) }
}

/** The `schedule_task` parameter schema. */
const SCHEDULE_TASK_PARAMETERS = {
  prompt: { type: 'string', required: true, description: 'Reminder content to present when the task fires.' },
  recurrence: {
    type: 'object',
    required: true,
    description: 'Calendar recurrence rule.',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', required: true, enum: ['daily', 'weekly', 'monthly', 'yearly'] },
      time: { type: 'string', required: true, description: 'Local wall-clock time as HH:mm (24-hour).' },
      days: { type: 'array', items: { type: 'integer' }, description: 'ISO weekdays 1 (Mon) through 7 (Sun); required for weekly.' },
      day: { type: 'integer', description: 'Day of month 1-31; required for monthly and yearly.' },
      month: { type: 'integer', description: 'Month 1-12; required for yearly.' },
      time_zone: { type: 'string', description: 'IANA zone; defaults to the machine local zone.' },
    },
  },
  skip_weekends: { type: 'boolean', description: 'Skip Saturday and Sunday.' },
  exclude_dates: { type: 'array', items: { type: 'string' }, description: 'Local dates YYYY-MM-DD to skip.' },
  max_runs: { type: 'integer', description: 'Stop after this many fires; omit for unlimited.' },
} as const

export function apply(ctx: Context): void {
  const store = loadStore()

  const tasksOf = (sessionId: string): StoredTask[] => store[sessionId] ?? []
  const setTasks = (sessionId: string, tasks: StoredTask[]): void => {
    store[sessionId] = tasks
    saveStore(store)
  }

  /** Chain a recurring task that just fired (or is missing its next `at`). */
  const chainRecurring = async (sessionId: string, index: number): Promise<void> => {
    const tasks = tasksOf(sessionId)
    const task = tasks[index]
    if (task === undefined || task.mode !== 'recurring' || task.status !== 'active' || task.recurrence === undefined) return
    const agent = ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) return
    const runCount = task.runCount + 1
    if (task.maxRuns !== undefined && runCount >= task.maxRuns) {
      const next: StoredTask = { ...task, runCount, status: 'done', scheduleId: undefined }
      const nextTasks = [...tasks]
      nextTasks[index] = next
      setTasks(sessionId, nextTasks)
      return
    }
    const occurrence = nextOccurrence(task.recurrence, task.timezone, task.skipWeekends, task.excludeDates, Date.now())
    if (occurrence === null) {
      const next: StoredTask = { ...task, runCount, status: 'done', scheduleId: undefined }
      const nextTasks = [...tasks]
      nextTasks[index] = next
      setTasks(sessionId, nextTasks)
      return
    }
    const created = await runScheduleTool(agent, 'schedule_create', createArgs({
      prompt: task.prompt,
      at: { date: occurrence.date, time: occurrence.time, time_zone: task.timezone },
    }))
    if ('error' in created) return
    const scheduleId = (created.value as { id?: string }).id
    const next: StoredTask = {
      ...task,
      runCount,
      ...(scheduleId !== undefined ? { scheduleId } : {}),
    }
    const nextTasks = [...tasks]
    nextTasks[index] = next
    setTasks(sessionId, nextTasks)
  }

  /** Create one task (once or recurring), register its reminder, and persist it. */
  const createTask = async (agent: Agent, sessionId: string, input: ReturnType<typeof normalizeTaskInput>, body: any): Promise<{ task: StoredTask } | { error: string }> => {
    if (input.error !== undefined) return { error: input.error }
    const tz = timezone(body)
    let scheduleId: string | undefined
    if (input.mode === 'recurring') {
      const occurrence = nextOccurrence(input.recurrence as Recurrence, tz, body.skipWeekends === true, body.excludeDates, Date.now())
      if (occurrence === null) return { error: 'no upcoming occurrence found' }
      const created = await runScheduleTool(agent, 'schedule_create', createArgs({
        prompt: input.prompt,
        at: { date: occurrence.date, time: occurrence.time, time_zone: tz },
      }))
      if ('error' in created) return { error: created.error }
      scheduleId = (created.value as { id?: string }).id
    } else {
      const created = await runScheduleTool(agent, 'schedule_create', createArgs({ prompt: input.prompt, selector: input.selector }))
      if ('error' in created) return { error: created.error }
      scheduleId = (created.value as { id?: string }).id
    }
    const task: StoredTask = {
      taskId: randomUUID(),
      prompt: input.prompt,
      mode: input.mode,
      ...(input.selector !== undefined ? { selector: input.selector } : {}),
      ...(input.recurrence !== undefined ? { recurrence: input.recurrence } : {}),
      ...(input.mode === 'recurring' && body.maxRuns !== undefined && Number.isInteger(body.maxRuns) ? { maxRuns: body.maxRuns } : {}),
      runCount: 0,
      timezone: tz,
      ...(body.skipWeekends === true ? { skipWeekends: true } : {}),
      ...(Array.isArray(body.excludeDates) ? { excludeDates: body.excludeDates.filter((d: unknown) => typeof d === 'string') } : {}),
      status: 'active',
      ...(scheduleId !== undefined ? { scheduleId } : {}),
      createdAt: Date.now(),
    }
    setTasks(sessionId, [...tasksOf(sessionId), task])
    return { task }
  }

  // Prompt chaining: a recurring task's one-shot `at` dispatched → schedule the next.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'schedule/change' || event.data.operation !== 'dispatch') return
    const scheduleId = event.data.id
    const sessionId = session.id
    const tasks = tasksOf(sessionId)
    const index = tasks.findIndex((task) => task.status === 'active' && task.mode === 'recurring' && task.scheduleId === scheduleId)
    if (index !== -1) void chainRecurring(sessionId, index)
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/schedule/tasks',
    handler: async (req: any, res: any) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'method not allowed' })
      const body = await readJson(req)
      if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
        return json(res, 200, { ok: false, message: 'sessionId is required' })
      }
      const sessionId = body.sessionId
      const live = ctx.agents.get(SessionId(sessionId))
      const activeViews = live !== undefined
        ? foldReminders(live.session.events, live.session.header.seedLength ?? 0)
        : await foldCold(ctx, sessionId)
      const fold = new Map<string, { scheduledAt: string; state: 'scheduled' | 'overdue' }>()
      for (const view of activeViews) fold.set(view.id, { scheduledAt: view.scheduledAt, state: view.state })

      // Catch-up: a recurring task whose `at` fired but was not chained (e.g. restart).
      const tasks = tasksOf(sessionId)
      for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i]
        if (task.status === 'active' && task.mode === 'recurring' && task.scheduleId !== undefined && !fold.has(task.scheduleId)) {
          void chainRecurring(sessionId, i)
        }
      }

      const storedViews = tasks.map((task) => toTaskView(task, fold))
      // Model-created orphans: active reminders not owned by any store task.
      const owned = new Set(tasks.filter((t) => t.scheduleId !== undefined).map((t) => t.scheduleId as string))
      const orphans: TaskView[] = []
      for (const view of activeViews) {
        if (owned.has(view.id)) continue
        orphans.push({
          taskId: view.id,
          prompt: view.prompt,
          mode: 'once',
          selector: view.kind === 'after' ? { afterSeconds: view.afterSeconds } : view.kind === 'every' ? { at: view.scheduledAt } : { at: view.scheduledAt },
          runCount: 0,
          timezone: 'UTC',
          status: 'active',
          scheduledAt: view.scheduledAt,
          state: view.state,
          createdAt: 0,
        })
      }
      return json(res, 200, { ok: true, items: [...storedViews, ...orphans] })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/schedule/create',
    handler: async (req: any, res: any) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'method not allowed' })
      const body = await readJson(req)
      const found = ctx.agents.get(SessionId(typeof body.sessionId === 'string' ? body.sessionId : ''))
      if (found === undefined) return json(res, 200, { ok: false, message: 'this conversation is not live; send a message first' })
      const input = normalizeTaskInput(body)
      const created = await createTask(found, body.sessionId, input, body)
      if ('error' in created) return json(res, 200, { ok: false, message: created.error })
      return json(res, 200, { ok: true, item: created.task })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/schedule/edit',
    handler: async (req: any, res: any) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'method not allowed' })
      const body = await readJson(req)
      const tasks = tasksOf(body.sessionId)
      const index = tasks.findIndex((task) => task.taskId === body.taskId)
      if (index === -1) return json(res, 200, { ok: false, message: 'task not found' })
      const existing = tasks[index]
      const input = normalizeTaskInput(body)
      if (input.error !== undefined) return json(res, 200, { ok: false, message: input.error })
      const tz = timezone(body)
      let scheduleId = existing.scheduleId
      if (existing.status === 'active') {
        const found = ctx.agents.get(SessionId(body.sessionId))
        if (found === undefined) return json(res, 200, { ok: false, message: 'this conversation is not live; send a message first' })
        if (existing.scheduleId !== undefined) {
          const removed = await runScheduleTool(found, 'schedule_delete', { id: existing.scheduleId })
          if ('error' in removed) return json(res, 200, { ok: false, message: removed.error })
        }
        let created: { value: any } | { error: string }
        if (input.mode === 'recurring') {
          const occurrence = nextOccurrence(input.recurrence as Recurrence, tz, body.skipWeekends === true, body.excludeDates, Date.now())
          if (occurrence === null) return json(res, 200, { ok: false, message: 'no upcoming occurrence found' })
          created = await runScheduleTool(found, 'schedule_create', createArgs({ prompt: input.prompt, at: { date: occurrence.date, time: occurrence.time, time_zone: tz } }))
        } else {
          created = await runScheduleTool(found, 'schedule_create', createArgs({ prompt: input.prompt, selector: input.selector }))
        }
        if ('error' in created) return json(res, 200, { ok: false, message: created.error })
        scheduleId = (created.value as { id?: string }).id
      }
      const next: StoredTask = {
        taskId: existing.taskId,
        prompt: input.prompt,
        mode: input.mode,
        ...(input.selector !== undefined ? { selector: input.selector } : {}),
        ...(input.recurrence !== undefined ? { recurrence: input.recurrence } : {}),
        ...(input.mode === 'recurring' && body.maxRuns !== undefined && Number.isInteger(body.maxRuns) ? { maxRuns: body.maxRuns } : {}),
        runCount: existing.runCount,
        timezone: tz,
        ...(body.skipWeekends === true ? { skipWeekends: true } : {}),
        ...(Array.isArray(body.excludeDates) ? { excludeDates: body.excludeDates.filter((d: unknown) => typeof d === 'string') } : {}),
        status: existing.status,
        ...(scheduleId !== undefined ? { scheduleId } : {}),
        createdAt: existing.createdAt,
      }
      const nextTasks = [...tasks]
      nextTasks[index] = next
      setTasks(body.sessionId, nextTasks)
      return json(res, 200, { ok: true, item: next })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/schedule/pause',
    handler: async (req: any, res: any) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'method not allowed' })
      const body = await readJson(req)
      const found = ctx.agents.get(SessionId(body.sessionId))
      if (found === undefined) return json(res, 200, { ok: false, message: 'this conversation is not live; send a message first' })
      const tasks = tasksOf(body.sessionId)
      const index = tasks.findIndex((task) => task.taskId === body.taskId)
      if (index === -1) return json(res, 200, { ok: false, message: 'task not found' })
      const existing = tasks[index]
      if (existing.status === 'paused') return json(res, 200, { ok: true, item: existing })
      if (existing.scheduleId !== undefined) {
        const removed = await runScheduleTool(found, 'schedule_delete', { id: existing.scheduleId })
        if ('error' in removed) return json(res, 200, { ok: false, message: removed.error })
      }
      const next: StoredTask = { ...existing, status: 'paused', scheduleId: undefined }
      const nextTasks = [...tasks]
      nextTasks[index] = next
      setTasks(body.sessionId, nextTasks)
      return json(res, 200, { ok: true, item: next })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/schedule/resume',
    handler: async (req: any, res: any) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'method not allowed' })
      const body = await readJson(req)
      const found = ctx.agents.get(SessionId(body.sessionId))
      if (found === undefined) return json(res, 200, { ok: false, message: 'this conversation is not live; send a message first' })
      const tasks = tasksOf(body.sessionId)
      const index = tasks.findIndex((task) => task.taskId === body.taskId)
      if (index === -1) return json(res, 200, { ok: false, message: 'paused task not found' })
      const existing = tasks[index]
      if (existing.status === 'active') return json(res, 200, { ok: true, item: existing })
      let scheduleId: string | undefined
      if (existing.mode === 'recurring' && existing.recurrence !== undefined) {
        const occurrence = nextOccurrence(existing.recurrence, existing.timezone, existing.skipWeekends, existing.excludeDates, Date.now())
        if (occurrence === null) return json(res, 200, { ok: false, message: 'no upcoming occurrence found' })
        const created = await runScheduleTool(found, 'schedule_create', createArgs({ prompt: existing.prompt, at: { date: occurrence.date, time: occurrence.time, time_zone: existing.timezone } }))
        if ('error' in created) return json(res, 200, { ok: false, message: created.error })
        scheduleId = (created.value as { id?: string }).id
      } else {
        const created = await runScheduleTool(found, 'schedule_create', createArgs({ prompt: existing.prompt, selector: existing.selector }))
        if ('error' in created) return json(res, 200, { ok: false, message: created.error })
        scheduleId = (created.value as { id?: string }).id
      }
      const next: StoredTask = { ...existing, status: 'active', ...(scheduleId !== undefined ? { scheduleId } : {}) }
      const nextTasks = [...tasks]
      nextTasks[index] = next
      setTasks(body.sessionId, nextTasks)
      return json(res, 200, { ok: true, item: next })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/schedule/delete',
    handler: async (req: any, res: any) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'method not allowed' })
      const body = await readJson(req)
      const found = ctx.agents.get(SessionId(body.sessionId))
      if (found === undefined) return json(res, 200, { ok: false, message: 'this conversation is not live; send a message first' })
      const tasks = tasksOf(body.sessionId)
      const index = tasks.findIndex((task) => task.taskId === body.taskId)
      if (index === -1) return json(res, 200, { ok: false, message: 'task not found' })
      const existing = tasks[index]
      if (existing.scheduleId !== undefined) {
        const removed = await runScheduleTool(found, 'schedule_delete', { id: existing.scheduleId })
        if ('error' in removed) return json(res, 200, { ok: false, message: removed.error })
      }
      setTasks(body.sessionId, tasks.filter((task) => task.taskId !== body.taskId))
      return json(res, 200, { ok: true })
    },
  })

  // Model tool: schedule_task — let the model create calendar-recurring tasks.
  ctx.on('agent/created', ({ agent }) => {
    if (!ctx.agents.roots().includes(agent)) return
    agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
      name: 'schedule_task',
      description:
        'Create a recurring scheduled task in the current session. Supply a non-empty prompt and a recurrence rule '
        + '(daily, weekly, monthly, or yearly with a local HH:mm time). Optionally skip weekends, exclude specific '
        + 'YYYY-MM-DD dates, or stop after max_runs fires. Delivery is session-local: the task fires only while this session is live.',
      parameters: SCHEDULE_TASK_PARAMETERS,
      output: { schema: { type: 'object', additionalProperties: true }, render: renderTaskValue },
      async execute(args: any, exec) {
        const owner = exec.agent
        if (owner === undefined || owner !== agent) return { code: 'internal_error', message: 'The schedule task operation failed.' }
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt.length === 0) return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
        const recurrence = args.recurrence
        const normalized = normalizeRecurrence({ recurrence })
        if (normalized.error !== undefined) return { code: 'invalid_rule', message: normalized.error }
        const tz = typeof recurrence?.time_zone === 'string' && recurrence.time_zone !== ''
          ? recurrence.time_zone
          : Intl.DateTimeFormat().resolvedOptions().timeZone
        const body = {
          prompt,
          mode: 'recurring',
          recurrence: normalized.recurrence,
          maxRuns: args.max_runs,
          timezone: tz,
          skipWeekends: args.skip_weekends === true,
          excludeDates: Array.isArray(args.exclude_dates) ? args.exclude_dates : undefined,
        }
        const input = normalizeTaskInput(body)
        const created = await createTask(owner, owner.session.id, input, body)
        if ('error' in created) return { code: 'invalid_rule', message: created.error }
        return created.task as any
      },
      presentCall: (args: any) => presentTask('Create scheduled task', args.prompt),
    })), 'schedule-ui.schedule-task()')
  })
}
