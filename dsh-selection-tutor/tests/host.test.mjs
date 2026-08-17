import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function makeRequest(payload, method = 'tutor.start') {
  return {
    method: 'POST',
    url: `/plugins/dsh-selection-tutor/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload))
    },
  }
}

async function callRoute(route, payload, method = 'tutor.start') {
  let body = ''
  let status = 0
  const res = {
    writeHead(code) { status = code },
    end(chunk) { body += chunk.toString() },
  }
  await route.handler(makeRequest(payload, method), res)
  return { status, body: JSON.parse(body || '{}') }
}

function makeContext() {
  const routes = new Map()
  const effects = []
  const created = []
  const archived = []
  const followedUp = []
  const disposed = []
  let composeCalls = 0
  const requestHooks = []

  const parentCtx = { mark: 'parent' }
  const childCtx = {
    on(name, cb) {
      if (name === 'agent/request') requestHooks.push(cb)
      return () => {}
    },
  }
  const parentSession = {
    id: 'parent-1',
    header: { cwd: 'D:\demo' },
    events: [],
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high', maxTokens: 8000 } }),
  }
  const parentAgent = {
    id: 'parent-1',
    options: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    session: parentSession,
    ctx: parentCtx,
  }

  const ctx = {
    get(name) {
      if (name === 'loader') return { entries: () => [{ options: { name: 'connection', config: { trustedHosts: [] } } }] }
      return undefined
    },
    inject(deps, callback) {
      if (deps.includes('settings')) {
        const settings = {
          register() {
            return { get: () => ({ defaultReasoningEffort: 'off' }), watch: () => () => {} }
          },
          describe() {
            return [{ ns: 'dsh-selection-tutor', value: { defaultReasoningEffort: 'off' }, revision: 1 }]
          },
          update: async () => {},
        }
        callback({ settings })
      }
      return () => {}
    },
    webServer: {
      register(route) { routes.set(route.path, route); return () => {} },
    },
    agents: {
      get(id) { return id === 'parent-1' ? parentAgent : undefined },
      async create(options) {
        created.push(options)
        if (options.setup !== undefined) await options.setup(childCtx)
        const handle = {
          agent: {
            id: options.sessionId,
            options: options.agentOptions ?? {},
            session: {
              id: options.sessionId,
              header: { cwd: options.meta?.cwd, parentSession: options.meta?.parentSession },
              events: [
                { type: 'turn/start', time: 1, data: {} },
                { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '解释 prompt' }] } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是解释' }] } } },
              ],
            },
            ctx: childCtx,
            followup(message) { followedUp.push(message) },
            cancel(cause) { followedUp.push({ cancel: cause }) },
          },
          dispose: async () => { disposed.push(options.sessionId) },
        }
        return handle
      },
    },
    workspaceRegistry: {
      archiveSession: async (id) => { archived.push(id) },
    },
    sessionQuery: {
      readSession: async (id) => ({
        session: { parentSession: 'parent-1' },
        events: [
          { type: 'turn/start', time: 1, data: {} },
          { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '解释 prompt' }] } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是解释' }] } } },
        ],
      }),
    },
    permissionPresets: {
      current: () => 'read-only',
      set(session, preset) { session._preset = preset },
    },
    agentPresets: {
      composeFrom(agentCtx, parent) { composeCalls += 1; return 'composed' },
    },
    effect(callback, _label) {
      const dispose = callback()
      effects.push(dispose)
      return () => {}
    },
    on() { return () => {} },
  }
  return { ctx, routes, effects, created, archived, followedUp, disposed, getComposeCalls: () => composeCalls, requestHooks, parentAgent }
}

test('tutor host creates an archived child, forces effort, and disposes on close', async () => {
  const { ctx, routes, created, archived, followedUp, disposed, getComposeCalls } = makeContext()
  apply(ctx)

  const route = routes.get('/plugins/dsh-selection-tutor/api')
  assert.ok(route, 'route registered')

  const started = await callRoute(route, { parentSessionId: 'parent-1', mode: 'explain', selectionText: 'context manager' })
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  assert.equal(started.body.value.reasoningEffort, 'off')
  const childId = started.body.value.windowId
  assert.match(childId, /^tutor-/)

  assert.equal(created.length, 1)
  assert.equal(created[0].meta.parentSession, 'parent-1')
  assert.equal(created[0].meta.cwd, 'D:\demo')
  assert.equal(created[0].agentOptions.provider, 'deepseek')
  assert.equal(created[0].agentOptions.model, 'deepseek-v4-flash')
  assert.equal(getComposeCalls(), 1)
  assert.deepEqual(archived, [childId])
  assert.equal(followedUp.length, 1)
  assert.match(followedUp[0].content[0].text, /<selected_text>/)

  const followed = await callRoute(route, { windowId: childId, text: '再解释一下' }, 'tutor.followup')
  assert.equal(followed.body.ok, true)
  assert.equal(followedUp.length, 2)

  const effort = await callRoute(route, { windowId: childId, reasoningEffort: 'max' }, 'tutor.effort')
  assert.equal(effort.body.ok, true)
  assert.equal(effort.body.value.reasoningEffort, 'max')

  const history = await callRoute(route, { windowId: childId }, 'tutor.history')
  assert.equal(history.body.ok, true)
  assert.equal(history.body.value.running, true)
  assert.equal(history.body.value.messages.length, 2)

  const stopped = await callRoute(route, { windowId: childId }, 'tutor.stop')
  assert.equal(stopped.body.ok, true)
  assert.ok(followedUp.some(entry => entry !== null && typeof entry === 'object' && 'cancel' in entry))

  const closed = await callRoute(route, { windowId: childId }, 'tutor.dispose')
  assert.equal(closed.body.ok, true)
  assert.deepEqual(disposed, [childId])

  const second = await callRoute(route, { windowId: childId }, 'tutor.history')
  assert.equal(second.body.ok, false)
  assert.equal(second.body.error.code, 'window-unavailable')
})

test('one tutor window per parent conversation', async () => {
  const { ctx, routes } = makeContext()
  apply(ctx)
  const route = routes.get('/plugins/dsh-selection-tutor/api')

  const first = await callRoute(route, { parentSessionId: 'parent-1', mode: 'translate', selectionText: 'hello' })
  assert.equal(first.body.ok, true)
  const second = await callRoute(route, { parentSessionId: 'parent-1', mode: 'explain', selectionText: 'world' })
  assert.equal(second.body.ok, false)
  assert.equal(second.body.error.code, 'window-exists')
})
