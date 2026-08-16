/**
 * anchor-guardian — release gate for the apex anchored trajectory.
 *
 * The bootstrap fixes the first request surface (Minimal-exact tools, bare
 * persona, no skill/instruction/time injections), but the model still lands
 * in the shallow ("Let me") trajectory ~30% of the time. This plugin adds a
 * RELEASE GATE around that first response:
 *
 *  - classify the FIRST reasoning block of the current attempt
 *    (`we` present and no `let me` = anchored; everything else = shallow);
 *  - on the live `session/event` feed, a shallow first response aborts the
 *    turn BEFORE its tool calls run (`earlyAbort`), so the failed attempt
 *    costs one model response, not a whole tool loop;
 *  - the failed attempt's surface nodes are then REPLACED by one fresh user
 *    node (the same durable surface mechanism compaction uses), and
 *    `agent.followup()` starts the next attempt automatically;
 *  - after `maxAttempts` the gate FAILS OPEN: the session continues with
 *    normal promotion instead of looping forever.
 *
 * Every state transition is derived from durable events, so resume/reload
 * reconstructs the same phase without the live feed (`turn-stopping` is the
 * fallback trigger when `session/event` is unavailable).
 */

import { GUARDIAN_RETRY_FORM, GUARDIAN_SOURCE_PLUGIN, GUARDIAN_WAKE_FORM, isGuardianRetryBoundary } from './guardian-boundary.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchor-guardian'

const DEFAULT_MAX_ATTEMPTS = 3

const DEFAULT_RETRY_PREFIX = 'Start over from scratch. The previous response was discarded because it did not reach the required anchored reasoning trajectory. Original request:'
const DEFAULT_WAKE_TEXT = 'Continue from the instruction immediately above.'

/** Count one whole-word occurrence (no stateful regex). */
function countWord(text, regex) {
  return [...text.matchAll(regex)].length
}

/**
 * Anchor classifier for the release gate. Deliberately the same relaxation
 * as the liangshen gate: `we` presence without `let me` is the stable
 * surface marker of the anchored trajectory; a block containing `let me` is
 * standard-like; neither marker is treated as shallow (strict gate).
 */
export function classifyReasoning(text) {
  const trimmed = String(text ?? '').trim()
  const we = countWord(trimmed, /\bwe\b/gi)
  const letMe = countWord(trimmed, /\blet me\b/gi)
  if (we > 0 && letMe === 0) return { label: 'anchored', we, letMe }
  if (letMe > 0) return { label: 'standard-like', we, letMe }
  return { label: 'ambiguous', we, letMe }
}

/** First reasoning block text of an assistant message, if any. */
function firstReasoningText(message) {
  const block = message?.content?.find((part) => part?.type === 'reasoning')
  return typeof block?.text === 'string' ? block.text : ''
}

/** First direct user task recorded in the session (survives retry shadowing). */
function originalTask(session) {
  for (const event of session.events) {
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const text = event.data.content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join(' ')
      if (text.length > 0) return text
    }
  }
  return ''
}

function optionalBoolean(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${name}: ${field} must be a boolean`)
  return value
}

function optionalPositiveInt(value, field, fallback) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name}: ${field} must be an integer >= 1`)
  return value
}

function optionalString(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name}: ${field} must be a non-empty string`)
  return value
}

/**
 * Register the release gate.
 *
 * @param ctx - agent-scoped cordis context.
 * @param config - `{ enabled, maxAttempts, earlyAbort, wakeMode, retryOnCompaction, retryPrefix, wakeText }`.
 */
export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const allowed = new Set(['enabled', 'maxAttempts', 'earlyAbort', 'wakeMode', 'retryOnCompaction', 'retryPrefix', 'wakeText'])
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new TypeError(`${name}: unknown config key ${JSON.stringify(key)}`)
  }
  const enabled = optionalBoolean(source.enabled, 'enabled', true)
  const maxAttempts = optionalPositiveInt(source.maxAttempts, 'maxAttempts', DEFAULT_MAX_ATTEMPTS)
  const earlyAbort = optionalBoolean(source.earlyAbort, 'earlyAbort', true)
  const retryOnCompaction = optionalBoolean(source.retryOnCompaction, 'retryOnCompaction', true)
  const wakeMode = source.wakeMode ?? 'followup'
  if (wakeMode !== 'followup' && wakeMode !== 'steer') {
    throw new TypeError(`${name}: wakeMode must be "followup" or "steer"`)
  }
  const retryPrefix = optionalString(source.retryPrefix, 'retryPrefix', DEFAULT_RETRY_PREFIX)
  const wakeText = optionalString(source.wakeText, 'wakeText', DEFAULT_WAKE_TEXT)

  /** session -> live gate state */
  const stateBySession = new WeakMap()
  /** session -> agent handle (the pre-step/assemble listeners are the reliable source) */
  const agentBySession = new WeakMap()

  const stateFor = (session) => {
    let state = stateBySession.get(session)
    if (state === undefined) {
      state = {
        scanned: 0,
        attempts: 0, // retry boundaries already recorded for the current epoch
        released: false,
        attemptTurn: 0,
        retriedForTurn: 0,
        pendingAbort: false,
        classification: undefined,
      }
      stateBySession.set(session, state)
    }
    return state
  }

  /**
   * Fold every event we have not seen yet into the gate state. Cold start,
   * resume, and a missing live feed all converge here.
   */
  const refresh = (session) => {
    const state = stateFor(session)
    for (; state.scanned < session.events.length; state.scanned += 1) {
      const event = session.events[state.scanned]
      if (event === undefined) continue
      if (event.type === 'compaction/end') {
        state.attempts = 0
        state.released = false
        state.attemptTurn = 0
        state.retriedForTurn = 0
        state.pendingAbort = false
        state.classification = undefined
        if (!retryOnCompaction) state.released = true
        continue
      }
      if (isGuardianRetryBoundary(event)) {
        state.attempts += 1
        state.released = false
        state.attemptTurn = 0
        state.retriedForTurn = 0
        state.pendingAbort = false
        state.classification = undefined
        continue
      }
      if (event.type === 'turn/start') {
        state.attemptTurn ||= event.data?.turn ?? 0
        continue
      }
      if (event.type !== 'assistant/message') continue
      if (state.released || state.attemptTurn === 0) continue
      if (event.data?.turn !== state.attemptTurn) continue
      if (state.classification === undefined) {
        const reasoning = firstReasoningText(event.data?.message)
        state.classification = classifyReasoning(reasoning)
        if (state.classification.label === 'anchored') state.released = true
      }
    }
    return state
  }

  /** True for top-level sessions this gate owns. */
  const ownsSession = (agent) => agent?.session?.header?.delegationDepth === undefined
    || agent.session.header.delegationDepth === 0

  const logInfo = (message) => {
    try { ctx.logger.info(message) } catch { /* logging must never break the session */ }
  }
  const logWarn = (message) => {
    try { ctx.logger.warn(message) } catch { /* logging must never break the session */ }
  }

  /** Replace the failed attempt surface with one fresh retry node and wake. */
  const retryNow = (agent, trigger) => {
    if (!enabled) return false
    const session = agent.session
    const state = refresh(session)
    if (state.released || state.retriedForTurn === state.attemptTurn) return false
    if (state.attempts + 1 >= maxAttempts) {
      // Final attempt already ran: fail open instead of looping.
      state.released = true
      logWarn(`${name}: session ${session.id} exhausted ${maxAttempts} anchor attempt(s); releasing without an anchored first block`)
      return false
    }
    const nodes = session.surface.nodes
    if (nodes.length === 0) {
      logWarn(`${name}: session ${session.id} has no surface nodes to replace; skipping retry`)
      return false
    }
    const shadowedSeqs = [...nodes]
    try {
      session.append('user/message', {
        id: `anchor-guardian-retry-${session.id}-${state.attemptTurn}`,
        role: 'user',
        content: [{
          type: 'text',
          text: `${retryPrefix}\n\n${originalTask(session)}`,
        }],
        source: { kind: 'plugin', plugin: GUARDIAN_SOURCE_PLUGIN, form: GUARDIAN_RETRY_FORM },
      }, {
        surfaceOp: { op: 'replace', start: nodes[0], end: nodes[nodes.length - 1] },
        sourceEventSeqs: shadowedSeqs,
      })
    } catch (error) {
      state.pendingAbort = false
      logWarn(`${name}: surface replacement failed, releasing session ${session.id}: ${String((error && error.message) || error)}`)
      state.released = true
      return false
    }
    state.retriedForTurn = state.attemptTurn
    state.pendingAbort = false
    const wake = {
      id: `anchor-guardian-wake-${session.id}-${state.attemptTurn}`,
      role: 'user',
      content: [{ type: 'text', text: wakeText }],
      source: { kind: 'plugin', plugin: GUARDIAN_SOURCE_PLUGIN, form: GUARDIAN_WAKE_FORM },
    }
    // The early-abort path retries from `agent/status` idle, where a new
    // turn is the only reliable wake. The turn-stopping fallback honors the
    // configured mode; followup is the default and the tested default path.
    try {
      if (trigger === 'early-abort-idle' || wakeMode === 'followup') agent.followup(wake)
      else agent.steer(wake)
    } catch (error) {
      state.pendingAbort = false
      logWarn(`${name}: wake failed, releasing session ${session.id}: ${String((error && error.message) || error)}`)
      state.released = true
      return false
    }
    logInfo(`${name}: session ${session.id} retrying after ${trigger} (attempt ${state.attempts + 2}/${maxAttempts}, ${state.classification?.label ?? 'unclassified'})`)
    return true
  }

  // system-prompt/assemble only records the agent handle; it never changes
  // the catalog. apex-bootstrap owns the catalog and reads the SAME retry
  // boundary predicate from guardian-boundary.mjs.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (context.agent !== undefined) agentBySession.set(context.agent.session, context.agent)
    return assembled
  }, { prepend: true })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (agent !== undefined) {
      agentBySession.set(agent.session, agent)
      refresh(agent.session)
    }
    return decision
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    if (!enabled) return
    const state = refresh(session)
    if (!earlyAbort || state.released || state.pendingAbort) return
    if (event.type !== 'assistant/message') return
    if (event.data?.turn !== state.attemptTurn) return
    // Final attempt must be allowed to run to completion: the user gets an
    // answer even when the last anchor also misses.
    if (state.attempts + 1 >= maxAttempts) return
    if (state.classification === undefined) return
    if (state.classification.label === 'anchored') return
    if (state.retriedForTurn === state.attemptTurn) return
    state.pendingAbort = true
    const agent = agentBySession.get(session)
    if (agent === undefined || !ownsSession(agent)) {
      state.pendingAbort = false
      return
    }
    try {
      agent.cancel({ kind: 'hook', reason: 'anchor-guardian: shallow first response' })
    } catch (error) {
      state.pendingAbort = false
      logWarn(`${name}: early abort failed for session ${session.id}: ${String((error && error.message) || error)}`)
    }
  })

  // Fallback trigger for environments without a live session/event feed.
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!enabled || agent === undefined) return
    agentBySession.set(agent.session, agent)
    const session = agent.session
    const state = refresh(session)
    if (!ownsSession(agent)) return
    if (state.pendingAbort || state.released || state.retriedForTurn === state.attemptTurn) return
    if (state.classification === undefined) return
    if (state.classification.label === 'anchored') {
      state.released = true
      return
    }
    if (turn !== state.attemptTurn) return
    if (state.attempts + 1 >= maxAttempts) {
      state.released = true
      logWarn(`${name}: session ${session.id} exhausted ${maxAttempts} anchor attempt(s); releasing at turn stop`)
      return
    }
    retryNow(agent, 'turn-stopping')
  })

  // Early-abort retry: an aborted turn skips turn-stopping, so the retry is
  // scheduled once the driver reaches idle and the turn boundary committed.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || !enabled) return
    const session = agent.session
    const state = stateBySession.get(session)
    if (state === undefined || !state.pendingAbort || state.retriedForTurn === state.attemptTurn) return
    const target = agent
    queueMicrotask(() => {
      try { retryNow(target, 'early-abort-idle') } catch (error) {
        try { ctx.logger.warn(`${name}: idle retry failed: ${String((error && error.message) || error)}`) } catch {}
      }
    })
  })
}
