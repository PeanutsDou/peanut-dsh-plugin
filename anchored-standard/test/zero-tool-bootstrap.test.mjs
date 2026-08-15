import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../zero-anchored-standard/zero-tool-bootstrap.mjs'

function register() {
  let listener
  const warns = []
  const ctx = {
    on(event, callback) {
      assert.equal(event, 'system-prompt/assemble')
      listener = callback
    },
    logger: {
      warn(message) {
        warns.push(message)
      },
    },
  }
  apply(ctx)
  assert.equal(typeof listener, 'function')
  return { listener, warns }
}

function assemble(listener, events, tools, header = {}, id = 's') {
  return listener(
    undefined,
    { agent: { session: { id, events, header } } },
    async () => ({ system: 'minimal persona', tools }),
  )
}

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'zero-tool-bootstrap')
})

test('the first top-level request exposes zero tools', async () => {
  const { listener } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }]
  const result = await assemble(listener, [], tools)
  assert.deepEqual(result.tools, [])
})

test('a durable assistant message promotes the complete catalog', async () => {
  const { listener } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }, { name: 'grep' }]
  const result = await assemble(listener, [{ type: 'assistant/message', data: {} }], tools)
  assert.deepEqual(result.tools, tools)
})

test('subagents see the full catalog from their first request', async () => {
  const { listener } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }]
  const result = await assemble(listener, [], tools, { delegationDepth: 1 })
  assert.deepEqual(result.tools, tools)
})

test('an assembly outside an agent keeps the full catalog', async () => {
  const { listener } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }]
  const result = await listener(undefined, { agent: undefined }, async () => ({ tools }))
  assert.deepEqual(result.tools, tools)
})

test('promotion is memoized per session id within one process', async () => {
  const { listener } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }]
  const promoted = await assemble(listener, [{ type: 'assistant/message' }], tools, {}, 'memo')
  assert.deepEqual(promoted.tools, tools)
  // Same session id, events now empty: the cached decision still promotes.
  const again = await assemble(listener, [], tools, {}, 'memo')
  assert.deepEqual(again.tools, tools)
})

test('sessions derive promotion independently from their own events', async () => {
  const { listener } = register()
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }]
  const promoted = await assemble(listener, [{ type: 'assistant/message' }], tools, {}, 'a')
  const fresh = await assemble(listener, [], tools, {}, 'b')
  assert.deepEqual(promoted.tools, tools)
  assert.deepEqual(fresh.tools, [])
})
