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
  sessionId: string
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

  const check = () => {
    const snapshot = sessions.list.getSnapshot()
    const hidden = document.hidden || document.visibilityState === 'hidden'
    // 0.1.1: sessions list snapshot 改为 items 数组（byId 已移除），
    // 每个条目带 sessionId/running/title 等字段。
    const entries = (snapshot as { items?: SessionListEntry[] }).items ?? []
    for (const summary of entries) {
      const id = summary.sessionId
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
    check()
    return unsubscribe
  }, 'dsh-completion-toast: completion edge reporter')
}
