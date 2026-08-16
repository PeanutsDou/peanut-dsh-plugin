import test from 'node:test'
import assert from 'node:assert/strict'

// Mirrors buildTurnFoldRows from scripts/apply-core-patch.mjs. Kept as a pure
// Node copy so grouping regressions fail without booting the browser bundle.
function turnFoldTurnOf(node) {
  const loc = node && node.location
  return loc && (loc.kind === 'step' || loc.kind === 'turn') ? loc.turn.turn : null
}

function buildTurnFoldRows(order, nodeStore, timeline) {
  const entries = []
  for (const key of order) {
    const node = nodeStore.get(key)
    if (node === undefined) continue
    entries.push({ key, node, turn: turnFoldTurnOf(node) })
  }

  const closingSeqByTurn = new Map()
  for (const entry of entries) {
    const node = entry.node
    if (entry.turn === null || node.kind !== 'turn-tail') continue
    const closing = node.data?.closing ?? null
    if (closing?.finalNode) closingSeqByTurn.set(entry.turn, closing.finalNode.seq)
  }

  const finalKeyByTurn = new Map()
  for (const entry of entries) {
    const node = entry.node
    if (entry.turn === null || node.kind !== 'assistant-step') continue
    const finalNode = node.data?.finalNode ?? null
    if (finalNode && finalNode.seq === closingSeqByTurn.get(entry.turn)) {
      finalKeyByTurn.set(entry.turn, entry.key)
    }
  }

  const processKinds = new Set(['assistant-step', 'tool-call', 'model-retry', 'manual-compaction'])
  const rows = []
  let currentTurn = null
  let group = null
  const flushGroup = () => {
    if (group === null) return
    const toolCount = group.nodes.filter(item => item.node.kind === 'tool-call').length
    const interrupted = group.nodes.some(item => item.node.kind === 'assistant-step' && item.node.data?.status === 'interrupted')
    const turn = timeline.turns.get(group.turn)
    const durationMs = turn?.start && turn?.end ? Math.max(0, turn.end.time - turn.start.time) : null
    rows.push({ kind: 'group', turn: group.turn, nodes: group.nodes.map(item => item.key), toolCount, interrupted, durationMs })
    group = null
  }

  for (const entry of entries) {
    if (entry.turn !== currentTurn) {
      flushGroup()
      currentTurn = entry.turn
      if (entry.turn !== null) rows.push({ kind: 'marker', turn: entry.turn })
    }
    const node = entry.node
    const isFinal = entry.turn !== null && entry.key === finalKeyByTurn.get(entry.turn)
    const isProcess = entry.turn !== null && processKinds.has(node.kind) && !isFinal
    if (isProcess) {
      if (group === null || group.turn !== entry.turn) {
        flushGroup()
        group = { turn: entry.turn, nodes: [] }
      }
      group.nodes.push(entry)
    } else {
      flushGroup()
      rows.push({ kind: 'node', key: entry.key })
    }
  }
  flushGroup()
  return rows
}

function node(key, kind, turn, extra = {}) {
  return { key, kind, location: { kind: 'step', turn: { turn }, step: { step: 0 } }, ...extra }
}

test('completed turn folds tools and process assistants but keeps user, final, and tail', () => {
  const map = new Map()
  const nodes = [
    node('u1', 'user', 1),
    node('a1', 'assistant-step', 1, { data: { status: 'settled', finalNode: { seq: 10 } } }),
    node('t1', 'tool-call', 1),
    node('a2', 'assistant-step', 1, { data: { status: 'settled', finalNode: { seq: 20 } } }),
    node('tail1', 'turn-tail', 1, { data: { closing: { finalNode: { seq: 20 } } } }),
  ]
  for (const n of nodes) map.set(n.key, n)
  const timeline = { turns: new Map([[1, { status: 'closed', start: { time: 0 }, end: { time: 1000 } }]]) }
  const rows = buildTurnFoldRows(nodes.map(n => n.key), map, timeline)

  assert.deepEqual(rows.map(r => r.kind), ['marker', 'node', 'group', 'node', 'node'])
  assert.equal(rows[1].key, 'u1')
  assert.deepEqual(rows[2].nodes, ['a1', 't1'])
  assert.equal(rows[2].toolCount, 1)
  assert.equal(rows[2].interrupted, false)
  assert.equal(rows[3].key, 'a2')
  assert.equal(rows[4].key, 'tail1')
})

test('running turn stays grouped and has no final candidate yet', () => {
  const map = new Map()
  const nodes = [
    node('u2', 'user', 2),
    node('a3', 'assistant-step', 2, { data: { status: 'running' } }),
    node('t2', 'tool-call', 2),
  ]
  for (const n of nodes) map.set(n.key, n)
  const timeline = { turns: new Map([[2, { status: 'open', start: { time: 10 } }]]) }
  const rows = buildTurnFoldRows(nodes.map(n => n.key), map, timeline)

  assert.deepEqual(rows.map(r => r.kind), ['marker', 'node', 'group'])
  assert.deepEqual(rows[2].nodes, ['a3', 't2'])
  assert.equal(rows[2].durationMs, null)
})

test('interrupted process marks the group summary', () => {
  const map = new Map()
  const nodes = [
    node('u3', 'user', 3),
    node('a4', 'assistant-step', 3, { data: { status: 'interrupted', finalNode: { seq: 30 } } }),
    node('tail3', 'turn-tail', 3, { data: { closing: null } }),
  ]
  for (const n of nodes) map.set(n.key, n)
  const timeline = { turns: new Map([[3, { status: 'closed', start: { time: 0 }, end: { time: 500 } }]]) }
  const rows = buildTurnFoldRows(nodes.map(n => n.key), map, timeline)
  const group = rows.find(r => r.kind === 'group')
  assert.ok(group)
  assert.equal(group.interrupted, true)
})

test('single final reply produces no process group', () => {
  const map = new Map()
  const nodes = [
    node('u4', 'user', 4),
    node('a5', 'assistant-step', 4, { data: { status: 'settled', finalNode: { seq: 40 } } }),
    node('tail4', 'turn-tail', 4, { data: { closing: { finalNode: { seq: 40 } } } }),
  ]
  for (const n of nodes) map.set(n.key, n)
  const timeline = { turns: new Map([[4, { status: 'closed', start: { time: 0 }, end: { time: 10 } }]]) }
  const rows = buildTurnFoldRows(nodes.map(n => n.key), map, timeline)
  assert.equal(rows.filter(r => r.kind === 'group').length, 0)
})
