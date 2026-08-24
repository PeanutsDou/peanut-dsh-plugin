// dsh-schedule-guard — 宿主级定时任务守护插件
//
// 问题：shipped dsh-schedule 的 timer 挂在 live agent 上（agent/created 时创建 runtime，
// agent dispose 时清理）。会话窗口关闭 → agent 不 live → timer 不存在 → 到点不触发，
// 只能等下次打开窗口 resume 后补触发 overdue。
//
// 方案：本插件在宿主层运行，不依赖任何 agent 是否 live：
//  1. 定期扫描所有持久化会话的事件日志，折叠 schedule/change 记录（复用 dsh-schedule
//     的 foldScheduleEvents 语义，内联实现避免依赖）。
//  2. 对每个有 schedule 记录的会话，计算下次触发时间；到点时如果目标 agent 不在 live，
//     就用 agentLoop.resume 恢复它 → resume 触发 agent/created → dsh-schedule 的 runtime
//     自动创建并发现 overdue → 自动 followup 提醒 → 模型处理。
//  3. 处理完（whenIdle）后 dispose handle，让会话回到 cold 状态；下一次到点再次唤醒。
//
// 这样定时任务不再依赖窗口是否打开，DSH 进程在就会触发。

import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'schedule-guard'

export const inject = [
  'agents',
  'sessions',
  'sessionPersistence',
  'timer',
  'agentPresets',
  'agentDefaultModel',
]

/** 每次全量扫描的间隔（毫秒）。 */
const SCAN_INTERVAL_MS = 30000

// ── 内联的 schedule 折叠逻辑（与 @deepseek-ai/dsh-schedule 的 v1 协议一致）──

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeInstant(value) {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) throw new Error('bad scheduledAt')
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) throw new Error('bad instant')
  return value
}

function decodeRecord(value) {
  if (!isRecord(value)) throw new Error('bad record')
  switch (value.kind) {
    case 'after':
    case 'at': {
      if (typeof value.id !== 'string' || typeof value.prompt !== 'string') throw new Error('bad one-shot')
      decodeInstant(value.scheduledAt)
      return value
    }
    case 'every': {
      if (typeof value.id !== 'string' || typeof value.prompt !== 'string') throw new Error('bad every')
      decodeInstant(value.scheduledAt)
      return value
    }
    default:
      throw new Error('bad kind')
  }
}

function decodeChange(data) {
  if (!isRecord(data) || data.version !== 1) throw new Error('bad change')
  switch (data.operation) {
    case 'create':
      return { operation: 'create', schedule: decodeRecord(data.schedule) }
    case 'delete':
      return { operation: 'delete', id: data.id }
    case 'dispatch':
      return { operation: 'dispatch', id: data.id, acceptedAt: data.acceptedAt }
    default:
      throw new Error('bad op')
  }
}

function resolveEveryOccurrence(record, acceptedAtMs) {
  const target = Date.parse(record.scheduledAt)
  const interval = record.everySeconds * 1000
  const occurrence = target + Math.floor((acceptedAtMs - target) / interval) * interval
  const next = occurrence + interval
  return { occurrenceAt: new Date(occurrence).toISOString(), nextScheduledAt: new Date(next).toISOString() }
}

/**
 * 折叠会话事件日志中的 schedule 记录，返回活跃记录列表。
 * 与 @deepseek-ai/dsh-schedule 的 foldScheduleEvents 行为一致（简化版）。
 */
function foldScheduleEvents(events, seedLength = 0) {
  const active = new Map()
  for (const event of events.slice(seedLength)) {
    if (event.type !== 'schedule/change') continue
    let change
    try {
      change = decodeChange(event.data)
    } catch {
      continue // 脏数据跳过，不阻断
    }
    switch (change.operation) {
      case 'create':
        active.set(change.schedule.id, change.schedule)
        break
      case 'delete':
        active.delete(change.id)
        break
      case 'dispatch': {
        const record = active.get(change.id)
        if (record === undefined) break
        if (record.kind !== 'every') {
          active.delete(change.id)
        } else {
          const next = resolveEveryOccurrence(record, Date.parse(change.acceptedAt)).nextScheduledAt
          active.set(change.id, { ...record, scheduledAt: next })
        }
        break
      }
    }
  }
  return [...active.values()]
}

// ── 宿主守护逻辑 ──

export function apply(ctx) {
  /** 正在唤醒中的会话，避免并发重复 resume。 */
  const waking = new Set()
  let scanning = false

  /** 读取一个会话的事件日志（持久化 inspect）。 */
  async function readSessionEvents(sessionId) {
    try {
      const inspection = await ctx.sessionPersistence.inspect(sessionId)
      return {
        header: inspection.meta,
        events: inspection.events,
      }
    } catch (error) {
      ctx.logger.warn(`schedule-guard: inspect ${sessionId} failed: ${String(error)}`)
      return undefined
    }
  }

  /** 判断一个会话是否应被守护唤醒（根会话且当前不在 live）。 */
  function shouldWake(sessionId, header) {
    if (header.origin === 'subagent') return false
    if (header.parentSession !== undefined && header.parentSession !== '') return false
    const live = ctx.agents.get(sessionId)
    return live === undefined
  }

  /** 解析该会话使用的 agent preset。 */
  async function resolvePresetFor(header, events) {
    let presetId = header.agentPreset
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'agent-preset/selected') {
        presetId = event.data.agentPreset
        break
      }
    }
    return presetId
  }

  /** 组装 resume 所需的 setup（挂载 preset + 模型选择）。 */
  async function buildSetup(header, events) {
    const presets = ctx.get('agentPresets')
    const presetId = await resolvePresetFor(header, events)
    if (presets === undefined) return undefined
    const resolved = presetId === undefined ? await presets.resolve() : await presets.resolve(presetId)
    return async (agentCtx) => {
      await presets.mount(agentCtx, resolved.id)
    }
  }

  /** 恢复一个冷会话，等待 dsh-schedule 完成 dispatch。保持 agent live 以便后续 every 任务继续触发。 */
  async function wakeSession(sessionId, header, events) {
    if (waking.has(sessionId)) return
    waking.add(sessionId)
    let handle
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection()
      const agentOptions = selection === undefined ? undefined : { provider: selection.provider, model: selection.model }
      const setup = await buildSetup(header, events)
      handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(setup === undefined ? {} : { setup }),
      })
      const agent = handle.agent
      // resume 触发 agent/created → dsh-schedule runtime 自动创建并发现 overdue → followup 提醒。
      // 保持 agent live：shipped dsh-schedule 的 timer 继续挂在 live agent 上，
      // 后续 every 任务到点自动触发，不再依赖窗口是否打开。
      // 等 agent 处理完当前 followup 后 idle（最多 10 分钟），然后释放 handle 引用但不 dispose agent。
      await Promise.race([agent.whenIdle(), new Promise((resolve) => setTimeout(resolve, 10 * 60 * 1000))])
      ctx.logger.info(`schedule-guard: woke session ${sessionId}, reminder dispatched`)
    } catch (error) {
      ctx.logger.warn(`schedule-guard: wake ${sessionId} failed: ${String(error)}`)
      // resume 失败时清理 handle（若有），避免泄漏
      if (handle !== undefined) {
        try {
          await handle.dispose()
        } catch (disposeError) {
          ctx.logger.warn(`schedule-guard: dispose ${sessionId} failed: ${String(disposeError)}`)
        }
      }
    } finally {
      waking.delete(sessionId)
    }
  }

  /** 一轮全量扫描：折叠所有持久化会话的 schedule 记录，唤醒到期的冷会话。 */
  async function scanOnce() {
    if (scanning) return
    scanning = true
    try {
      const headers = await ctx.sessionPersistence.list()
      const now = Date.now()
      for (const header of headers) {
        if (header.id === undefined) continue
        if (!shouldWake(header.id, header)) continue
        const read = await readSessionEvents(header.id)
        if (read === undefined) continue
        let active
        try {
          active = foldScheduleEvents(read.events, read.header.seedLength ?? 0)
        } catch (error) {
          ctx.logger.warn(`schedule-guard: fold ${header.id} failed: ${String(error)}`)
          continue
        }
        if (active.length === 0) continue
        const due = active.some((record) => Date.parse(record.scheduledAt) <= now)
        if (due) {
          await wakeSession(header.id, read.header, read.events)
        }
      }
    } catch (error) {
      ctx.logger.warn(`schedule-guard: scan failed: ${String(error)}`)
    } finally {
      scanning = false
    }
  }

  // 启动：先扫一次，然后周期性扫描
  scanOnce()
  const stopInterval = ctx.timer.interval(() => {
    scanOnce()
  }, SCAN_INTERVAL_MS)
  ctx.effect(() => stopInterval)
}
