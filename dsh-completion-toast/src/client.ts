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

export function apply(ctx: ClientContext): void {
  const sessions = ctx.sessions
  if (sessions === undefined) return

  const prevRunning = new Map<string, boolean>()

  const check = () => {
    const snapshot = sessions.list.getSnapshot()
    const hidden = document.hidden || document.visibilityState === 'hidden'
    for (const [id, summary] of Object.entries(snapshot.byId)) {
      const wasRunning = prevRunning.get(id) ?? false
      const isRunning = summary.running
      if (wasRunning && !isRunning && hidden) {
        fetch(`/plugins/dsh-completion-toast/notify?sessionId=${encodeURIComponent(id)}`, {
          method: 'POST',
          cache: 'no-store',
        }).catch(() => { /* transient */ })
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
