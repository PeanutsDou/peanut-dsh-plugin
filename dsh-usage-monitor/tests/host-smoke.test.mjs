import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-monitor-smoke-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')

test('host apply wires session usage events into ledger and serves the status route', async () => {
  const routes = new Map()
  const effects = []
  const listeners = new Map()
  const ctx = {
    get(name) {
      if (name === 'webServer') return {
        register(route) {
          routes.set(route.path, route)
          return () => {}
        },
      }
      if (name === 'credentials') return {
        resolve: async () => undefined,
      }
      return undefined
    },
    inject(_names, callback) {
      // settings section is optional in this smoke test; keep defaults.
      return () => {}
    },
    on(name, callback) {
      const list = listeners.get(name) ?? []
      list.push(callback)
      listeners.set(name, list)
      return () => {}
    },
    effect(callback) {
      const dispose = callback()
      effects.push(() => {
        if (typeof dispose === 'function') dispose()
      })
      return () => {}
    },
    logger: { warn() {}, error() {} },
  }

  apply(ctx, { balanceUrl: 'http://127.0.0.1:9', balancePollMs: 60000 })

  const session = { id: 'smoke-session', header: { cwd: 'D:\\demo' } }
  const emit = (event) => {
    for (const listener of listeners.get('session/event') ?? []) listener(session, event)
  }

  // chunk usage then final message usage for the same step: only final counts.
  emit({
    type: 'assistant/chunk',
    data: { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } } },
  })
  emit({
    type: 'assistant/message',
    data: { turn: 1, step: 2, message: {}, usage: { inputTokens: 120, outputTokens: 25, cacheReadTokens: 80, cacheWriteTokens: 4 } },
  })
  emit({
    type: 'session/title',
    data: { title: '冒烟会话' },
  })

  const statusRoute = routes.get('/plugins/dsh-usage-monitor/status')
  assert.ok(statusRoute, 'status route registered')
  assert.ok(routes.has('/plugins/dsh-usage-monitor/refresh-balance'), 'refresh route registered')

  let body = ''
  const res = {
    writeHead() {},
    end(chunk) { body = typeof chunk === 'string' ? chunk : chunk.toString() },
  }
  statusRoute.handler({ method: 'GET' }, res)
  const status = JSON.parse(body)
  assert.equal(status.ok, true)
  assert.equal(status.usage.allTime.uncachedInputTokens, 120)
  assert.equal(status.usage.allTime.outputTokens, 25)
  assert.equal(status.usage.allTime.cacheReadTokens, 80)
  assert.equal(status.usage.allTime.cacheWriteTokens, 4)
  assert.equal(status.usage.allTime.costCny, 0.000524)
  assert.equal(status.usage.today.uncachedInputTokens, 120)
  assert.equal(status.usage.todayCost, 0.000524)
  assert.equal(status.usage.weekCost, 0.000524)
  assert.ok(Array.isArray(status.usage.days) && status.usage.days.length === 7)
  assert.ok(Array.isArray(status.usage.months) && status.usage.months.length === 12)
  assert.equal(typeof status.balance.error, 'string')

  // flush lifecycle save
  for (const effect of effects) effect()
  const stateFile = path.join(home, 'usage-monitor', 'state.json')
  assert.ok(fs.existsSync(stateFile), 'ledger persisted on dispose')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(saved.allTime.uncachedInputTokens, 120)
})
