/**
 * dsh-completion-toast — host half.
 *
 * Listens for agent running→idle transitions. When the DSH window is hidden
 * (reported by the client half) and a session finishes, it pops a Windows
 * balloon notification in the bottom-right with the session title and the
 * last user prompt as the task summary.
 *
 * @module @peanutsdou/dsh-completion-toast
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-completion-toast'
export const inject = ['webServer', 'sessions']

interface HttpRequest {
  method?: string
  url?: string
}

interface HttpResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Buffer): void
}

interface SessionMeta {
  title?: string
  lastPrompt?: string
}

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url))
}

function assetPath(...parts: string[]): string {
  return path.resolve(moduleDir(), '..', ...parts)
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function textFromUserMessage(message: unknown): string {
  const record = (message ?? {}) as { content?: unknown }
  const content = Array.isArray(record.content) ? record.content : []
  const parts: string[] = []
  for (const block of content) {
    const item = (block ?? {}) as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join(' ').trim()
}

function showWindowsNotification(title: string, message: string): void {
  const script = assetPath('scripts', 'notify.ps1')
  const icon = assetPath('assets', 'icon.ico')
  if (!fs.existsSync(script)) {
    console.error('[dsh-completion-toast] notify.ps1 not found:', script)
    return
  }
  execFile('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-Title', title,
    '-Message', message,
    '-IconPath', icon,
  ], { windowsHide: true, timeout: 15000 }, (error) => {
    if (error) console.error('[dsh-completion-toast] notification failed:', error.message)
  })
}

export function apply(ctx: Context): void {
  let hidden = false
  const sessionMeta = new Map<string, SessionMeta>()

  ctx.on('session/event', (rawSession: unknown, rawEvent: unknown) => {
    const session = (rawSession ?? {}) as { id?: unknown }
    const sessionId = typeof session.id === 'string' ? session.id : undefined
    if (sessionId === undefined) return

    const event = (rawEvent ?? {}) as {
      type?: string
      data?: {
        title?: unknown
        message?: unknown
        content?: unknown
      }
    }

    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      const meta = sessionMeta.get(sessionId) ?? {}
      meta.title = event.data.title
      sessionMeta.set(sessionId, meta)
      return
    }

    if (event.type === 'user/message') {
      const prompt = textFromUserMessage(event.data?.message ?? event.data)
      if (prompt !== '') {
        const meta = sessionMeta.get(sessionId) ?? {}
        meta.lastPrompt = prompt
        sessionMeta.set(sessionId, meta)
      }
      return
    }
  })

  function notifySession(sessionId: string): void {
    const meta = sessionMeta.get(sessionId) ?? {}
    const title = meta.title ?? '未命名会话'
    const summary = meta.lastPrompt !== undefined ? `：${truncate(meta.lastPrompt, 80)}` : ''
    showWindowsNotification('DeepSeek Harness', `会话「${title}」任务完成${summary}`)
  }

  const webServer = ctx.get('webServer') as { register: (route: WebRoute) => () => void } | undefined
  if (webServer !== undefined) {
    ctx.effect(() => {
      const disposeNotify = webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-completion-toast/notify',
        handler: async (req: HttpRequest, res: HttpResponse) => {
          if ((req.method ?? 'GET') !== 'POST') {
            res.writeHead(405, { allow: 'POST' })
            res.end('method not allowed')
            return
          }
          try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const sessionId = url.searchParams.get('sessionId') ?? ''
            if (sessionId !== '') notifySession(sessionId)
          } catch { /* ignore */ }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true }))
        },
      })
      const dispose = webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-completion-toast/visibility',
        handler: async (req: HttpRequest, res: HttpResponse) => {
          if ((req.method ?? 'GET') !== 'POST') {
            res.writeHead(405, { allow: 'POST' })
            res.end('method not allowed')
            return
          }
          try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            hidden = url.searchParams.get('hidden') === '1'
          } catch {
            hidden = false
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, hidden }))
        },
      })
      return () => {
        disposeNotify()
        dispose()
      }
    }, 'dsh-completion-toast: routes')
  }
}
