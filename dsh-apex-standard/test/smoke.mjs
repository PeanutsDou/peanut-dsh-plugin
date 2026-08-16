/**
 * Zero-dependency smoke test for apex-bootstrap.mjs.
 * Mocks the cordis ctx, captures the listeners, and drives phase
 * transitions with synthetic durable session events.
 *
 * Run: node test/smoke.mjs
 */
import * as plugin from '../preset/apex-bootstrap.mjs'

const ALL_TOOLS = [
  'bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load',
  'read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question',
  'web_search', 'subagent', 'workflow', 'pwsh',
]

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`PASS ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
  }
}

/** Order-insensitive comparison for tool-name lists. */
function checkSet(label, actual, expected) {
  check(label, [...actual].sort(), [...expected].sort())
}

function harness(config) {
  const listeners = new Map()
  const ctx = {
    on: (event, fn, opts) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ fn, opts })
    },
    logger: { warn: () => {}, info: () => {} },
  }
  plugin.apply(ctx, config)
  return listeners
}

let nextId = 0
function makeAgent(model, events) {
  nextId += 1
  return {
    options: { model },
    session: { id: `s${nextId}-${model}`, events, header: {} },
  }
}

function assembled() {
  return {
    tools: ALL_TOOLS.map((name) => ({ name })),
    sections: [{ name: 'persona', text: 'You are a helpful software engineer assistant.' }],
  }
}

const toolCall = (seq, name, args) => ({ type: 'tool/call', seq, data: { name, arguments: JSON.stringify(args ?? {}) } })
const compactionEnd = (seq) => ({ type: 'compaction/end', seq })

const listeners = harness({
  bootstrapTools: ['bash', 'str_replace_editor'],
  compactionTools: ['read', 'edit', 'glob', 'grep'],
  proDisciplineHint: true,
})
const assemble = listeners.get('system-prompt/assemble')[0].fn
const preStep = listeners.get('agent/pre-step')[0].fn
const runAssemble = (agent) => assemble(null, { agent }, async () => assembled())
const names = (result) => result.tools.map((t) => t.name)

// ── Pro path ────────────────────────────────────────────────────────────
const proEvents = []
const pro = makeAgent('deepseek-v4-pro', proEvents)

check('pro fresh request exposes only the bootstrap pair',
  names(await runAssemble(pro)), ['bash', 'str_replace_editor'])

proEvents.push(toolCall(1, 'bash'))
check('pro promoted narrows to the resident set (5 tools)',
  names(await runAssemble(pro)), ['bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load'])

proEvents.push(toolCall(2, 'dev_tool_search', { toolNames: ['web_search', 'todo_write'] }))
checkSet('pro resident set grows with unlocked tools',
  names(await runAssemble(pro)),
  ['bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load', 'web_search', 'todo_write'])

proEvents.push(compactionEnd(3))
check('post-compaction controlled phase = bootstrap pair + compactionTools',
  names(await runAssemble(pro)), ['bash', 'str_replace_editor', 'read', 'edit', 'glob', 'grep'])

proEvents.push(toolCall(4, 'read'))
check('post-compaction re-promotion does NOT carry pre-compaction unlocks',
  names(await runAssemble(pro)), ['bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load'])

// ── Pro discipline hint (opt-in enabled in this harness) ───────────────
const step1 = await preStep({ agent: pro }, async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'human' } }] }))
check('pro hint injected once after promotion',
  step1.messages.filter((m) => m.source?.kind === 'apex-discipline-hint').length, 1)
const step2 = await preStep({ agent: pro }, async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'human' } }] }))
check('pro hint not repeated',
  step2.messages.filter((m) => m.source?.kind === 'apex-discipline-hint').length, 0)
check('hint message carries an id (B8 regression guard)',
  typeof step1.messages[1].id === 'string' && step1.messages[1].id.length > 0, true)

// ── Bootstrap-phase strip ───────────────────────────────────────────────
const freshEvents = []
const fresh = makeAgent('deepseek-v4-pro', freshEvents)
const stripped = await preStep({ agent: fresh }, async () => ({
  kind: 'enter',
  messages: [
    { role: 'user', source: { kind: 'human' } },
    { role: 'user', source: { kind: 'skill-catalog' } },
    { role: 'user', source: { kind: 'agent-instructions' } },
    { role: 'user', source: { kind: 'skill-invocation' } },
  ],
}))
check('bootstrap strips catalog+digest but keeps human and user skill gestures',
  stripped.messages.map((m) => m.source.kind), ['human', 'skill-invocation'])

// ── Flash path ──────────────────────────────────────────────────────────
const flashEvents = []
const flash = makeAgent('deepseek-v4-flash', flashEvents)
const flashFirst = await runAssemble(flash)
check('flash fresh request exposes only the bootstrap pair',
  names(flashFirst), ['bash', 'str_replace_editor'])
check('flash persona is the god-mode persona',
  flashFirst.sections[0].text.includes('decide the task type (build or fix)')
  && flashFirst.sections[0].text.includes('end each reasoning block with a decision'), true)

flashEvents.push(toolCall(1, 'bash'))
const flashPromoted = await runAssemble(flash)
check('flash promoted exposes the full catalog',
  names(flashPromoted).length, ALL_TOOLS.length)
const flashStep = await preStep({ agent: flash }, async () => ({ kind: 'enter', messages: [] }))
check('flash never gets the pro discipline hint',
  flashStep.messages.filter((m) => m.source?.kind === 'apex-discipline-hint').length, 0)

// ── Fail-soft: missing bootstrap tools degrade to the full catalog ──────
const degrade = await assemble(null, { agent: makeAgent('deepseek-v4-pro', []) }, async () => ({ tools: [{ name: 'read' }], sections: [] }))
check('missing bootstrap tools degrade to full catalog',
  names(degrade), ['read'])

// ── v1.2.0: per-epoch Pro discipline hint ───────────────────────────────
// `pro` already got the hint in epoch -1 above. Push a compaction boundary
// and re-promote: the hint must fire ONE more time for the new epoch.
proEvents.push(compactionEnd(5))
proEvents.push(toolCall(6, 'bash'))
const step3 = await preStep({ agent: pro }, async () => ({ kind: 'enter', messages: [] }))
check('pro discipline hint re-fires once per epoch (post-compaction)',
  step3.messages.filter((m) => m.source?.kind === 'apex-discipline-hint').length, 1)
const step4 = await preStep({ agent: pro }, async () => ({ kind: 'enter', messages: [] }))
check('pro discipline hint not repeated within the same epoch',
  step4.messages.filter((m) => m.source?.kind === 'apex-discipline-hint').length, 0)

// ── v1.2.0: instruction-hint, per-epoch, WITHOUT any session/event feed ──
// (This is the rc.6 path: observe() is never called; growth-rescan must
// carry every transition. Regression: upstream pinned the memo unpromoted
// and the hint never fired at all.)
const hintPlugin = await import('../preset/instruction-hint.mjs')
const hintListeners = new Map()
const hintCtx = {
  on: (event, fn, opts) => {
    if (!hintListeners.has(event)) hintListeners.set(event, [])
    hintListeners.get(event).push({ fn, opts })
  },
  get: (service) => service === 'fs' ? {
    resolve: async (p) => p,
    stat: async (p) => (/\.git$/.test(p) || /AGENTS\.md$/.test(p)) ? { type: 'file' } : undefined,
  } : undefined,
  logger: { warn: () => {}, info: () => {} },
}
hintPlugin.apply(hintCtx, {})
const hintPreStep = hintListeners.get('agent/pre-step')[0].fn

const hintEvents = []
const hintAgent = { options: {}, session: { id: 'hint-s1', events: hintEvents, header: { cwd: 'C:\\proj' } } }
const hintStep = (agent) => hintPreStep({ agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
const hintCount = (d) => d.messages.filter((m) => m.source?.kind === 'instruction-hint').length

check('instruction-hint silent before promotion', hintCount(await hintStep(hintAgent)), 0)
hintEvents.push(toolCall(1, 'bash'))
check('instruction-hint fires after promotion (no event feed, growth rescan)',
  hintCount(await hintStep(hintAgent)), 1)
check('instruction-hint not repeated within the epoch',
  hintCount(await hintStep(hintAgent)), 0)
hintEvents.push(compactionEnd(2))
check('instruction-hint stays silent in the post-compaction controlled phase',
  hintCount(await hintStep(hintAgent)), 0)
hintEvents.push(toolCall(3, 'bash'))
check('instruction-hint re-fires in the new epoch after re-promotion',
  hintCount(await hintStep(hintAgent)), 1)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
