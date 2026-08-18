import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function makeRequest(payload, method = 'tutor.start', headers = { host: '127.0.0.1:3080' }) {
  return {
    method: 'POST',
    url: `/plugins/dsh-selection-tutor/api/${method}`,
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload))
    },
  }
}

async function callRoute(route, payload, method = 'tutor.start', headers = undefined) {
  let body = ''
  let status = 0
  const res = {
    writeHead(code) { status = code },
    end(chunk) { body += chunk.toString() },
  }
  await route.handler(makeRequest(payload, method, headers), res)
  return { status, body: JSON.parse(body || '{}') }
}

function makeContext(options = {}) {
  const routes = new Map()
  const effects = []
  const created = []
  const archived = []
  const followedUp = []
  const disposed = []
  let composeCalls = 0
  const requestHooks = []

  const childCtx = {
    on(name, cb) {
      if (name === 'agent/request') requestHooks.push(cb)
      return () => {}
    },
  }
  const parentSession = {
    id: 'parent-1',
    header: { cwd: 'D:\\demo' },
    events: options.parentEvents ?? [],
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high', maxTokens: 8000 } }),
  }
  const parentAgent = {
    id: 'parent-1',
    options: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    session: parentSession,
    ctx: { mark: 'parent' },
  }

  const ctx = {
    get(name) {
      if (name === 'loader') {
        return {
          entries: () => [{
            options: {
              id: 'connection',
              name: '@deepseek-ai/dsh-client-connection',
              config: { trustedHosts: options.trustedHosts ?? [] },
            },
          }],
        }
      }
      return undefined
    },
    inject(deps, callback) {
      if (deps.includes('settings')) {
        const settings = {
          register() {
            return { get: () => ({ defaultReasoningEffort: options.defaultEffort ?? 'off', translateTarget: options.defaultTarget ?? 'auto' }), watch: () => () => {} }
          },
          describe() {
            return [{ ns: 'dsh-selection-tutor', value: { defaultReasoningEffort: options.defaultEffort ?? 'off', translateTarget: options.defaultTarget ?? 'auto' }, revision: 1 }]
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
      async create(agentOptions) {
        created.push(agentOptions)
        if (agentOptions.setup !== undefined) await agentOptions.setup(childCtx)
        const handle = {
          agent: {
            id: agentOptions.sessionId,
            options: agentOptions.agentOptions ?? {},
            session: {
              id: agentOptions.sessionId,
              header: { cwd: agentOptions.meta?.cwd, parentSession: agentOptions.meta?.parentSession },
              events: [
                { type: 'turn/start', time: 1, data: {} },
                { type: 'user/message', data: { source: { kind: 'user', tutorDisplay: '再解释一下' }, content: [{ type: 'text', text: '解释 prompt' }] } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是解释' }] } } },
              ],
            },
            ctx: childCtx,
            followup(message) { followedUp.push(message) },
            cancel(cause) { followedUp.push({ cancel: cause }) },
          },
          dispose: async () => { disposed.push(agentOptions.sessionId) },
        }
        return handle
      },
    },
    workspaceRegistry: {
      archiveSession: async (id) => {
        if (options.archiveError !== undefined) throw options.archiveError
        archived.push(id)
      },
    },
    sessionQuery: {
      readSession: async (id) => id === 'parent-1'
        ? { session: { parentSession: undefined }, events: options.parentEvents ?? [] }
        : {
            session: { parentSession: 'parent-1' },
            events: options.readEvents ?? [
              { type: 'turn/start', time: 1, data: { turn: 1 } },
              { type: 'user/message', data: { source: { kind: 'user', tutorDisplay: '再解释一下' }, content: [{ type: 'text', text: '解释 prompt' }] } },
              { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'text-delta', text: '这是' } } },
              { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'text-delta', text: '解释' } } },
              { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '这是解释' }] } } },
              { type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'read', arguments: '{"path":"a"}' } },
              { type: 'tool/result', data: { turn: 1, step: 0, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }], isError: false }] } } },
              { type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
            ],
          },
      },
    permissionPresets: {
      current: () => 'read-only',
      set() { throw new Error('permission inheritance must be disabled for the tool-less tutor child') },
    },
    agentPresets: {
      composeFrom() { composeCalls += 1; return 'composed' },
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

test('tutor host creates a tool-less archived child, forces effort live, and disposes on close', async () => {
  const { ctx, routes, created, archived, followedUp, disposed, getComposeCalls, requestHooks } = makeContext()
  apply(ctx)

  const route = routes.get('/plugins/dsh-selection-tutor/api')
  assert.ok(route, 'route registered')

  const started = await callRoute(route, { parentSessionId: 'parent-1', mode: 'explain', selectionText: 'context manager', autoSend: false })
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  assert.equal(started.body.value.reasoningEffort, 'off')
  assert.equal(started.body.value.translateTarget, 'auto')
  assert.equal(started.body.value.promptSent, false)
  const childId = started.body.value.windowId
  assert.match(childId, /^tutor-/)

  assert.equal(created.length, 1)
  assert.equal(created[0].meta.parentSession, 'parent-1')
  assert.equal(created[0].meta.cwd, 'D:\\demo')
  assert.equal(created[0].agentOptions.provider, 'deepseek')
  assert.equal(created[0].agentOptions.model, 'deepseek-v4-flash')
  assert.equal(getComposeCalls(), 0, 'parent preset (and its guardian retry loop) must not be inherited')
  assert.deepEqual(archived, [childId])

  // explain mode does not auto-send; the first followup anchors the selection plus the question.
  const followed = await callRoute(route, { windowId: childId, text: '再解释一下' }, 'tutor.followup')
  assert.equal(followed.body.ok, true)
  assert.equal(followedUp.length, 1)
  const firstPrompt = followedUp[0].content[0].text
  assert.match(firstPrompt, /<selected_text>\ncontext manager\n<\/selected_text>/)
  assert.match(firstPrompt, /<user_question>\n再解释一下\n<\/user_question>/)

  // Server-side duplicate guard: a second followup while the turn is open is refused.
  const double = await callRoute(route, { windowId: childId, text: '再发一次' }, 'tutor.followup')
  assert.equal(double.body.ok, false)
  assert.equal(double.body.error.code, 'busy')
  assert.equal(followedUp.length, 1)

  // The effort switch must affect the actual agent/request waterfall.
  const requestAt = async () => requestHooks[0]({}, async () => ({ provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'off' }))
  assert.deepEqual(await requestAt(), { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'off' })
  const effort = await callRoute(route, { windowId: childId, reasoningEffort: 'max' }, 'tutor.effort')
  assert.equal(effort.body.ok, true)
  assert.equal(effort.body.value.reasoningEffort, 'max')
  assert.deepEqual(await requestAt(), { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'max' })

  // Unsupported / legacy levels are refused at the API boundary.
  const bad = await callRoute(route, { windowId: childId, reasoningEffort: 'low' }, 'tutor.effort')
  assert.equal(bad.body.ok, false)
  assert.equal(bad.body.error.code, 'bad-request')

  const history = await callRoute(route, { windowId: childId }, 'tutor.history')
  assert.equal(history.body.ok, true)
  assert.equal(history.body.value.running, false)
  const user = history.body.value.messages.find(message => message.role === 'user')
  assert.ok(user, 'synthetic system prompt must still produce one user bubble')
  assert.equal(user.blocks[0].text, '再解释一下', 'only the user question is displayed, not the system prompt')
  const assistant = history.body.value.messages.find(message => message.role === 'assistant')
  const toolBlocks = assistant.blocks.filter(block => block.type === 'tool')
  assert.equal(toolBlocks.filter(block => block.name === 'read').length, 1, 'tool call must not duplicate')
  const resultBlock = toolBlocks.find(block => block.result !== undefined)
  assert.equal(resultBlock.name, 'call-1', 'tool/result pairing reads the real tool-result block')
  assert.equal(resultBlock.result, 'file contents')

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

test('translate mode auto-sends once and one tutor window per parent conversation', async () => {
  const { ctx, routes, followedUp } = makeContext()
  apply(ctx)
  const route = routes.get('/plugins/dsh-selection-tutor/api')

  const first = await callRoute(route, { parentSessionId: 'parent-1', mode: 'translate', selectionText: 'hello', autoSend: false })
  assert.equal(first.body.ok, true)
  assert.equal(first.body.value.promptSent, false)
  assert.equal(followedUp.length, 0, 'translation windows preview before sending')

  const translated = await callRoute(route, { windowId: first.body.value.windowId, translateTarget: 'ja', text: '口语一点' }, 'tutor.translate')
  assert.equal(translated.body.ok, true)
  assert.equal(followedUp.length, 1)
  assert.match(followedUp[0].content[0].text, /日本語/)
  assert.match(followedUp[0].content[0].text, /口语一点/)

  const twice = await callRoute(route, { windowId: first.body.value.windowId, translateTarget: 'en' }, 'tutor.translate')
  assert.equal(twice.body.ok, false)
  assert.equal(twice.body.error.code, 'translation-already-started')
  const second = await callRoute(route, { parentSessionId: 'parent-1', mode: 'explain', selectionText: 'world' })
  assert.equal(second.body.ok, false)
  assert.equal(second.body.error.code, 'window-exists')
})

test('archive failure rolls back the created child agent', async () => {
  const { ctx, routes, disposed, archived } = makeContext({ archiveError: new Error('archive down') })
  apply(ctx)
  const route = routes.get('/plugins/dsh-selection-tutor/api')
  const result = await callRoute(route, { parentSessionId: 'parent-1', mode: 'translate', selectionText: 'hello' })
  assert.equal(result.status, 500)
  assert.deepEqual(archived, [])
  assert.equal(disposed.length, 1)
})

test('legacy low effort setting resolves to high without rejecting registration', async () => {
  const { ctx, routes } = makeContext({ defaultEffort: 'low' })
  apply(ctx)
  const route = routes.get('/plugins/dsh-selection-tutor/api')
  const started = await callRoute(route, { parentSessionId: 'parent-1', mode: 'explain', selectionText: 'x' })
  assert.equal(started.body.ok, true)
  assert.equal(started.body.value.reasoningEffort, 'high')
})

test('non-loopback requests use the client-connection trustedHosts row', async () => {
  const { ctx, routes } = makeContext({ trustedHosts: ['192.168.1.10:3080'] })
  apply(ctx)
  const route = routes.get('/plugins/dsh-selection-tutor/api')
  const ok = await callRoute(
    route,
    { parentSessionId: 'parent-1', mode: 'translate', selectionText: 'hello' },
    'tutor.start',
    { host: '192.168.1.10:3080', origin: 'http://192.168.1.10:3080' },
  )
  assert.equal(ok.body.ok, true)

  const denied = await callRoute(
    route,
    { parentSessionId: 'parent-1', mode: 'translate', selectionText: 'hello' },
    'tutor.start',
    { host: '192.168.1.10:3080', origin: 'http://evil.test' },
  )
  assert.equal(denied.status, 403)
})

test('stop keeps running false until the cancelled turn closes in the log', async () => {
  const openEvents = [
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '解释 prompt' }] } },
    { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'text-delta', text: '正在' } } },
  ]
  const { ctx, routes } = makeContext({ readEvents: openEvents })
  apply(ctx)
  const route = routes.get('/plugins/dsh-selection-tutor/api')
  const started = await callRoute(route, { parentSessionId: 'parent-1', mode: 'explain', selectionText: 'x', autoSend: false })
  assert.equal(started.body.ok, true)
  const before = await callRoute(route, { windowId: started.body.value.windowId }, 'tutor.history')
  assert.equal(before.body.value.running, true)
  const stopped = await callRoute(route, { windowId: started.body.value.windowId }, 'tutor.stop')
  assert.equal(stopped.body.ok, true)
  const after = await callRoute(route, { windowId: started.body.value.windowId }, 'tutor.history')
  assert.equal(after.body.value.running, false, 'stop must keep the UI stopped while the turn/end event is still in flight')
})

test('invalid translate targets are rejected at the API boundary', async () => {
  const { ctx, routes } = makeContext()
  apply(ctx)
  const route = routes.get('/plugins/dsh-selection-tutor/api')
  const started = await callRoute(route, { parentSessionId: 'parent-1', mode: 'translate', selectionText: 'x', autoSend: false })
  const bad = await callRoute(route, { windowId: started.body.value.windowId, translateTarget: 'klingon' }, 'tutor.translate')
  assert.equal(bad.body.ok, false)
  assert.equal(bad.body.error.code, 'bad-request')
})


test('tutor start seeds completed parent turns and hides seed history from the window transcript', async () => {
  const parentEvents = [
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '父会话问题' }] } },
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '父会话回答' }] } } },
    { type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', time: 3, data: { turn: 2 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '父会话未完成问题' }] } },
  ]
  const childEvents = [
    { type: 'turn/start', time: 10, data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user', tutorDisplay: '小窗问题' }, content: [{ type: 'text', text: '小窗 prompt' }] } },
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '小窗回答' }] } } },
    { type: 'turn/end', time: 11, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const seededChildEvents = [...parentEvents.slice(0, 4), { type: 'session/end-seed', time: 5, data: {} }, ...childEvents]
  const { ctx, routes, created } = makeContext({ parentEvents, readEvents: seededChildEvents })
  apply(ctx)
  const route = routes.get('/plugins/dsh-selection-tutor/api')

  const started = await callRoute(route, { parentSessionId: 'parent-1', mode: 'explain', selectionText: 'x', autoSend: false })
  assert.equal(started.body.ok, true)
  assert.equal(started.body.value.seedLength, 4, 'open parent turn is excluded from the seed')
  assert.equal(started.body.value.inheritedTurns, 1)
  assert.deepEqual(created[0].seed, parentEvents.slice(0, 4))
  assert.equal(created[0].meta.seedLength, 4)

  const history = await callRoute(route, { windowId: started.body.value.windowId }, 'tutor.history')
  assert.equal(history.body.ok, true)
  const texts = history.body.value.messages.flatMap(message => message.blocks).map(block => block.text)
  assert.equal(texts.includes('父会话问题'), false, 'seeded parent history must not appear in the window transcript')
  assert.equal(texts.includes('父会话回答'), false, 'seeded parent history must not appear in the window transcript')
  assert.equal(texts.includes('小窗问题'), true)
  assert.equal(texts.includes('小窗回答'), true)
})

test('tutor start falls back to an empty snapshot while the parent is still generating its first turn', async () => {
  const parentEvents = [
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮还在生成' }] } },
  ]
  const { ctx, routes, created } = makeContext({ parentEvents })
  apply(ctx)
  const route = routes.get('/plugins/dsh-selection-tutor/api')

  const started = await callRoute(route, { parentSessionId: 'parent-1', mode: 'translate', selectionText: 'x', autoSend: false })
  assert.equal(started.body.ok, true)
  assert.equal(started.body.value.seedLength, 0)
  assert.equal(started.body.value.inheritedTurns, 0)
  assert.equal(Object.hasOwn(created[0], 'seed'), false, 'no completed prefix means no seed payload')
  assert.equal(created[0].meta.seedLength, 0)
})
