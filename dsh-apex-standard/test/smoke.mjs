/**
 * Zero-dependency smoke test for apex-bootstrap.mjs.
 * Mocks the cordis ctx, captures the listeners, and drives phase
 * transitions with synthetic durable session events.
 *
 * Run: node test/smoke.mjs
 */
import * as plugin from '../preset/apex-bootstrap.mjs'
import { classifyReasoning } from '../preset/anchor-guardian.mjs'

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
const guardianRetry = (seq) => ({ type: 'user/message', seq, surfaceOp: { op: 'replace', start: 0, end: 0 }, data: { id: `r${seq}`, role: 'user', content: [{ type: 'text', text: 'retry' }], source: { kind: 'plugin', plugin: 'anchor-guardian', form: 'retry' } } })

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
check('pro promoted narrows to the resident set (7 tools)',
  names(await runAssemble(pro)), ['bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load', 'glob', 'grep'])

proEvents.push(toolCall(2, 'dev_tool_search', { toolNames: ['web_search', 'todo_write'] }))
checkSet('pro resident set grows with unlocked tools',
  names(await runAssemble(pro)),
  ['bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load', 'glob', 'grep', 'web_search', 'todo_write'])

proEvents.push(compactionEnd(3))
check('post-compaction controlled phase = bootstrap pair + compactionTools',
  names(await runAssemble(pro)), ['bash', 'str_replace_editor', 'read', 'edit', 'glob', 'grep'])

proEvents.push(toolCall(4, 'read'))
check('post-compaction re-promotion does NOT carry pre-compaction unlocks',
  names(await runAssemble(pro)), ['bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load', 'glob', 'grep'])

// ── Guardian retry boundary: fresh mode, NOT controlled mode ────────────
proEvents.push(guardianRetry(7))
check('post-guardian-retry fresh phase exposes the strict bootstrap pair (no compactionTools)',
  names(await runAssemble(pro)), ['bash', 'str_replace_editor'])
proEvents.push(toolCall(8, 'bash'))
check('post-guardian-retry re-promotion narrows to the resident set',
  names(await runAssemble(pro)), ['bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load', 'glob', 'grep'])

// ── replaceTools: post-bootstrap swap (Windows bash -> pwsh) ────────────
const swapListeners = harness({
  bootstrapTools: ['bash', 'str_replace_editor'],
  compactionTools: ['read', 'edit', 'glob', 'grep'],
  replaceTools: { bash: 'pwsh' },
})
const swapAssemble = swapListeners.get('system-prompt/assemble')[0].fn
const runSwap = (agent) => swapAssemble(null, { agent }, async () => assembled())
const swapEvents = []
const swapPro = makeAgent('deepseek-v4-pro', swapEvents)

check('swap: fresh request keeps the strict bootstrap pair (no swap before the anchor)',
  names(await runSwap(swapPro)), ['bash', 'str_replace_editor'])

swapEvents.push(toolCall(1, 'bash'))
check('swap: promoted resident set replaces bash with pwsh',
  names(await runSwap(swapPro)), ['pwsh', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load', 'glob', 'grep'])

swapEvents.push(compactionEnd(2))
check('swap: controlled phase keeps pwsh + compactionTools',
  names(await runSwap(swapPro)), ['pwsh', 'str_replace_editor', 'read', 'edit', 'glob', 'grep'])

swapEvents.push(toolCall(3, 'read'))
check('swap: re-promotion keeps the swap',
  names(await runSwap(swapPro)), ['pwsh', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load', 'glob', 'grep'])

// An explicit dev_tool_search unlock wins over the swap: the model asked
// for bash back, so the resident set keeps bash (and adds no pwsh).
swapEvents.push(toolCall(4, 'dev_tool_search', { toolNames: ['bash'] }))
check('swap: explicit bash unlock wins over the swap',
  names(await runSwap(swapPro)), ['bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load', 'glob', 'grep'])

// Flash promoted full catalog: the swap drops bash and keeps pwsh.
const swapFlashEvents = []
const swapFlash = makeAgent('deepseek-v4-flash', swapFlashEvents)
swapFlashEvents.push(toolCall(1, 'bash'))
checkSet('swap: flash promoted full catalog drops bash, keeps pwsh',
  names(await runSwap(swapFlash)), ALL_TOOLS.filter((n) => n !== 'bash'))

// Missing replacement: the original tool stays (graceful, no full fallback).
const missingSwapListeners = harness({ replaceTools: { bash: 'no_such_tool' } })
const missingSwapAssemble = missingSwapListeners.get('system-prompt/assemble')[0].fn
const runMissingSwap = (agent) => missingSwapAssemble(null, { agent }, async () => assembled())
const missingSwapEvents = []
const missingSwapPro = makeAgent('deepseek-v4-pro', missingSwapEvents)
missingSwapEvents.push(toolCall(1, 'bash'))
check('swap: missing replacement keeps the original tool',
  names(await runMissingSwap(missingSwapPro)), ['bash', 'str_replace_editor', 'dev_tool_search', 'skill_search', 'skill_load', 'glob', 'grep'])

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
    { role: 'user', source: { kind: 'plugin', plugin: 'time-context' } },
  ],
}))
check('bootstrap strips catalog+digest+time-context but keeps human and user skill gestures',
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
proEvents.push(compactionEnd(9))
proEvents.push(toolCall(10, 'bash'))
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
hintEvents.push(guardianRetry(4))
check('instruction-hint stays silent in the fresh phase after a guardian retry',
  hintCount(await hintStep(hintAgent)), 0)
hintEvents.push(toolCall(5, 'bash'))
check('instruction-hint re-fires after the guardian-retry attempt promotes',
  hintCount(await hintStep(hintAgent)), 1)

// ── custom-bash post-anchor lock (Windows bash -> pwsh guidance) ───────
const bashPlugin = await import('../preset/custom-bash.mjs')
const makeBashHarness = (config) => {
  const listeners = new Map()
  const registered = []
  const ctx = {
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
    },
    tools: { register: (def) => { registered.push(def); return () => {} } },
    subprocess: {
      resolveExecutable: async (cmd) => cmd,
      spawn: () => ({
        done: Promise.resolve({ exitCode: 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: 'ok' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }),
    },
    logger: { info: () => {}, warn: () => {} },
  }
  bashPlugin.apply(ctx, config)
  return { registered, listeners }
}

const bash1 = makeBashHarness({})
const bashTool = bash1.registered[0]
const bashEvents = []
const bashAgent = { session: { id: 'bash-s1', events: bashEvents, header: { cwd: 'C:\\proj' } } }
const runBash = () => bashTool.execute({ command: 'echo hi' }, { agent: bashAgent })
const outcome = (promise) => promise.then(() => 'ran', () => 'threw')

check('bash: executes during the fresh anchor phase', await outcome(runBash()), 'ran')
bashEvents.push(toolCall(1, 'bash'))
check('bash: locked after promotion', await outcome(runBash()), 'threw')
bashEvents.push(toolCall(2, 'dev_tool_search', { toolNames: ['bash'] }))
check('bash: explicit dev_tool_search unlock lifts the lock', await outcome(runBash()), 'ran')
bashEvents.push(compactionEnd(3))
check('bash: post-compaction controlled phase locks again', await outcome(runBash()), 'threw')
bashEvents.push(guardianRetry(4))
check('bash: guardian retry fresh phase allows bash again', await outcome(runBash()), 'ran')

const bash2 = makeBashHarness({ lockAfterPromotion: false })
const bashTool2 = bash2.registered[0]
const bashEvents2 = [toolCall(1, 'bash')]
const bashAgent2 = { session: { id: 'bash-s2', events: bashEvents2, header: {} } }
check('bash: lockAfterPromotion false disables the lock',
  await outcome(bashTool2.execute({ command: 'echo hi' }, { agent: bashAgent2 })), 'ran')

// ── bootstrapStrippedSections: pre-promotion prompt-section strip ────────
const stripListeners = harness({ bootstrapStrippedSections: ['tool:cordis'] })
const stripAssemble = stripListeners.get('system-prompt/assemble')[0].fn
const sectionsWithCordis = () => [
  { name: 'persona', text: 'persona' },
  { name: 'plan-mode', text: 'plan' },
  { name: 'tool:cordis', text: 'CORDIS_GUIDANCE' },
]
const runStrip = (agent) => stripAssemble(null, { agent }, async () => ({
  tools: ALL_TOOLS.map((name) => ({ name })),
  sections: sectionsWithCordis(),
}))
const sectionNames = (result) => result.sections.map((s) => s.name)

const stripEvents = []
const stripPro = makeAgent('deepseek-v4-pro', stripEvents)
check('strip: fresh anchor phase removes tool:cordis section, keeps others',
  sectionNames(await runStrip(stripPro)), ['persona', 'plan-mode'])
stripEvents.push(toolCall(1, 'bash'))
check('strip: promoted requests see the section again',
  sectionNames(await runStrip(stripPro)), ['persona', 'plan-mode', 'tool:cordis'])
stripEvents.push(compactionEnd(2))
check('strip: post-compaction controlled phase strips again',
  sectionNames(await runStrip(stripPro)), ['persona', 'plan-mode'])

const stripFlashEvents = []
const stripFlash = makeAgent('deepseek-v4-flash', stripFlashEvents)
check('strip: flash fresh anchor phase also strips the section',
  sectionNames(await runStrip(stripFlash)), ['plan-mode', 'apex-persona'])

const noStripListeners = harness({})
const noStripAssemble = noStripListeners.get('system-prompt/assemble')[0].fn
const noStripEvents = []
const noStripPro = makeAgent('deepseek-v4-pro', noStripEvents)
check('strip: absent config leaves sections untouched',
  sectionNames(await noStripAssemble(null, { agent: noStripPro }, async () => ({
    tools: ALL_TOOLS.map((name) => ({ name })),
    sections: sectionsWithCordis(),
  }))), ['persona', 'plan-mode', 'tool:cordis'])

// ── cordis-guard: idempotent Inspect provider registration ──────────────
const guardPlugin = await import('../preset/cordis-guard.mjs')
const guardProviders = new Map()
const guardRegistry = {
  register(registration) {
    const id = registration?.manifest?.id
    if (id === undefined) throw new Error('provider without id')
    if (guardProviders.has(id)) throw new Error(`Host Cordis inspect provider "${id}" is already registered`)
    guardProviders.set(id, registration)
    return () => { guardProviders.delete(id) }
  },
  list() {
    return [...guardProviders.values()].map((r) => ({ platform: 'host', id: r.manifest.id }))
  },
}
const guardEffects = []
guardPlugin.apply({
  cordisInspect: guardRegistry,
  effect: (cb) => { guardEffects.push(cb); return () => {} },
})
check('cordis-guard: first registration goes through', guardRegistry.register({ manifest: { id: 'Service' } }) !== undefined && guardProviders.has('Service'), true)
guardRegistry.register({ manifest: { id: 'Service' } })
check('cordis-guard: duplicate registration is a no-op instead of throwing', guardProviders.size, 1)
guardRegistry.register({ manifest: { id: 'Event' } })
check('cordis-guard: a new provider still registers through the patch', guardProviders.size, 2)
check('cordis-guard: patch is reversible via the effect disposer', guardEffects.length, 1)

// ── Guardian classifier ──────────────────────────────────────────────────
check('classifier labels we-without-let-me as anchored',
  classifyReasoning('We need inspect the repository before editing.'), { label: 'anchored', we: 1, letMe: 0 })
check('classifier labels let-me as standard-like',
  classifyReasoning('Let me run pwd and ls quickly.'), { label: 'standard-like', we: 0, letMe: 1 })
check('classifier labels neither marker as ambiguous',
  classifyReasoning('The task asks for a directory listing.'), { label: 'ambiguous', we: 0, letMe: 0 })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
