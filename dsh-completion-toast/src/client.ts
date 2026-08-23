/**
 * dsh-completion-toast — client half.
 *
 * Watches the session list's `running` bit. When a session flips
 * running→idle while the DSH page is hidden/minimized, asks the host to show
 * a Windows completion notification for that session.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const name = 'dsh-completion-toast-client'
export const inject: string[] = ['sessions']

/** 0.1.1 的 session list 条目结构（本地断言；类型包尚未同步到 rc.2）。 */
interface SessionListEntry {
  sessionId?: string
  id?: string
  running: boolean
  title?: string
}

export function apply(ctx: ClientContext): void {
  console.log('[dsh-completion-toast] client loaded')
  const sessions = ctx.sessions
  if (sessions === undefined) {
    console.warn('[dsh-completion-toast] ctx.sessions unavailable')
    return
  }

  const prevRunning = new Map<string, boolean>()

  const reportVisibility = () => {
    const outOfView = document.hidden || document.visibilityState === 'hidden' || !document.hasFocus()
    fetch(`/plugins/dsh-completion-toast/visibility?hidden=${outOfView ? 1 : 0}`, { method: 'POST', cache: 'no-store' }).catch(() => {})
  }

  const check = () => {
    const snapshot = sessions.list.getSnapshot()
    const hidden = document.hidden || document.visibilityState === 'hidden' || !document.hasFocus()
    // 0.1.1: sessions list snapshot 改为 items 数组（byId 已移除），
    // 每个条目带 sessionId/running/title 等字段。
    const list = snapshot as { items?: SessionListEntry[]; ids?: string[]; byId?: Record<string, SessionListEntry> }
    const entries: SessionListEntry[] = Array.isArray(list.items)
      ? list.items
      : (list.ids ?? []).map((id) => {
          const summary = list.byId?.[id]
          return summary ? { ...summary, sessionId: summary.sessionId ?? id } : { id, sessionId: id, running: false }
        })
    for (const summary of entries) {
      const id = summary.sessionId ?? summary.id
      if (!id) continue
      const wasRunning = prevRunning.get(id) ?? false
      const isRunning = summary.running
      if (wasRunning && !isRunning && hidden) {
        console.log('[dsh-completion-toast] completion edge', id, 'hidden', hidden)
        fetch(`/plugins/dsh-completion-toast/notify?sessionId=${encodeURIComponent(id)}`, {
          method: 'POST',
          cache: 'no-store',
        }).then(() => console.log('[dsh-completion-toast] notify sent', id)).catch((error) => console.warn('[dsh-completion-toast] notify failed', error))
      }
      prevRunning.set(id, isRunning)
    }
  }

  ctx.effect(() => {
    const unsubscribe = sessions.list.subscribe(check)
    const onBlur = () => reportVisibility()
    const onFocus = () => reportVisibility()
    const onVisibility = () => reportVisibility()
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    check()
    reportVisibility()
    return () => {
      unsubscribe()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, 'dsh-completion-toast: completion edge + visibility reporter')
}
