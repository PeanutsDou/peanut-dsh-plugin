/**
 * dsh-selection-tutor — client half.
 *
 * - Listens for text selection in the main conversation and shows a floating
 *   "解释 / 翻译" menu near the selection.
 * - Opens a draggable/resizable floating window over the main window.
 * - The host creates one hidden archived session per window; closing the
 *   window disposes it.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { normalizeTutorEffort, normalizeTutorTranslateTarget, TUTOR_EFFORTS, TUTOR_PREFS_DEFAULTS, TUTOR_TRANSLATE_TARGETS, type TutorTranslateTarget } from '../settings-shared.ts'
import { api, disposeKeepalive, TUTOR_DEFAULT_EFFORT, TUTOR_DEFAULT_TRANSLATE_TARGET, type StartResult, type TutorBlock, type TutorEffort, type TutorMessage, type TutorMode } from './api.ts'

export const name = 'dsh-selection-tutor-client'
export const inject = ['sessions', 'slots']

interface SelectionAnchor { text: string; x: number; y: number; placement: 'above' | 'below'; charCount: number }
interface WindowPosition { left: number; top: number; width: number; height: number }

const STYLE_ID = 'dsh-selection-tutor-styles'
const POSITION_KEY = 'dsh-selection-tutor-window-position'
const DEFAULT_POSITION: WindowPosition = { left: 96, top: 72, width: 440, height: 540 }
const MIN_WIDTH = 360
const MIN_HEIGHT = 260
const MAX_FRACTION = 0.86
const POLL_RUNNING_MS = 700
const POLL_IDLE_MS = 5000
const ERROR_AUTO_DISMISS_MS = 8000
const SELECTION_MENU_WIDTH = 200
const SELECTION_MENU_HEIGHT = 38
const SELECTION_MENU_GAP = 8
const PIN_KEY = 'dsh-selection-tutor-pinned'

const EFFORT_LABELS: Record<TutorEffort, string> = {
  off: '关闭思考',
  high: '高',
  max: '最大',
}

const TARGET_LABELS: Record<TutorTranslateTarget, string> = {
  auto: '自动检测',
  en: '英文',
  zh: '中文',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
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
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dsh-tutor-menu{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:6px;padding:5px;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#1e2128);box-shadow:0 10px 30px rgba(0,0,0,.3);font:12px system-ui;transform:translate(-50%,-100%)}
.dsh-tutor-menu.below{transform:translate(-50%,0)}
.dsh-tutor-menu .dsh-tutor-count{flex:none;padding:0 2px;color:var(--dsw-alias-label-tertiary,#9aa2b1);white-space:nowrap}
.dsh-tutor-menu button{appearance:none;border:1px solid transparent;border-radius:7px;padding:5px 12px;background:transparent;color:var(--dsw-alias-label-primary,#e7e9ee);cursor:pointer;font:inherit}
.dsh-tutor-menu button:hover{background:var(--dsw-alias-bg-layer-3,#2a2e38);border-color:var(--dsw-alias-border-l2,#3a3f4b)}
.dsh-tutor-window{position:fixed;z-index:2147483001;display:flex;flex-direction:column;min-width:320px;min-height:240px;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:14px;background:var(--dsw-alias-bg-layer-2,#1e2128);color:var(--dsw-alias-label-primary,#e7e9ee);box-shadow:0 22px 70px rgba(0,0,0,.45);overflow:hidden;font:13px/1.6 system-ui}
.dsh-tutor-title{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#3a3f4b);background:var(--dsw-alias-bg-layer-3,#252932);cursor:grab;user-select:none;touch-action:none}
.dsh-tutor-title.dragging{cursor:grabbing}
.dsh-tutor-title-main{min-width:0;flex:1}
.dsh-tutor-title-mode{font-weight:600}
.dsh-tutor-title-selection{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#9aa2b1);font-size:12px}
.dsh-tutor-close{appearance:none;border:1px solid transparent;border-radius:7px;padding:2px 9px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa2b1);cursor:pointer;font:inherit}
.dsh-tutor-close:hover{background:color-mix(in srgb,var(--dsw-alias-label-error,#ef4444) 16%,transparent);color:var(--dsw-alias-label-error,#ef4444)}
 .dsh-tutor-window.pinned{box-shadow:0 22px 70px rgba(0,0,0,.55),0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 55%,transparent)}
 .dsh-tutor-title-actions{display:flex;align-items:center;gap:6px;flex:none}
 .dsh-tutor-title-actions button{appearance:none;border:1px solid transparent;border-radius:7px;padding:2px 9px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa2b1);cursor:pointer;font:inherit;white-space:nowrap}
 .dsh-tutor-title-actions button:hover{background:var(--dsw-alias-bg-layer-3,#2a2e38);border-color:var(--dsw-alias-border-l2,#3a3f4b)}
 .dsh-tutor-title-actions button.active{color:var(--dsw-alias-brand-primary,#7aa2ff);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 40%,transparent)}
 .dsh-tutor-title-actions button:disabled{opacity:.45;cursor:default}
.dsh-tutor-meta{display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#3a3f4b);font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa2b1);background:var(--dsw-alias-bg-layer-2,#1e2128)}
.dsh-tutor-meta select{appearance:none;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:7px;padding:2px 8px;background:var(--dsw-alias-bg-layer-3,#2a2e38);color:inherit;font:inherit}
.dsh-tutor-messages{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;min-height:0}
.dsh-tutor-msg{max-width:92%;border-radius:12px;padding:8px 11px;white-space:normal;overflow-wrap:anywhere}
.dsh-tutor-msg.user{align-self:flex-end;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 18%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 32%,transparent)}
.dsh-tutor-msg.assistant{align-self:flex-start;background:var(--dsw-alias-bg-layer-3,#2a2e38);border:1px solid var(--dsw-alias-border-l2,#3a3f4b)}
.dsh-tutor-msg.reasoning{color:var(--dsw-alias-label-tertiary,#9aa2b1);font-size:12px;white-space:pre-wrap}
.dsh-tutor-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#9aa2b1)}
 .dsh-tutor-source{margin:0;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:10px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#1e2128);font-size:12px}.dsh-tutor-source summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.dsh-tutor-source div{margin-top:6px;max-height:200px;overflow:auto;white-space:pre-wrap;color:var(--dsw-alias-label-primary)}
 .dsh-tutor-reasoning{margin:2px 0;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:8px;padding:4px 8px;background:var(--dsw-alias-bg-layer-2,#1e2128);font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa2b1)}.dsh-tutor-reasoning summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.dsh-tutor-reasoning div{margin-top:4px;max-height:220px;overflow:auto;white-space:pre-wrap}
 .dsh-tutor-tool{margin:2px 0;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:8px;padding:4px 8px;background:var(--dsw-alias-bg-layer-2,#1e2128);font-size:12px}.dsh-tutor-tool summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.dsh-tutor-tool pre{margin:6px 0 0;padding:6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,#2a2e38);white-space:pre-wrap;overflow:auto;max-height:160px}
 .dsh-tutor-copy{position:absolute;top:4px;right:4px;appearance:none;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:6px;padding:1px 7px;background:var(--dsw-alias-bg-layer-2,#1e2128);color:var(--dsw-alias-label-tertiary,#9aa2b1);cursor:pointer;font-size:11px;line-height:18px}.dsh-tutor-copy:hover{color:var(--dsw-alias-label-primary)}
 .dsh-tutor-msg.assistant{position:relative;padding-top:10px}
 .dsh-tutor-error{margin:0 12px 8px;padding:7px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-error,#ef4444) 14%,transparent);color:var(--dsw-alias-label-error,#ef4444);font-size:12px;display:flex;align-items:center;gap:8px}.dsh-tutor-error span{flex:1}.dsh-tutor-error button{appearance:none;border:0;background:none;color:inherit;cursor:pointer;font:inherit;padding:0}
.dsh-tutor-composer{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l2,#3a3f4b)}
.dsh-tutor-composer textarea{flex:1;resize:none;height:56px;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,#1e2128);color:inherit;font:inherit;line-height:1.5}
.dsh-tutor-actions{display:flex;flex-direction:column;gap:6px}
.dsh-tutor-actions button{appearance:none;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:9px;padding:6px 12px;background:var(--dsw-alias-bg-layer-3,#2a2e38);color:inherit;cursor:pointer;font:inherit;white-space:nowrap}
.dsh-tutor-actions button:disabled{opacity:.45;cursor:default}
.dsh-tutor-actions button.primary{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:var(--dsw-alias-brand-primary,#3b82f6);color:#fff}
.dsh-tutor-resize{position:absolute;right:0;bottom:0;width:32px;height:32px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,var(--dsw-alias-label-dimmed,#6b7280) 50%) 100% 100%/18px 18px no-repeat;opacity:.7;touch-action:none}
.dsh-tutor-resize:hover{opacity:1}
`
  document.head.append(style)
}

function SettingsCard(): JSX.Element {
  const [effort, setEffort] = useState<TutorEffort>(TUTOR_DEFAULT_EFFORT)
  const [target, setTarget] = useState<TutorTranslateTarget>(TUTOR_DEFAULT_TRANSLATE_TARGET)
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.settingsGet().then((result) => {
      if (!result.ok) return
      const value = result.value.value as { defaultReasoningEffort?: unknown; translateTarget?: unknown } | null | undefined
      if (value !== null && value !== undefined) {
        setEffort(normalizeTutorEffort(value.defaultReasoningEffort))
        setTarget(normalizeTutorTranslateTarget(value.translateTarget))
      }
      if (typeof result.value.revision === 'number') setRevision(result.value.revision)
    })
  }, [])

  const save = async (patch: Record<string, unknown>, rollback: () => void): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    const result = await api.settingsUpdate(patch, revision)
    setSaving(false)
    if (result.ok) {
      if (typeof result.value.revision === 'number') setRevision(result.value.revision)
    } else {
      rollback()
      setError(result.error.message)
    }
  }

  const updateEffort = async (next: TutorEffort): Promise<void> => {
    const previous = effort
    setEffort(next)
    await save({ defaultReasoningEffort: next }, () => { setEffort(previous) })
  }

  const updateTarget = async (next: TutorTranslateTarget): Promise<void> => {
    const previous = target
    setTarget(next)
    await save({ translateTarget: next }, () => { setTarget(previous) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
        <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>小窗默认思考强度</span>
        <select value={effort} disabled={saving} onChange={event => { void updateEffort(event.currentTarget.value as TutorEffort) }}>
          {TUTOR_EFFORTS.map(id => (
            <option key={id} value={id}>{EFFORT_LABELS[id]}</option>
          ))}
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
        <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>翻译默认目标语言</span>
        <select value={target} disabled={saving} onChange={event => { void updateTarget(event.currentTarget.value as TutorTranslateTarget) }}>
          {TUTOR_TRANSLATE_TARGETS.map(id => (
            <option key={id} value={id}>{TARGET_LABELS[id]}</option>
          ))}
        </select>
      </label>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
        思考强度（off / high / max）只影响新建小窗；翻译窗口打开后可先预览原文并调整目标语言。模型固定继承当前主会话，不可更换。
      </p>
      {error !== null ? <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-error)' }}>{error}</p> : null}
    </div>
  )
}

/** Selection listener: show the floating menu above/below the selected text, with viewport clamping. */
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
      const halfWidth = SELECTION_MENU_WIDTH / 2
      const x = clamp(rect.left + rect.width / 2, halfWidth + SELECTION_MENU_GAP, window.innerWidth - halfWidth - SELECTION_MENU_GAP)
      const above = rect.top - SELECTION_MENU_GAP - SELECTION_MENU_HEIGHT >= 0
      const y = above ? rect.top - SELECTION_MENU_GAP : rect.bottom + SELECTION_MENU_GAP
      setLocal({ text, x, y, placement: above ? 'above' : 'below', charCount: text.length })
    }
    const onMouseUp = (): void => { window.setTimeout(compute, 0) }
    const onScroll = (): void => { setLocal(null) }
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setLocal(null) }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', compute)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', compute)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKeyDown)
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
    <div className={`dsh-tutor-menu${local.placement === 'below' ? ' below' : ''}`} style={{ left: local.x, top: local.y }}>
      <span className="dsh-tutor-count">{local.charCount} 字</span>
      <button type="button" onClick={() => { pick('explain') }}>解释</button>
      <button type="button" onClick={() => { pick('translate') }}>翻译</button>
    </div>
  )
}

function TutorWindow({ win, onClose, pinned, onTogglePin }: { win: StartResult & { mode: TutorMode; selectionText: string; parentSessionId: string }; onClose: () => void; pinned: boolean; onTogglePin: () => void }) {
  const [position, setPosition] = useState<WindowPosition>(() => readPosition())
  const [messages, setMessages] = useState<TutorMessage[]>([])
  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState(win.autoSend)
  const [effort, setEffort] = useState<TutorEffort>(win.reasoningEffort)
  const [translateTarget, setTranslateTarget] = useState<TutorTranslateTarget>(win.translateTarget)
  const [promptSent, setPromptSent] = useState(win.promptSent)
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [migrating, setMigrating] = useState(false)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: WindowPosition } | null>(null)
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; origin: WindowPosition } | null>(null)
  const sendingRef = useRef(false)
  const refreshingRef = useRef(false)
  const closingRef = useRef(false)
  const stickToBottomRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const copyTimerRef = useRef<number | undefined>(undefined)
  const closeRef = useRef<() => Promise<void>>(async () => {})
  const latestPosition = useRef(position)
  latestPosition.current = position

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    try {
      const result = await api.history({ windowId: win.windowId })
      if (!result.ok) {
        if (result.error.code === 'window-unavailable') onClose()
        else setError(result.error.message)
        return
      }
      setError(null)
      setMessages(result.value.messages)
      setRunning(result.value.running)
    } finally {
      refreshingRef.current = false
    }
  }, [win.windowId, onClose])

  useEffect(() => {
    void refresh()
    const delay = running ? POLL_RUNNING_MS : POLL_IDLE_MS
    const timer = window.setInterval(() => { void refresh() }, delay)
    return () => { window.clearInterval(timer) }
  }, [refresh, running])

  useEffect(() => {
    const onPageHide = (): void => {
      if (!closingRef.current) disposeKeepalive(win.windowId)
    }
    window.addEventListener('pagehide', onPageHide)
    return () => { window.removeEventListener('pagehide', onPageHide) }
  }, [win.windowId])

  useEffect(() => {
    const timer = window.setTimeout(() => { textareaRef.current?.focus() }, 0)
    return () => { window.clearTimeout(timer) }
  }, [win.windowId])

  useEffect(() => {
    if (error === null) return
    const timer = window.setTimeout(() => { setError(null) }, ERROR_AUTO_DISMISS_MS)
    return () => { window.clearTimeout(timer) }
  }, [error])

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

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
    const firstTranslate = win.mode === 'translate' && !promptSent
    if (sendingRef.current || running) return
    if (!firstTranslate && text === '') return
    const previousDraft = draft
    sendingRef.current = true
    setDraft('')
    setRunning(true)
    stickToBottomRef.current = true
    setError(null)
    try {
      const result = firstTranslate
        ? await api.translate({ windowId: win.windowId, translateTarget, text })
        : await api.followup({ windowId: win.windowId, text })
      if (!result.ok) {
        setDraft(previousDraft)
        setRunning(false)
        setError(result.error.message)
        return
      }
      if (firstTranslate) setPromptSent(true)
      await refresh()
    } finally {
      sendingRef.current = false
    }
  }

  const stop = async (): Promise<void> => {
    if (!running) return
    const result = await api.stop({ windowId: win.windowId })
    if (!result.ok) setError(result.error.message)
    setRunning(false)
  }

  const changeEffort = async (next: TutorEffort): Promise<void> => {
    if (next === effort) return
    const previous = effort
    setEffort(next)
    const result = await api.effort({ windowId: win.windowId, reasoningEffort: next })
    if (!result.ok) {
      setError(result.error.message)
      setEffort(previous)
    }
  }

  const changeTranslateTarget = async (next: TutorTranslateTarget): Promise<void> => {
    if (next === translateTarget) return
    const previous = translateTarget
    setTranslateTarget(next)
    const result = await api.translateTarget({ windowId: win.windowId, translateTarget: next })
    if (!result.ok) {
      setError(result.error.message)
      setTranslateTarget(previous)
    }
  }

  const close = async (): Promise<void> => {
    if (closingRef.current || migrating) return
    if (running) {
      const ok = window.confirm('小窗正在生成内容，关闭会取消当前回答并销毁这个临时分支。确定关闭吗？')
      if (!ok) return
    } else if (pinned) {
      const ok = window.confirm('小窗已置顶，关闭会销毁这个临时分支。确定关闭吗？')
      if (!ok) return
    }
    closingRef.current = true
    setClosing(true)
    await api.dispose({ windowId: win.windowId })
    onClose()
  }

  const copyMessage = async (message: TutorMessage, index: number): Promise<void> => {
    const text = message.blocks
      .filter((block): block is Extract<TutorBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n\n')
      .trim()
    if (text === '') return
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIndex(index)
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => { setCopiedIndex(null) }, 1500)
    } catch {
      setError('复制失败，请手动选择文本复制')
    }
  }

  const migrate = async (): Promise<void> => {
    if (migrating || running || closingRef.current) return
    const modePrefix = win.mode === 'translate' ? '翻译' : '解释'
    const preview = win.selectionText.replace(/\s+/g, ' ').trim().slice(0, 36)
    const suggested = `${modePrefix} · ${preview === '' ? '选中内容' : preview}`
    const title = window.prompt('将这个学习小窗迁移为会话列表里的独立对话。会话标题：', suggested)
    if (title === null) return
    const normalizedTitle = title.trim()
    if (normalizedTitle === '') {
      setError('会话标题不能为空')
      return
    }
    setMigrating(true)
    setError(null)
    const result = await api.promote({ windowId: win.windowId, title: normalizedTitle })
    if (!result.ok) {
      setMigrating(false)
      setError(result.error.message)
      return
    }
    closingRef.current = true
    setClosing(true)
    setError(null)
    onClose()
  }

  closeRef.current = close

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) void closeRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [])

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
  const onTitlePointerLost = (): void => {
    if (dragRef.current === null) return
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
    const maxWidth = Math.max(MIN_WIDTH, Math.min(window.innerWidth * MAX_FRACTION, window.innerWidth - resize.origin.left))
    const maxHeight = Math.max(MIN_HEIGHT, Math.min(window.innerHeight * MAX_FRACTION, window.innerHeight - resize.origin.top))
    const next: WindowPosition = {
      ...resize.origin,
      width: clamp(resize.origin.width + event.clientX - resize.startX, MIN_WIDTH, maxWidth),
      height: clamp(resize.origin.height + event.clientY - resize.startY, MIN_HEIGHT, maxHeight),
    }
    latestPosition.current = next
    setPosition(next)
  }
  const onResizePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizeRef.current?.pointerId !== event.pointerId) return
    resizeRef.current = null
    persistPosition(latestPosition.current)
  }
  const onResizePointerLost = (): void => {
    if (resizeRef.current === null) return
    resizeRef.current = null
    persistPosition(latestPosition.current)
  }

  const modeLabel = win.mode === 'explain' ? '解释' : '翻译'
  const firstTranslate = win.mode === 'translate' && !promptSent
  const selectionPreview = win.selectionText.replace(/\s+/g, ' ').slice(0, 28)
  const selectionCount = win.selectionText.trim().length
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    messagesRef.current = node
    if (node !== null) {
      stickToBottomRef.current = true
      node.scrollTop = node.scrollHeight
    }
  }, [])
  const handleMessagesScroll = useCallback((): void => {
    const node = messagesRef.current
    if (node === null) return
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    stickToBottomRef.current = distanceFromBottom < 64
  }, [])
  useEffect(() => {
    const node = messagesRef.current
    if (node !== null && stickToBottomRef.current) node.scrollTop = node.scrollHeight
  }, [messages])

  return (
    <section role="dialog" aria-label={`${modeLabel}学习小窗`} className={`dsh-tutor-window${pinned ? ' pinned' : ''}`} data-dsh-selection-tutor="" style={{ left: position.left, top: position.top, width: position.width, height: position.height }}>
      <div className="dsh-tutor-title" onPointerDown={onTitlePointerDown} onPointerMove={onTitlePointerMove} onPointerUp={onTitlePointerUp} onPointerCancel={onTitlePointerUp} onLostPointerCapture={onTitlePointerLost}>
        <div className="dsh-tutor-title-main">
          <span className="dsh-tutor-title-mode">{modeLabel}小窗</span>
          <span className="dsh-tutor-title-selection">{selectionPreview === '' ? '（空选择）' : `“${selectionPreview}”`}</span>
        </div>
          <div className="dsh-tutor-title-actions">
            <button type="button" className={pinned ? 'active' : ''} aria-pressed={pinned} onPointerDown={event => { event.stopPropagation() }} onClick={onTogglePin}>{pinned ? '已置顶' : '置顶'}</button>
            <button type="button" disabled={running || migrating || closing} onPointerDown={event => { event.stopPropagation() }} onClick={() => { void migrate() }}>迁移</button>
          </div>
        <button type="button" className="dsh-tutor-close" disabled={closing || migrating} onPointerDown={event => { event.stopPropagation() }} onClick={() => { void close() }}>关闭</button>
      </div>
      <div className="dsh-tutor-meta">
        <span>模型：{win.model}（继承主会话，无工具只读）</span>
        <label>
          思考强度
          <select value={effort} onChange={event => { void changeEffort(event.currentTarget.value as TutorEffort) }}>
            {TUTOR_EFFORTS.map(id => <option key={id} value={id}>{EFFORT_LABELS[id]}</option>)}
          </select>
        </label>
        {win.mode === 'translate' ? (
          <label>
            目标语言
            <select value={translateTarget} disabled={promptSent} onChange={event => { void changeTranslateTarget(event.currentTarget.value as TutorTranslateTarget) }}>
              {TUTOR_TRANSLATE_TARGETS.map(id => <option key={id} value={id}>{TARGET_LABELS[id]}</option>)}
            </select>
          </label>
        ) : null}
        {running ? <span>生成中…</span> : null}
      </div>
      <div className="dsh-tutor-messages" ref={scrollRef} onScroll={handleMessagesScroll} aria-live="polite" aria-label="小窗消息">
        <details className="dsh-tutor-source">
          <summary>选中原文（{selectionCount} 字）</summary>
          <div>{win.selectionText}</div>
        </details>
        {messages.length === 0 ? <div className="dsh-tutor-empty">{firstTranslate ? '原文已就绪：选择目标语言后点击「开始翻译」，也可以先补充翻译要求。' : '小窗已就绪，请基于选中的内容提问。'}</div> : null}
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`dsh-tutor-msg ${message.role}`}>
            {message.role === 'assistant' ? (
              <button type="button" className="dsh-tutor-copy" onClick={() => { void copyMessage(message, index) }}>
                {copiedIndex === index ? '已复制' : '复制'}
              </button>
            ) : null}
            {message.blocks.map((block: TutorBlock, blockIndex) => {
              if (block.type === 'reasoning') return (
                <details key={blockIndex} className="dsh-tutor-reasoning">
                  <summary>思考过程（{block.text.length} 字）</summary>
                  <div>{block.text}</div>
                </details>
              )
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
      {error !== null ? (
        <p className="dsh-tutor-error">
          <span>{error}</span>
          <button type="button" onClick={() => { setError(null) }}>×</button>
        </p>
      ) : null}
      <div className="dsh-tutor-composer">
        <textarea
          ref={textareaRef}
          value={draft}
          placeholder={firstTranslate ? '可选：补充翻译要求（语气、术语等）…' : win.mode === 'explain' ? '就选中的内容提问…' : '继续追问…'}
          onChange={event => { setDraft(event.currentTarget.value) }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || !event.shiftKey)) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="dsh-tutor-actions">
          <button type="button" className="primary" disabled={running || sendingRef.current || (!firstTranslate && draft.trim() === '')} onClick={() => { void send() }}>{firstTranslate ? '开始翻译' : '发送'}</button>
          <button type="button" disabled={!running} onClick={() => { void stop() }}>停止</button>
        </div>
      </div>
      <div className="dsh-tutor-resize" onPointerDown={onResizePointerDown} onPointerMove={onResizePointerMove} onPointerUp={onResizePointerUp} onPointerCancel={onResizePointerUp} onLostPointerCapture={onResizePointerLost} />
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
  const [startError, setStartError] = useState<string | null>(null)
  const [pinned, setPinned] = useState<boolean>(() => {
    try { return localStorage.getItem(PIN_KEY) === '1' } catch { return false }
  })
  const startingRef = useRef(false)

  const togglePin = useCallback((): void => {
    setPinned(current => {
      const next = !current
      try { localStorage.setItem(PIN_KEY, next ? '1' : '0') } catch { /* storage unavailable */ }
      return next
    })
  }, [])

  useEffect(() => {
    if (win !== null && current !== win.parentSessionId && !pinned) {
      void api.dispose({ windowId: win.windowId })
      setWin(null)
    }
  }, [current, win, pinned])

  const pick = useCallback(async (mode: TutorMode, text: string): Promise<void> => {
    const parentSessionId = ctx.sessions.list.getSnapshot().current
    if (parentSessionId === undefined || startingRef.current) return
    startingRef.current = true
    setStartError(null)
    try {
      const result = await api.start({ parentSessionId, mode, selectionText: text, autoSend: false })
      if (result.ok) {
        setWin({ ...result.value, mode, selectionText: text, parentSessionId })
      } else {
        setStartError(result.error.message)
      }
    } finally {
      startingRef.current = false
    }
  }, [ctx.sessions.list])

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
      {win !== null ? <TutorWindow win={win} onClose={close} pinned={pinned} onTogglePin={togglePin} /> : null}
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
    description: '选中文字后弹出“解释/翻译”浮动小窗的默认思考强度与翻译目标语言。翻译窗口先预览原文，模型固定继承主会话。',
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
  const unregisterModelConfigCard = registerModelConfigCard()

  const host = document.createElement('div')
  host.setAttribute('data-dsh-selection-tutor', '')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  root.render(<TutorRoot ctx={ctx} />)

  ctx.effect(() => {
    return () => {
      unregisterModelConfigCard()
      root.unmount()
      host.remove()
      document.getElementById(STYLE_ID)?.remove()
    }
  }, 'dsh-selection-tutor: client mount')
}
