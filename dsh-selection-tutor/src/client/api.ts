/** Browser API client for the host /plugins/dsh-selection-tutor/api routes. */

export type TutorMode = 'explain' | 'translate'
export type TutorEffort = 'off' | 'low' | 'high' | 'max'

export interface ApiError { code: string; message: string }
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError }

export interface TutorMessage {
  role: 'user' | 'assistant'
  blocks: Array<{ type: 'text' | 'reasoning'; text: string }>
}

export interface StartResult {
  windowId: string
  childSessionId: string
  provider: string
  model: string
  reasoningEffort: TutorEffort
}

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

export const api = {
  start: (args: { parentSessionId: string; mode: TutorMode; selectionText: string }) =>
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
