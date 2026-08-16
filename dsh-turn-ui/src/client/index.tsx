/**
 * dsh-turn-ui — client half: left-edge floating turn navigation rail.
 *
 * Registered into `conversation.session.header.utilities` (session scope) and
 * rendered through a portal so the fixed rail never participates in the header
 * layout. Clicking a tick jumps to the matching `data-turn-start` anchor added
 * by the TurnFold core patch, falling back to proportional scroll for turns
 * outside the paged window.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export const name = 'dsh-turn-ui-client'
export const inject = ['slots', 'settingsScope']

type RailProps = PropsRuntime<'conversation.session.header.utilities'>

interface TurnUiClientSettings {
  turnRailEnabled: boolean
}

interface ClientSettingsStore {
  current: TurnUiClientSettings
  listeners: Set<() => void>
  getSnapshot(): TurnUiClientSettings
  subscribe(listener: () => void): () => void
  set(next: TurnUiClientSettings): void
}

const clientSettingsStore: ClientSettingsStore = {
  current: { turnRailEnabled: true },
  listeners: new Set<() => void>(),
  getSnapshot(): TurnUiClientSettings {
    return this.current
  },
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  },
  set(next: TurnUiClientSettings): void {
    if (next.turnRailEnabled === this.current.turnRailEnabled) return
    this.current = next
    for (const listener of this.listeners) listener()
  },
}

function subscribeClientSettings(listener: () => void): () => void {
  return clientSettingsStore.subscribe(listener)
}

function getClientSettingsSnapshot(): TurnUiClientSettings {
  return clientSettingsStore.getSnapshot()
}

interface RailFrame {
  left: number
  top: number
  height: number
}

const RAIL_WIDTH = 10
const RAIL_HOVER_WIDTH = 24
const TOP_OFFSET = 64

function scrollport(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-conversation-scroll]')
}

function ensureStyles(): void {
  const id = 'dsh-turn-rail-styles'
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = `
.dsh-turn-rail{position:fixed;z-index:1300;width:10px;pointer-events:none;transition:width .12s ease}
.dsh-turn-rail:hover{width:24px}
.dsh-turn-rail-track{position:absolute;inset:0;display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:8px 0;pointer-events:auto}
.dsh-turn-bar{position:relative;flex:0 0 6px;width:100%;height:6px;border:0;border-radius:0;padding:0;background:var(--dsw-alias-label-caption);cursor:pointer;opacity:.55;transition:opacity .12s,background .12s}
.dsh-turn-bar:hover,.dsh-turn-bar.active{opacity:1;background:var(--dsw-alias-label-primary)}
.dsh-turn-bar.running{animation:dsh-turn-bar-pulse 1.2s ease-in-out infinite}
@keyframes dsh-turn-bar-pulse{0%,100%{opacity:1}50%{opacity:.3}}
.dsh-turn-rail-tip{position:absolute;left:calc(100% + 10px);top:50%;display:block;max-width:280px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:12px/1.5 system-ui;white-space:nowrap;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.2);transform:translateY(-50%);z-index:2}
.dsh-turn-rail-tip-title{display:block;font-weight:600}
.dsh-turn-rail-tip-summary{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;overflow:hidden;text-overflow:ellipsis}
.dsh-turn-ui-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}
.dsh-turn-ui-card-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;padding:14px 16px}
.dsh-turn-ui-card-header span{display:block;font-size:15px;font-weight:600}
.dsh-turn-ui-card-body{padding:0 16px 12px;display:flex;flex-direction:column;gap:10px}
.dsh-turn-ui-toggle{display:flex;align-items:center;gap:10px;font-size:13px}
.dsh-turn-ui-toggle input{accent-color:var(--dsw-alias-brand-primary)}
`
  document.head.append(style)
}

function extractTurnSummary(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined
  const record = node as { kind?: unknown; data?: { content?: unknown } }
  if (record.kind !== 'user') return undefined
  const content = record.data?.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const item = block as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') {
      const text = item.text.replace(/\s+/g, ' ').trim()
      if (text !== '') return text.length > 70 ? text.slice(0, 70) + '…' : text
    }
  }
  return undefined
}

function buildTurnSummaries(chat: unknown, turnOrder: readonly number[]): ReadonlyMap<number, string> {
  const summaries = new Map<number, string>()
  const snapshot = chat as {
    locations?: { getTurn?: (turn: number) => readonly string[] | undefined }
    nodes?: { get?: (key: string) => unknown }
  }
  for (const turn of turnOrder) {
    const keys = snapshot.locations?.getTurn?.(turn) ?? []
    for (const key of keys) {
      const summary = extractTurnSummary(snapshot.nodes?.get?.(key))
      if (summary !== undefined) {
        summaries.set(turn, summary)
        break
      }
    }
  }
  return summaries
}

function TurnRail({ useSession, sessionId }: RailProps) {
  const settings = useSyncExternalStore(subscribeClientSettings, getClientSettingsSnapshot)
  const timeline = useSession(snapshot => snapshot.chat.timeline)
  const chat = useSession(snapshot => snapshot.chat)
  const turnOrder = timeline.turnOrder
  const [frame, setFrame] = useState<RailFrame | null>(null)
  const [activeTurn, setActiveTurn] = useState<number | null>(turnOrder[0] ?? null)
  const [hoverTurn, setHoverTurn] = useState<number | null>(null)

  const orderKey = useMemo(() => turnOrder.join(','), [turnOrder])
  const turnSummaries = useMemo(() => buildTurnSummaries(chat, turnOrder), [chat, orderKey])

  useEffect(() => {
    ensureStyles()
    const updateFrame = () => {
      const port = scrollport()
      if (port === null) {
        setFrame(null)
        return
      }
      const rect = port.getBoundingClientRect()
      setFrame(current => {
        const next = { left: rect.left, top: rect.top, height: rect.height }
        if (current !== null
          && Math.abs(current.left - next.left) < 0.5
          && Math.abs(current.top - next.top) < 0.5
          && Math.abs(current.height - next.height) < 0.5) return current
        return next
      })
    }
    updateFrame()
    const port = scrollport()
    port?.addEventListener('scroll', updateFrame, { passive: true })
    window.addEventListener('resize', updateFrame)
    const interval = setInterval(updateFrame, 500)
    return () => {
      port?.removeEventListener('scroll', updateFrame)
      window.removeEventListener('resize', updateFrame)
      clearInterval(interval)
    }
  }, [sessionId])

  useEffect(() => {
    let frame = 0
    const updateActive = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const port = scrollport()
        if (port === null) return
        const portRect = port.getBoundingClientRect()
        let current = turnOrder[0] ?? null
        for (const turn of turnOrder) {
          const anchor = port.querySelector<HTMLElement>(`[data-turn-start="${turn}"]`)
            ?? port.querySelector<HTMLElement>(`[data-turn-tail="${turn}"]`)
          if (anchor === null) continue
          const flowTop = anchor.getBoundingClientRect().top - portRect.top + port.scrollTop
          if (flowTop <= port.scrollTop + TOP_OFFSET) current = turn
          else break
        }
        // The running turn has no turn-tail yet: while the reader is pinned at
        // the bottom, treat the newest turn as the visible one.
        if (port.scrollTop + port.clientHeight >= port.scrollHeight - 24) {
          current = turnOrder[turnOrder.length - 1] ?? current
        }
        setActiveTurn(current)
      })
    }
    updateActive()
    const port = scrollport()
    port?.addEventListener('scroll', updateActive, { passive: true })
    const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(updateActive)
    if (port !== null) observer?.observe(port, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(frame)
      port?.removeEventListener('scroll', updateActive)
      observer?.disconnect()
    }
  }, [orderKey])

  if (!settings.turnRailEnabled || turnOrder.length < 2 || frame === null || frame.height <= 0) return null

  const jumpTo = (turn: number): void => {
    const port = scrollport()
    if (port === null) return
    const anchor = port.querySelector<HTMLElement>(`[data-turn-start="${turn}"]`)
      ?? port.querySelector<HTMLElement>(`[data-turn-tail="${turn}"]`)
    if (anchor !== null) {
      anchor.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    const index = turnOrder.indexOf(turn)
    if (index < 0) return
    const ratio = turnOrder.length > 1 ? index / (turnOrder.length - 1) : 0
    port.scrollTop = ratio * Math.max(0, port.scrollHeight - port.clientHeight)
  }

  return createPortal(
    <div className="dsh-turn-rail" style={{ left: frame.left, top: frame.top, height: frame.height }} aria-hidden="false">
      <div className="dsh-turn-rail-track">
        {turnOrder.map(turn => {
          const running = timeline.turns.get(turn)?.status === 'open'
          return (
            <button
              key={turn}
              type="button"
              className={`dsh-turn-bar${turn === activeTurn ? ' active' : ''}${running ? ' running' : ''}`}
              aria-label={`跳转到第 ${turn + 1} 轮`}
              onClick={() => { jumpTo(turn) }}
              onMouseEnter={() => { setHoverTurn(turn) }}
              onMouseLeave={() => { setHoverTurn(null) }}
            >
              {hoverTurn === turn ? (
                <span className="dsh-turn-rail-tip">
                  <span className="dsh-turn-rail-tip-title">
                    第 {turn + 1} 轮
                    {running ? ' · 运行中' : ''}
                  </span>
                  <span className="dsh-turn-rail-tip-summary">
                    {turnSummaries.get(turn) ?? '（无文字摘要）'}
                  </span>
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}

function TurnUiSettingsCard(props: {
  useTurnUi: <R>(selector: (snapshot: TurnUiClientSettings) => R) => R
  set: (field: string, value: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const settings = props.useTurnUi(snapshot => snapshot)
  return (
    <li className="dsh-turn-ui-card">
      <button type="button" className="dsh-turn-ui-card-header" aria-expanded={open} onClick={() => { setOpen(!open) }}>
        <span>轮次导航条</span>
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
          在聊天区左侧显示可点击跳转的轮次短横杠
        </div>
      </button>
      {open ? (
        <div className="dsh-turn-ui-card-body">
          <label className="dsh-turn-ui-toggle">
            <input type="checkbox" checked={settings.turnRailEnabled} onChange={event => { props.set('turnRailEnabled', event.currentTarget.checked) }} />
            显示左侧轮次导航条
          </label>
        </div>
      ) : null}
    </li>
  )
}

export function apply(ctx: ClientContext): void {
  let settingsScope: SettingsScope<unknown> | undefined
  try {
    settingsScope = ctx.settingsScope.bind({ namespace: 'dsh-turn-ui' }) as SettingsScope<unknown>
    const updateSettings = (): void => {
      const snap = settingsScope!.getSnapshot()
      const value = (snap.value ?? {}) as Record<string, unknown>
      const next: TurnUiClientSettings = {
        turnRailEnabled: value.turnRailEnabled !== false,
      }
      clientSettingsStore.set(next)
      document.documentElement.dataset.turnRailDisabled = next.turnRailEnabled ? '0' : '1'
    }
    updateSettings()
    settingsScope.subscribe(updateSettings)
  } catch (error) {
    console.error('[dsh-turn-ui] settings scope unavailable:', error)
  }

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-turn-rail',
    order: 0,
  }, TurnRail))

  try {
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'dsh-turn-ui',
      order: 60,
      inject: () => ({
        hooks: { turnUi: clientSettingsStore },
        set: (field: string, value: unknown) => {
          if (settingsScope !== undefined) void settingsScope.set(field, value)
        },
        clear: (field: string) => {
          if (settingsScope !== undefined) void settingsScope.unset(field)
        },
      }),
    }, TurnUiSettingsCard))
  } catch (error) {
    console.error('[dsh-turn-ui] settings card unavailable:', error)
  }
}
