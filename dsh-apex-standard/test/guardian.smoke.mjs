/**
 * Zero-dependency smoke test for anchor-guardian.mjs with a minimal fake
 * Session surface. Run: node test/guardian.smoke.mjs
 */
import { apply, classifyReasoning } from '../preset/anchor-guardian.mjs'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) console.log(`PASS ${label}`)
  else { failures += 1; console.log(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`) }
}

function fakeSession() {
  const session = {
    events: [],
    surface: { nodes: [] },
    append(type, data, opts = {}) {
      const seq = this.events.length
      const event = { type, seq, time: Date.now(), data, ...(opts.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp }), ...(opts.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }) }
      this.events.push(event)
      if (opts.surfaceOp === 'append') this.surface.nodes.push(seq)
      if (opts.surfaceOp?.op === 'replace') {
        const start = this.surface.nodes.indexOf(opts.surfaceOp.start)
        const end = this.surface.nodes.indexOf(opts.surfaceOp.end)
        this.surface.nodes.splice(start, end - start + 1, seq)
      }
      for (const fn of this.listeners) fn(session, event)
      return event
    },
    listeners: [],
  }
  return session
}

function fakeAgent(session) {
  return {
    session,
    cancelled: [],
    followups: [],
    steers: [],
    cancel(cause) { this.cancelled.push(cause) },
    followup(message) { this.followups.push(message) },
    steer(message) { this.steers.push(message) },
  }
}

function harness(config = {}) {
  const listeners = new Map()
  const ctx = {
    on: (event, fn, opts) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ fn, opts })
    },
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx, config)
  return listeners
}

const listeners = harness({ maxAttempts: 3, earlyAbort: true, wakeMode: 'followup' })
const session = fakeSession()
const agent = fakeAgent(session)
session.header = { delegationDepth: 0 }

// Record the agent handle through the assemble listener.
await listeners.get('system-prompt/assemble')[0].fn(null, { agent }, async () => ({ tools: [], sections: [] }))

// Initial turn and a shallow first assistant message.
session.events.push({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })
const assistant = {
  type: 'assistant/message', seq: 1, time: 2,
  data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'Let me run pwd and ls quickly.' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } },
  surfaceOp: 'append',
}
const assistantEvent = session.append(assistant.type, assistant.data, { surfaceOp: 'append', sourceEventSeqs: [] })
listeners.get('session/event')[0].fn(session, assistantEvent)
check('early abort cancels a shallow first response',
  agent.cancelled.length, 1)

listeners.get('agent/status')[0].fn({ agent, status: 'idle' })
await new Promise((resolve) => setImmediate(resolve))
const retry = session.events.find((event) => event.type === 'user/message' && event.surfaceOp?.op === 'replace')
check('idle path lands a surface-replacing retry node', retry !== undefined, true)
check('retry node carries every shadowed seq', retry.sourceEventSeqs, [1])
check('idle path wakes a followup turn', agent.followups.length, 1)

// Second attempt: fresh turn, anchored first response.
session.append('turn/start', { turn: 2 })
const secondEvent = session.append('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'reasoning', text: 'We need inspect the output before answering.' }] } }, { surfaceOp: 'append', sourceEventSeqs: [] })
listeners.get('session/event')[0].fn(session, secondEvent)
check('anchored retry attempt is released without another cancel', agent.cancelled.length, 1)

check('classifier sanity', classifyReasoning('We need check the file.').label, 'anchored')
check('classifier shallow', classifyReasoning('Let me check the file.').label, 'standard-like')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
