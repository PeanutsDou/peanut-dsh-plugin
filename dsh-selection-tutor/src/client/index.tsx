/**
 * dsh-selection-tutor — client half.
 *
 * - Listens for text selection in the main conversation and shows a floating
 *   "解释 / 翻译" menu near the selection.
 * - Opens a draggable/resizable floating window over the main window.
 * - The host creates one hidden archived session per window; closing the
 *   window disposes it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { api, type StartResult, type TutorBlock, type TutorEffort, type TutorMessage, type TutorMode } from './api.ts'

export const name = 'dsh-selection-tutor-client'
export const inject = ['sessions', 'slots']

interface SelectionAnchor { text: string; x: number; y: number }
interface WindowPosition { left: number; top: number; width: number; height: number }

const POSITION_KEY = 'dsh-selection-tutor-window-position'
const DEFAULT_POSITION: WindowPosition = { left: 96, top: 72, width: 440, height: 540 }
const MIN_WIDTH = 360
const MIN_HEIGHT = 260
const MAX_FRACTION = 0.86

const EFFORT_LABELS: Record<TutorEffort, string> = {
  off: '关闭思考',
  low: '低',
  high: '高',
  max: '最大',
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function readPosition(): WindowPosition {
  try {
    const raw = localStorage.getItem(POSITION_KEY)
    if (raw === null) return { ...DEFAULT_POSITION }
    const parsed = JSON.parse(raw) as Partial<WindowPosition>
    if (Number.isFinite(parsed.left) && Number.isFinite(parsed.top) && Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) {
      const width = clamp(Number(parsed.width), MIN_WIDTH, Math.max(MIN_WIDTH, window.innerWidth * MAX_FRACTION))
      const height = clamp(Number(parsed.height), MIN_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight * MAX_FRACTION))
      return {
        left: clamp(Number(parsed.left), 0, Math.max(0, window.innerWidth - width)),
        top: clamp(Number(parsed.top), 0, Math.max(0, window.innerHeight - height)),
        width,
        height,
      }
    }
  } catch { /* corrupted or storage unavailable */ }
  return { ...DEFAULT_POSITION }
}

function persistPosition(position: WindowPosition): void {
  try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)) } catch { /* storage unavailable */ }
}

function ensureStyles(): void {
  const id = 'dsh-selection-tutor-styles'
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = `
.dsh-tutor-menu{position:fixed;z-index:2147483000;display:flex;gap:6px;padding:5px;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#1e2128);box-shadow:0 10px 30px rgba(0,0,0,.3);font:12px system-ui;transform:translate(-50%,-100%)}
.dsh-tutor-menu button{appearance:none;border:1px solid transparent;border-radius:7px;padding:5px 12px;background:transparent;color:var(--dsw-alias-label-primary,#e7e9ee);cursor:pointer;font:inherit}
.dsh-tutor-menu button:hover{background:var(--dsw-alias-bg-layer-3,#2a2e38);border-color:var(--dsw-alias-border-l2,#3a3f4b)}
.dsh-tutor-window{position:fixed;z-index:2147483001;display:flex;flex-direction:column;min-width:320px;min-height:240px;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:14px;background:var(--dsw-alias-bg-layer-2,#1e2128);color:var(--dsw-alias-label-primary,#e7e9ee);box-shadow:0 22px 70px rgba(0,0,0,.45);overflow:hidden;font:13px/1.6 system-ui}
.dsh-tutor-title{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#3a3f4b);background:var(--dsw-alias-bg-layer-3,#252932);cursor:grab;user-select:none}
.dsh-tutor-title.dragging{cursor:grabbing}
.dsh-tutor-title-main{min-width:0;flex:1}
.dsh-tutor-title-mode{font-weight:600}
.dsh-tutor-title-selection{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#9aa2b1);font-size:12px}
.dsh-tutor-close{appearance:none;border:1px solid transparent;border-radius:7px;padding:2px 9px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa2b1);cursor:pointer;font:inherit}
.dsh-tutor-close:hover{background:color-mix(in srgb,var(--dsw-alias-label-error,#ef4444) 16%,transparent);color:var(--dsw-alias-label-error,#ef4444)}
.dsh-tutor-meta{display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#3a3f4b);font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa2b1);background:var(--dsw-alias-bg-layer-2,#1e2128)}
.dsh-tutor-meta select{appearance:none;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:7px;padding:2px 8px;background:var(--dsw-alias-bg-layer-3,#2a2e38);color:inherit;font:inherit}
.dsh-tutor-messages{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;min-height:0}
.dsh-tutor-msg{max-width:92%;border-radius:12px;padding:8px 11px;white-space:normal;overflow-wrap:anywhere}
.dsh-tutor-msg.user{align-self:flex-end;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 18%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 32%,transparent)}
.dsh-tutor-msg.assistant{align-self:flex-start;background:var(--dsw-alias-bg-layer-3,#2a2e38);border:1px solid var(--dsw-alias-border-l2,#3a3f4b)}
.dsh-tutor-msg.reasoning{color:var(--dsw-alias-label-tertiary,#9aa2b1);font-size:12px;white-space:pre-wrap}
.dsh-tutor-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#9aa2b1)}
 .dsh-tutor-tool{margin:2px 0;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:8px;padding:4px 8px;background:var(--dsw-alias-bg-layer-2,#1e2128);font-size:12px}.dsh-tutor-tool summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.dsh-tutor-tool pre{margin:6px 0 0;padding:6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,#2a2e38);white-space:pre-wrap;overflow:auto;max-height:160px}.dsh-tutor-error{margin:0 12px 8px;padding:7px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-error,#ef4444) 14%,transparent);color:var(--dsw-alias-label-error,#ef4444);font-size:12px}
.dsh-tutor-composer{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l2,#3a3f4b)}
.dsh-tutor-composer textarea{flex:1;resize:none;height:56px;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,#1e2128);color:inherit;font:inherit;line-height:1.5}
.dsh-tutor-actions{display:flex;flex-direction:column;gap:6px}
.dsh-tutor-actions button{appearance:none;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:9px;padding:6px 12px;background:var(--dsw-alias-bg-layer-3,#2a2e38);color:inherit;cursor:pointer;font:inherit;white-space:nowrap}
.dsh-tutor-actions button:disabled{opacity:.45;cursor:default}
.dsh-tutor-actions button.primary{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:var(--dsw-alias-brand-primary,#3b82f6);color:#fff}
.dsh-tutor-resize{position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,var(--dsw-alias-label-dimmed,#6b7280) 50%);opacity:.7}
.dsh-tutor-resize:hover{opacity:1}
`
  document.head.append(style)
}

function SettingsCard(): JSX.Element {
  const [effort, setEffort] = useState<TutorEffort>('off')
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.settingsGet().then((result) => {
      if (!result.ok) return
      const value = result.value.value as { defaultReasoningEffort?: unknown } | null | undefined
      if (value !== null && value !== undefined) {
        const raw = value.defaultReasoningEffort
        if (raw === 'off' || raw === 'low' || raw === 'high' || raw === 'max') setEffort(raw)
      }
      if (typeof result.value.revision === 'number') setRevision(result.value.revision)
    })
  }, [])

  const update = async (next: TutorEffort): Promise<void> => {
    setEffort(next)
    setSaving(true)
    setError(null)
    const result = await api.settingsUpdate({ defaultReasoningEffort: next }, revision)
    setSaving(false)
    if (result.ok) {
      if (typeof result.value.revision === 'number') setRevision(result.value.revision)
    } else {
      setError(result.error.message)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
        <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>小窗默认思考强度</span>
        <select value={effort} disabled={saving} onChange={event => { void update(event.currentTarget.value as TutorEffort) }}>
          {(Object.keys(EFFORT_LABELS) as TutorEffort[]).map(id => (
            <option key={id} value={id}>{EFFORT_LABELS[id]}</option>
          ))}
        </select>
      </label>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
        仅控制新建学习小窗的思考强度；小窗内仍可临时切换，模型固定继承当前主会话，不可更换。
      </p>
      {error !== null ? <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-error)' }}>{error}</p> : null}
    </div>
  )
}

/** Selection listener: show the floating menu right above the selected text. */
function SelectionMenu({ current, onPick }: { current: string | undefined; onPick: (mode: TutorMode, text: string) => void }) {
  const [local, setLocal] = useState<SelectionAnchor | null>(null)

  useEffect(() => {
    const compute = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) { setLocal(null); return }
      const text = selection.toString().trim()
      if (text === '') { setLocal(null); return }
      const range = selection.getRangeAt(0)
      const node = range.startContainer
      const element = node.nodeType === 1 ? (node as Element) : node.parentElement
      if (element !== null && element.closest('input, textarea, [contenteditable="true"]') !== null) { setLocal(null); return }
      if (element !== null && element.closest('[data-dsh-selection-tutor]') !== null) { setLocal(null); return }
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) { setLocal(null); return }
      setLocal({ text, x: rect.left + rect.width / 2, y: rect.top })
    }
    const onMouseUp = (): void => { window.setTimeout(compute, 0) }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', compute)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', compute)
    }
  }, [])

  const pick = (mode: TutorMode): void => {
    if (local === null) return
    const text = local.text
    setLocal(null)
    onPick(mode, text)
  }

  if (local === null || current === undefined) return null
  return (
    <div className="dsh-tutor-menu" style={{ left: local.x, top: local.y - 8 }}>
      <button type="button" onClick={() => { pick('explain') }}>解释</button>
      <button type="button" onClick={() => { pick('translate') }}>翻译</button>
    </div>
  )
}

function TutorWindow({ win, onClose }: { win: StartResult & { mode: TutorMode; selectionText: string; parentSessionId: string }; onClose: () => void }) {
  const [position, setPosition] = useState<WindowPosition>(() => readPosition())
  const [messages, setMessages] = useState<TutorMessage[]>([])
  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState(win.autoSend)
  const [effort, setEffort] = useState<TutorEffort>(win.reasoningEffort)
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: WindowPosition } | null>(null)
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; origin: WindowPosition } | null>(null)
  const latestPosition = useRef(position)
  latestPosition.current = position

  const refresh = useCallback(async (): Promise<void> => {
    const result = await api.history({ windowId: win.windowId })
    if (!result.ok) {
      if (result.error.code === 'window-unavailable') onClose()
      else setError(result.error.message)
      return
    }
    setError(null)
    setMessages(result.value.messages)
    setRunning(result.value.running)
  }, [win.windowId, onClose])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 700)
    return () => { window.clearInterval(timer) }
  }, [refresh])

  useEffect(() => {
    const onResizeViewport = (): void => {
      setPosition(current => {
        const maxWidth = Math.max(MIN_WIDTH, window.innerWidth * MAX_FRACTION)
        const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight * MAX_FRACTION)
        return {
          left: clamp(current.left, 0, Math.max(0, window.innerWidth - current.width)),
          top: clamp(current.top, 0, Math.max(0, window.innerHeight - current.height)),
          width: clamp(current.width, MIN_WIDTH, maxWidth),
          height: clamp(current.height, MIN_HEIGHT, maxHeight),
        }
      })
    }
    window.addEventListener('resize', onResizeViewport)
    return () => { window.removeEventListener('resize', onResizeViewport) }
  }, [])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || running) return
    setDraft('')
    setRunning(true)
    setError(null)
    const result = await api.followup({ windowId: win.windowId, text })
    if (!result.ok) {
      setRunning(false)
      setError(result.error.message)
      return
    }
    await refresh()
  }

  const stop = async (): Promise<void> => {
    const result = await api.stop({ windowId: win.windowId })
    if (!result.ok) setError(result.error.message)
    setRunning(false)
  }

  const changeEffort = async (next: TutorEffort): Promise<void> => {
    setEffort(next)
    const result = await api.effort({ windowId: win.windowId, reasoningEffort: next })
    if (!result.ok) {
      setError(result.error.message)
      setEffort(win.reasoningEffort)
    }
  }

  const close = async (): Promise<void> => {
    if (closing) return
    if (running) {
      const ok = window.confirm('小窗正在生成内容，关闭会取消当前回答并销毁这个临时分支。确定关闭吗？')
      if (!ok) return
    }
    setClosing(true)
    await api.dispose({ windowId: win.windowId })
    onClose()
  }

  const onTitlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: latestPosition.current }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onTitlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const next: WindowPosition = {
      ...drag.origin,
      left: clamp(drag.origin.left + event.clientX - drag.startX, 0, Math.max(0, window.innerWidth - drag.origin.width)),
      top: clamp(drag.origin.top + event.clientY - drag.startY, 0, Math.max(0, window.innerHeight - drag.origin.height)),
    }
    latestPosition.current = next
    setPosition(next)
  }
  const onTitlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    persistPosition(latestPosition.current)
  }

  const onResizePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: latestPosition.current }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
  }
  const onResizePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const resize = resizeRef.current
    if (resize === null || resize.pointerId !== event.pointerId) return
    const next: WindowPosition = {
      ...resize.origin,
      width: clamp(resize.origin.width + event.clientX - resize.startX, MIN_WIDTH, window.innerWidth * MAX_FRACTION),
      height: clamp(resize.origin.height + event.clientY - resize.startY, MIN_HEIGHT, window.innerHeight * MAX_FRACTION),
    }
    latestPosition.current = next
    setPosition(next)
  }
  const onResizePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizeRef.current?.pointerId !== event.pointerId) return
    resizeRef.current = null
    persistPosition(latestPosition.current)
  }

  const modeLabel = win.mode === 'explain' ? '解释' : '翻译'
  const selectionPreview = win.selectionText.replace(/\s+/g, ' ').slice(0, 28)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    messagesRef.current = node
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [])
  useEffect(() => {
    const node = messagesRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [messages])

  return (
    <section className="dsh-tutor-window" data-dsh-selection-tutor="" style={{ left: position.left, top: position.top, width: position.width, height: position.height }}>
      <div className="dsh-tutor-title" onPointerDown={onTitlePointerDown} onPointerMove={onTitlePointerMove} onPointerUp={onTitlePointerUp} onPointerCancel={onTitlePointerUp}>
        <div className="dsh-tutor-title-main">
          <span className="dsh-tutor-title-mode">{modeLabel}小窗</span>
          <span className="dsh-tutor-title-selection">{selectionPreview === '' ? '（空选择）' : `“${selectionPreview}”`}</span>
        </div>
        <button type="button" className="dsh-tutor-close" disabled={closing} onPointerDown={event => { event.stopPropagation() }} onClick={() => { void close() }}>关闭</button>
      </div>
      <div className="dsh-tutor-meta">
        <span>模型：{win.model}（继承主会话）</span>
        <label>
          思考强度
          <select value={effort} onChange={event => { void changeEffort(event.currentTarget.value as TutorEffort) }}>
            {(Object.keys(EFFORT_LABELS) as TutorEffort[]).map(id => <option key={id} value={id}>{EFFORT_LABELS[id]}</option>)}
          </select>
        </label>
        {running ? <span>生成中…</span> : null}
      </div>
      <div className="dsh-tutor-messages" ref={scrollRef}>
        {messages.length === 0 ? <div className="dsh-tutor-empty">{win.autoSend ? '正在准备临时会话…' : '小窗已就绪，请基于选中的内容提问。'}</div> : null}
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`dsh-tutor-msg ${message.role}`}>
            {message.blocks.map((block, blockIndex) => {
              if (block.type === 'reasoning') return <div key={blockIndex} className="dsh-tutor-msg reasoning">{block.text}</div>
              if (block.type === 'error') return <div key={blockIndex} style={{ color: 'var(--dsw-alias-label-error,#ef4444)', whiteSpace: 'pre-wrap' }}>{block.text}</div>
              if (block.type === 'tool') {
                return (
                  <details key={blockIndex} className="dsh-tutor-tool">
                    <summary>{block.isError === true ? '⚠ ' : '🔧 '}{block.name}</summary>
                    {block.arguments !== undefined ? <pre>{block.arguments}</pre> : null}
                    {block.result !== undefined ? <pre>{block.result}</pre> : null}
                  </details>
                )
              }
              if (message.role === 'assistant') return <div key={blockIndex}><MarkdownText text={block.text} /></div>
              return <div key={blockIndex} style={{ whiteSpace: 'pre-wrap' }}>{block.text}</div>
            })}
          </div>
        ))}
      </div>
      {error !== null ? <p className="dsh-tutor-error">{error}</p> : null}
      <div className="dsh-tutor-composer">
       
        <textarea
          value={draft}
          placeholder={win.mode === 'explain' ? '就选中的内容提问…' : '继续追问…'}
          onChange={event => { setDraft(event.currentTarget.value) }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="dsh-tutor-actions">
          <button type="button" className="primary" disabled={running || draft.trim() === ''} onClick={() => { void send() }}>发送</button>
          <button type="button" disabled={!running} onClick={() => { void stop() }}>停止</button>
        </div>
      </div>
      <div className="dsh-tutor-resize" onPointerDown={onResizePointerDown} onPointerMove={onResizePointerMove} onPointerUp={onResizePointerUp} onPointerCancel={onResizePointerUp} />
    </section>
  )
}

interface ActiveWindow extends StartResult {
  mode: TutorMode
  selectionText: string
  parentSessionId: string
}

function TutorRoot({ ctx }: { ctx: Context }): JSX.Element {
  const current = useSyncExternalStore(
    ctx.sessions.list.subscribe,
    () => ctx.sessions.list.getSnapshot().current,
    () => undefined,
  )
  const [win, setWin] = useState<ActiveWindow | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  useEffect(() => {
    if (win !== null && current !== win.parentSessionId) {
      void api.dispose({ windowId: win.windowId })
      setWin(null)
    }
  }, [current, win])

  const pick = useCallback(async (mode: TutorMode, text: string): Promise<void> => {
    const parentSessionId = ctx.sessions.list.getSnapshot().current
    if (parentSessionId === undefined || starting) return
    setStarting(true)
    setStartError(null)
    const result = await api.start({ parentSessionId, mode, selectionText: text, autoSend: mode === 'translate' })
    setStarting(false)
    if (result.ok) {
      setWin({ ...result.value, mode, selectionText: text, parentSessionId })
    } else {
      setStartError(result.error.message)
      if (result.error.code === 'window-exists' && win !== null) {
        // Surface the existing window; the user can close it and try again.
        setStartError('当前会话已有一个学习小窗，请先关闭它。')
      }
    }
  }, [ctx.sessions.list, starting, win])

  const close = useCallback((): void => { setWin(null) }, [])

  return (
    <>
      {startError !== null ? (
        <div className="dsh-tutor-menu" style={{ left: 16, bottom: 16, top: 'auto', transform: 'none' }}>
          <span style={{ padding: '4px 8px', color: 'var(--dsw-alias-label-error,#ef4444)' }}>{startError}</span>
          <button type="button" onClick={() => { setStartError(null) }}>知道了</button>
        </div>
      ) : null}
      <SelectionMenu current={win === null ? current : undefined} onPick={(mode, text) => { void pick(mode, text) }} />
      {win !== null ? <TutorWindow win={win} onClose={close} /> : null}
    </>
  )
}

interface ModelConfigCardShape {
  id: string
  title: string
  description?: string
  order?: number
  render: () => JSX.Element
}

interface ModelConfigRegistryShape {
  register(card: ModelConfigCardShape): () => void
  unregister(id: string): void
}

type ModelConfigWindow = Window & {
  __DSH_MODEL_CONFIG_REGISTRY__?: ModelConfigRegistryShape
  __DSH_MODEL_CONFIG_PENDING__?: ModelConfigCardShape[]
}

/** Register the tutor settings card with the shared model-config settings page. */
function registerModelConfigCard(): () => void {
  const card: ModelConfigCardShape = {
    id: 'dsh-selection-tutor',
    title: '划词学习小窗',
    description: '选中文字后弹出“解释/翻译”浮动小窗的默认思考强度。模型固定继承主会话，不提供模型切换。',
    order: 100,
    render: () => <SettingsCard />,
  }
  const win = window as unknown as ModelConfigWindow
  const registry = win.__DSH_MODEL_CONFIG_REGISTRY__
  if (registry !== undefined) return registry.register(card)
  const pending = win.__DSH_MODEL_CONFIG_PENDING__ ?? []
  win.__DSH_MODEL_CONFIG_PENDING__ = pending
  pending.push(card)
  let active = true
  return () => {
    if (!active) return
    active = false
    const index = pending.indexOf(card)
    if (index >= 0) pending.splice(index, 1)
    else win.__DSH_MODEL_CONFIG_REGISTRY__?.unregister(card.id)
  }
}

export function apply(ctx: Context): void {
  ensureStyles()
  registerModelConfigCard()

  const host = document.createElement('div')
  host.setAttribute('data-dsh-selection-tutor', '')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  root.render(<TutorRoot ctx={ctx} />)

  ctx.effect(() => {
    return () => {
      root.unmount()
      host.remove()
    }
  }, 'dsh-selection-tutor: client mount')
}
