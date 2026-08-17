/**
 * dsh-turn-ui — client half: left-edge floating turn navigation rail.
 *
 * Registered into `conversation.session.header.utilities` (session scope) and
 * rendered through a portal so the fixed rail never participates in the header
 * layout. Clicking a tick jumps to the matching `data-turn-start` anchor added
 * by the TurnFold core patch, falling back to proportional scroll for turns
 * outside the paged window.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
  turnFoldEnabled: boolean
}

interface ClientSettingsStore {
  current: TurnUiClientSettings
  listeners: Set<() => void>
  getSnapshot(): TurnUiClientSettings
  subscribe(listener: () => void): () => void
  set(next: TurnUiClientSettings): void
}

const clientSettingsStore: ClientSettingsStore = {
  current: { turnFoldEnabled: true },
  listeners: new Set<() => void>(),
  getSnapshot(): TurnUiClientSettings {
    return this.current
  },
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  },
  set(next: TurnUiClientSettings): void {
    if (next.turnFoldEnabled === this.current.turnFoldEnabled) return
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

function scrollport(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-conversation-scroll]')
}

function chatFlow(port: HTMLElement | null): HTMLElement | null {
  return port?.querySelector<HTMLElement>('[data-chat-flow]') ?? null
}

function ensureStyles(): void {
  const id = 'dsh-turn-rail-styles'
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = `
.dsh-turn-rail{position:fixed;z-index:1300;width:15px;pointer-events:none;transition:width .12s ease}
.dsh-turn-rail:hover{width:28px}
.dsh-turn-rail-track{position:absolute;inset:0;display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:8px 0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-label-caption) transparent;pointer-events:auto}
.dsh-turn-rail-track::-webkit-scrollbar{width:4px}
.dsh-turn-rail-track::-webkit-scrollbar-thumb{background:var(--dsw-alias-label-caption);border-radius:2px}
.dsh-turn-rail-track::-webkit-scrollbar-track{background:transparent}
.dsh-turn-slot{position:relative;flex:0 0 14px;width:100%;height:14px;border:0;padding:0;background:transparent;display:flex;align-items:center;cursor:pointer}
.dsh-turn-bar-inner{display:block;width:100%;height:4px;background:var(--dsw-alias-label-caption);opacity:.55;transition:opacity .12s,background .12s}
.dsh-turn-slot:hover .dsh-turn-bar-inner,.dsh-turn-slot.active .dsh-turn-bar-inner{opacity:1;background:var(--dsw-alias-label-primary)}
.dsh-turn-slot.running .dsh-turn-bar-inner{animation:dsh-turn-bar-pulse 1.2s ease-in-out infinite}
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

// ===== TurnFoldAdapter: external DOM adapter, no DSH core changes =====

interface FoldGroup {
  turn: number
  processKeys: readonly string[]
  running: boolean
  interrupted: boolean
  toolCount: number
  durationMs: number | null
}

const foldStyledRows = new Set<HTMLElement>()
const foldOriginalStyles = new WeakMap<HTMLElement, string>()
const foldExpandedBySession = new Map<string, boolean>()
const foldUserToggled = new Set<string>()
let foldApplying = false

function ensureFoldStyles(): void {
  const id = 'dsh-turn-fold-adapter-styles'
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = `
.dsh-turn-fold-overlay{position:absolute;z-index:40;pointer-events:none;box-sizing:border-box}
.dsh-turn-fold-overlay-btn{pointer-events:auto;appearance:none;display:flex;align-items:center;gap:8px;width:100%;height:22px;border:0;border-bottom:1px solid var(--dsw-alias-border-l2);border-radius:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:11px/1.5 system-ui;cursor:pointer;text-align:left;padding:0 2px}
.dsh-turn-fold-overlay.collapsed .dsh-turn-fold-overlay-btn{height:26px}
.dsh-turn-fold-overlay.expanded .dsh-turn-fold-overlay-btn{width:auto;border-bottom-color:transparent;padding:0 8px 0 0}
.dsh-turn-fold-overlay-btn:hover{color:var(--dsw-alias-label-primary)}
.dsh-turn-fold-dot{flex:none;width:2px;height:10px;border-radius:0;background:var(--dsw-alias-state-success-primary)}
.dsh-turn-fold-overlay.running .dsh-turn-fold-dot{background:var(--dsw-alias-state-business-primary);animation:dsh-turn-fold-pulse 1.2s ease-in-out infinite}
.dsh-turn-fold-overlay.interrupted .dsh-turn-fold-dot{background:var(--dsw-alias-state-error-primary)}
.dsh-turn-fold-label{flex:none;font-weight:600}
.dsh-turn-fold-meta{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
@keyframes dsh-turn-fold-pulse{0%,100%{opacity:1}50%{opacity:.35}}
`
  document.head.append(style)
}

function turnOfNode(node: unknown): number | null {
  if (node === null || typeof node !== 'object') return null
  const location = (node as { location?: unknown }).location as {
    kind?: unknown
    turn?: { turn?: unknown }
  } | undefined
  if (location?.kind === 'step' || location?.kind === 'turn') {
    const turn = location.turn?.turn
    return typeof turn === 'number' ? turn : null
  }
  return null
}

function buildFoldGroups(chat: unknown): FoldGroup[] {
  const snapshot = chat as {
    order?: readonly string[]
    nodes?: ReadonlyMap<string, unknown>
    timeline?: { turns?: ReadonlyMap<number, { status?: string; start?: { time?: number }; end?: { time?: number } }> }
    locations?: { getTurn?: (turn: number) => readonly string[] | undefined }
  }
  const order = snapshot.order ?? []
  const nodes = snapshot.nodes ?? new Map<string, unknown>()
  const turns = snapshot.timeline?.turns ?? new Map<number, { status?: string; start?: { time?: number }; end?: { time?: number } }>()

  const closingSeqByTurn = new Map<number, number>()
  const finalKeyByTurn = new Map<number, string>()
  const keysByTurn = new Map<number, string[]>()
  for (const key of order) {
    const node = nodes.get(key)
    const turn = turnOfNode(node)
    if (turn === null) continue
    const list = keysByTurn.get(turn) ?? []
    list.push(key)
    keysByTurn.set(turn, list)
    const record = node as { kind?: unknown; data?: { closing?: { finalNode?: { seq?: unknown } }; finalNode?: { seq?: unknown } } }
    if (record.kind === 'turn-tail') {
      const seq = record.data?.closing?.finalNode?.seq
      if (typeof seq === 'number') closingSeqByTurn.set(turn, seq)
    }
  }
  for (const key of order) {
    const node = nodes.get(key)
    const turn = turnOfNode(node)
    if (turn === null) continue
    const record = node as { kind?: unknown; data?: { finalNode?: { seq?: unknown } } }
    if (record.kind === 'assistant-step') {
      const seq = record.data?.finalNode?.seq
      if (typeof seq === 'number' && seq === closingSeqByTurn.get(turn)) finalKeyByTurn.set(turn, key)
    }
  }

  const keepOutside = new Set(['user', 'steering', 'command', 'turn-tail'])
  const groups: FoldGroup[] = []
  for (const [turn, keys] of keysByTurn) {
    const processKeys = keys.filter(key => {
      const node = nodes.get(key)
      if (node === undefined || key === finalKeyByTurn.get(turn)) return false
      const kind = (node as { kind?: string }).kind ?? ''
      return !keepOutside.has(kind)
    })
    if (processKeys.length === 0) continue
    const toolCount = processKeys.filter(key => (nodes.get(key) as { kind?: string } | undefined)?.kind === 'tool-call').length
    const interrupted = processKeys.some(key => {
      const record = nodes.get(key) as { kind?: string; data?: { status?: string } } | undefined
      return record?.kind === 'assistant-step' && record.data?.status === 'interrupted'
    })
    const info = turns.get(turn)
    const durationMs = info?.start?.time !== undefined && info?.end?.time !== undefined
      ? Math.max(0, info.end.time - info.start.time)
      : null
    groups.push({
      turn,
      processKeys,
      running: info?.status === 'open',
      interrupted,
      toolCount,
      durationMs,
    })
  }
  return groups
}

function restoreFoldRows(): void {
  for (const row of foldStyledRows) {
    const original = foldOriginalStyles.get(row)
    if (original === undefined) row.removeAttribute('style')
    else if (row.style.cssText !== original) row.style.cssText = original
  }
  foldStyledRows.clear()
}

function setFoldRowStyle(row: HTMLElement, cssText: string): void {
  if (!foldOriginalStyles.has(row)) foldOriginalStyles.set(row, row.style.cssText)
  foldStyledRows.add(row)
  if (row.style.cssText !== cssText) row.style.cssText = cssText
}

function clearFoldOverlays(sessionId: string): void {
  const port = scrollport()
  port?.querySelectorAll<HTMLElement>('.dsh-turn-fold-overlay').forEach(overlay => {
    if (overlay.dataset.sessionId === sessionId) overlay.remove()
  })
}

function stateKey(sessionId: string, turn: number): string {
  return `${sessionId}:${turn}`
}

function formatFoldDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}

const foldButtons = new WeakMap<HTMLElement, HTMLButtonElement>()

function updateFoldButton(
  overlay: HTMLElement,
  button: HTMLButtonElement,
  group: FoldGroup,
  expanded: boolean,
  onClick: () => void,
): void {
  const label = group.running ? '任务进行中' : group.interrupted ? '任务已中断' : '任务过程'
  const parts = [`${group.processKeys.length} 个过程`]
  if (group.toolCount > 0) parts.push(`${group.toolCount} 个工具`)
  if (group.durationMs !== null) parts.push(formatFoldDuration(group.durationMs))
  const meta = parts.join(' · ') + (expanded ? ' · 点击收起' : ' · 点击展开')
  button.type = 'button'
  button.className = 'dsh-turn-fold-overlay-btn'
  button.setAttribute('aria-expanded', String(expanded))
  button.onclick = onClick
  if (button.dataset.label !== label || button.dataset.meta !== meta || button.dataset.expanded !== String(expanded)) {
    button.dataset.label = label
    button.dataset.meta = meta
    button.dataset.expanded = String(expanded)
    button.replaceChildren()
    const dot = document.createElement('span')
    dot.className = 'dsh-turn-fold-dot'
    const labelNode = document.createElement('span')
    labelNode.className = 'dsh-turn-fold-label'
    labelNode.textContent = label
    const metaNode = document.createElement('span')
    metaNode.className = 'dsh-turn-fold-meta'
    metaNode.textContent = meta
    button.append(dot, labelNode, metaNode)
  }
}

function applyFold(chat: unknown, sessionId: string, enabled: boolean): void {
  const port = scrollport()
  const flow = chatFlow(port)
  if (port === null || flow === null) {
    // Non-chat conversation view (trajectory, schedule, …): the native flow
    // is unmounted but our absolutely-positioned fold headers live directly in
    // the scrollport and would otherwise survive the tab switch as stale UI.
    restoreFoldRows()
    clearFoldOverlays(sessionId)
    return
  }
  if (!enabled) {
    restoreFoldRows()
    clearFoldOverlays(sessionId)
    return
  }
  if (getComputedStyle(port).position === 'static') port.style.position = 'relative'

  const groups = buildFoldGroups(chat)
  const liveTurns = new Set(groups.map(group => group.turn))
  port.querySelectorAll<HTMLElement>('.dsh-turn-fold-overlay').forEach(overlay => {
    if (overlay.dataset.sessionId === sessionId && !liveTurns.has(Number(overlay.dataset.turn))) overlay.remove()
  })

  const portRect = port.getBoundingClientRect()
  const currentRows = new Set<HTMLElement>()
  for (const group of groups) {
    const firstRow = flow.querySelector<HTMLElement>(`[data-chat-anchor-key="${CSS.escape(group.processKeys[0] ?? '')}"]`)
    if (firstRow === null) continue
    const rows = group.processKeys
      .map(key => flow.querySelector<HTMLElement>(`[data-chat-anchor-key="${CSS.escape(key)}"]`))
      .filter((row): row is HTMLElement => row !== null)
    rows.forEach(row => currentRows.add(row))
    const key = stateKey(sessionId, group.turn)
    const expanded = foldExpandedBySession.get(key) ?? group.running

    // Never restyle a running turn: streaming and React both mutate these rows
    // at high frequency, which is the source of the thinking flicker. Leave
    // the native flow untouched until the turn closes.
    if (group.running) {
      rows.forEach(row => {
        const original = foldOriginalStyles.get(row)
        if (original === undefined) row.removeAttribute('style')
        else if (row.style.cssText !== original) row.style.cssText = original
        foldStyledRows.delete(row)
      })
      port.querySelector(`.dsh-turn-fold-overlay[data-session-id="${sessionId}"][data-turn="${group.turn}"]`)?.remove()
      continue
    }

    rows.forEach((row, index) => {
      if (!expanded) {
        const base = foldOriginalStyles.get(row) ?? ''
        if (index === 0) setFoldRowStyle(row, `${base};height:36px!important;min-height:36px!important;overflow:hidden!important;opacity:0!important`)
        else setFoldRowStyle(row, `${base};display:none!important`)
      } else {
        const base = foldOriginalStyles.get(row) ?? ''
        if (index === 0) setFoldRowStyle(row, `${base};padding-top:30px!important`)
        else setFoldRowStyle(row, base)
      }
    })

    let overlay = port.querySelector<HTMLElement>(`.dsh-turn-fold-overlay[data-session-id="${sessionId}"][data-turn="${group.turn}"]`)
    if (overlay === null) {
      overlay = document.createElement('div')
      overlay.className = 'dsh-turn-fold-overlay'
      overlay.dataset.sessionId = sessionId
      overlay.dataset.turn = String(group.turn)
      port.append(overlay)
    }
    const rowRect = firstRow.getBoundingClientRect()
    const top = `${rowRect.top - portRect.top + port.scrollTop}px`
    const left = `${rowRect.left - portRect.left}px`
    const width = `${Math.max(160, rowRect.width)}px`
    if (overlay.style.top !== top) overlay.style.top = top
    if (overlay.style.left !== left) overlay.style.left = left
    if (overlay.style.width !== width) overlay.style.width = width
    overlay.classList.toggle('collapsed', !expanded)
    overlay.classList.toggle('expanded', expanded)
    overlay.classList.toggle('running', group.running)
    overlay.classList.toggle('interrupted', group.interrupted)

    let button = foldButtons.get(overlay)
    if (button === undefined) {
      button = document.createElement('button')
      overlay.append(button)
      foldButtons.set(overlay, button)
    }
    updateFoldButton(overlay, button, group, expanded, () => {
      const current = foldExpandedBySession.get(key) ?? group.running
      foldExpandedBySession.set(key, !current)
      foldUserToggled.add(key)
      applyFold(chat, sessionId, enabled)
    })
  }

  for (const row of foldStyledRows) {
    if (!currentRows.has(row)) {
      const original = foldOriginalStyles.get(row)
      if (original === undefined) row.removeAttribute('style')
      else if (row.style.cssText !== original) row.style.cssText = original
      foldStyledRows.delete(row)
    }
  }
}

function TurnFoldAdapter({ useSession, sessionId }: RailProps) {
  const settings = useSyncExternalStore(subscribeClientSettings, getClientSettingsSnapshot)
  const chat = useSession(snapshot => snapshot.chat)
  // Keep the latest snapshot in a ref instead of as an effect dependency: the
  // chat snapshot gets a fresh object identity on every streaming flush, and a
  // chat-keyed effect would tear down + restore + re-collapse rows each token.
  const chatRef = useRef(chat)
  chatRef.current = chat
  useEffect(() => {
    ensureFoldStyles()
    let raf = 0
    let interval = 0
    let observer: MutationObserver | undefined
    let observedPort: HTMLElement | null = null
    const run = (): void => {
      if (foldApplying) return
      foldApplying = true
      try { applyFold(chatRef.current, sessionId, settings.turnFoldEnabled) } finally { foldApplying = false }
    }
    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(run)
    }
    const attach = (port: HTMLElement): void => {
      if (observedPort === port) return
      observedPort = port
      observer = new MutationObserver(schedule)
      observer.observe(port, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'data-chat-anchor-key'] })
    }
    // Interval doubles as a reconciliation pass (labels, durations, row
    // presence) for snapshot changes that do not produce DOM mutations.
    interval = window.setInterval(() => {
      const port = scrollport()
      if (port !== null) {
        attach(port)
        schedule()
      }
    }, 500)
    schedule()
    const onResize = (): void => schedule()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(interval)
      window.removeEventListener('resize', onResize)
      observer?.disconnect()
      restoreFoldRows()
      clearFoldOverlays(sessionId)
    }
  }, [sessionId, settings.turnFoldEnabled])
  return null
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
        <span>轮次折叠容器</span>
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
          把工具调用 / 步骤等过程输出折叠成容器卡片
        </div>
      </button>
      {open ? (
        <div className="dsh-turn-ui-card-body">
          <label className="dsh-turn-ui-toggle">
            <input type="checkbox" checked={settings.turnFoldEnabled} onChange={event => { props.set('turnFoldEnabled', event.currentTarget.checked) }} />
            按轮折叠过程输出（上下文注入 / 思考 / 工具 / 产物）
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
        turnFoldEnabled: value.turnFoldEnabled !== false,
      }
      clientSettingsStore.set(next)
      document.documentElement.dataset.turnFoldDisabled = next.turnFoldEnabled ? '0' : '1'
    }
    updateSettings()
    settingsScope.subscribe(updateSettings)
  } catch (error) {
    console.error('[dsh-turn-ui] settings scope unavailable:', error)
  }

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-turn-fold-adapter',
    order: 5,
  }, TurnFoldAdapter))

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
