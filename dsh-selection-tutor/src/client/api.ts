/** Browser API client for the host /plugins/dsh-selection-tutor/api routes. */
import { TUTOR_PREFS_DEFAULTS, type TutorEffort } from '../settings-shared.ts'

export type { TutorEffort }
export type TutorMode = 'explain' | 'translate'

export interface ApiError { code: string; message: string }
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError }

export type TutorBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; name: string; arguments?: string; result?: string; isError?: boolean }
  | { type: 'error'; text: string }

export interface TutorMessage {
  role: 'user' | 'assistant'
  blocks: TutorBlock[]
}

export interface StartResult {
  windowId: string
  childSessionId: string
  provider: string
  model: string
  reasoningEffort: TutorEffort
  autoSend: boolean
}

export const TUTOR_DEFAULT_EFFORT: TutorEffort = TUTOR_PREFS_DEFAULTS.defaultReasoningEffort

async function call<T>(method: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/plugins/dsh-selection-tutor/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return (await res.json()) as ApiResult<T>
  } catch {
    return { ok: false, error: { code: 'network', message: '无法连接插件服务' } }
  }
}

/** Fire-and-forget dispose for pagehide/unload, using fetch keepalive so it survives navigation. */
export function disposeKeepalive(windowId: string): void {
  try {
    void fetch(`/plugins/dsh-selection-tutor/api/tutor.dispose`, {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ windowId }),
    })
  } catch { /* the window is going away */ }
}

export const api = {
  start: (args: { parentSessionId: string; mode: TutorMode; selectionText: string; autoSend?: boolean }) =>
    call<StartResult>('tutor.start', args),
  followup: (args: { windowId: string; text: string }) =>
    call<{ accepted: true }>('tutor.followup', args),
  history: (args: { windowId: string }) =>
    call<{ windowId: string; running: boolean; messages: TutorMessage[] }>('tutor.history', args),
  stop: (args: { windowId: string }) =>
    call<{ accepted: true }>('tutor.stop', args),
  effort: (args: { windowId: string; reasoningEffort: TutorEffort }) =>
    call<{ accepted: true; reasoningEffort: TutorEffort }>('tutor.effort', args),
  dispose: (args: { windowId: string }) =>
    call<{ accepted: true }>('tutor.dispose', args),
  settingsGet: () => call<{ value?: unknown; revision?: number }>('settings.get', {}),
  settingsUpdate: (patch: Record<string, unknown>, expectedRevision?: number) =>
    call<{ value?: unknown; revision?: number }>('settings.update', { patch, expectedRevision }),
}
