/**
 * dsh-completion-toast — client half.
 *
 * Reports whether the DSH page is currently hidden/minimized so the host only
 * pops completion notifications while the user is not looking at the window.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const name = 'dsh-completion-toast-client'
export const inject: string[] = []

function sendHidden(hidden: boolean): void {
  fetch(`/plugins/dsh-completion-toast/visibility?hidden=${hidden ? '1' : '0'}`, {
    method: 'POST',
    cache: 'no-store',
  }).catch(() => { /* transient */ })
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const onVisibility = () => sendHidden(document.hidden || document.visibilityState === 'hidden')
    const onBlur = () => sendHidden(true)
    const onFocus = () => sendHidden(false)

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    sendHidden(document.hidden || document.visibilityState === 'hidden')

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, 'dsh-completion-toast: visibility reporter')
}
