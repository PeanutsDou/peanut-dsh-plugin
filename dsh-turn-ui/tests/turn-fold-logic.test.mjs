import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Extract the actual grouping algorithm from the core-patch script so this
// test never drifts from what gets written into the DSH bundle.
const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'apply-core-patch.mjs')
const script = fs.readFileSync(scriptPath, 'utf8')
const start = script.indexOf('function turnFoldTurnOf')
const end = script.indexOf('\nfunction TurnFold', start)
if (start < 0 || end < 0) throw new Error('grouping function not found in patch script')
const buildTurnFoldRows = new Function(`${script.slice(start, end)}; return buildTurnFoldRows;`)()

function node(key, kind, turn, extra = {}) {
  return { key, kind, location: { kind: 'step', turn: { turn }, step: { step: 0 } }, ...extra }
}

test('all process nodes across turns collapse into ONE task container', () => {
  const map = new Map()
  const nodes = [
    node('u1', 'user', 1),
    node('a1', 'assistant-step', 1, { data: { status: 'settled', finalNode: { seq: 10 } } }),
    node('t1', 'tool-call', 1),
    node('a2', 'assistant-step', 1, { data: { status: 'settled', finalNode: { seq: 20 } } }),
    node('tail1', 'turn-tail', 1, { data: { closing: { finalNode: { seq: 20 } } } }),
    node('u2', 'user', 2),
    node('a3', 'assistant-step', 2, { data: { status: 'settled', finalNode: { seq: 30 } } }),
    node('t2', 'tool-call', 2),
    node('a4', 'assistant-step', 2, { data: { status: 'settled', finalNode: { seq: 40 } } }),
    node('tail2', 'turn-tail', 2, { data: { closing: { finalNode: { seq: 40 } } } }),
  ]
  for (const n of nodes) map.set(n.key, n)
  const timeline = {
    turns: new Map([
      [1, { status: 'closed', start: { time: 0 }, end: { time: 1000 } }],
      [2, { status: 'closed', start: { time: 2000 }, end: { time: 3000 } }],
    ]),
  }
  const rows = buildTurnFoldRows(nodes.map(n => n.key), map, timeline)

  const groups = rows.filter(r => r.kind === 'group')
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].nodes, ['a1', 't1', 'a3', 't2'])
  assert.equal(groups[0].toolCount, 2)
  assert.equal(groups[0].durationMs, 3000)

  const transcript = rows.filter(r => r.kind !== 'marker' && r.kind !== 'group').map(r => r.key)
  assert.deepEqual(transcript, ['u1', 'a2', 'tail1', 'u2', 'a4', 'tail2'])
})

test('running task keeps its single process container grouped', () => {
  const map = new Map()
  const nodes = [
    node('u1', 'user', 1),
    node('a1', 'assistant-step', 1, { data: { status: 'running' } }),
    node('t1', 'tool-call', 1),
  ]
  for (const n of nodes) map.set(n.key, n)
  const timeline = { turns: new Map([[1, { status: 'open', start: { time: 10 } }]]) }
  const rows = buildTurnFoldRows(nodes.map(n => n.key), map, timeline)
  const groups = rows.filter(r => r.kind === 'group')
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].nodes, ['a1', 't1'])
})

test('interrupted process marks the single container', () => {
  const map = new Map()
  const nodes = [
    node('u1', 'user', 1),
    node('a1', 'assistant-step', 1, { data: { status: 'interrupted', finalNode: { seq: 30 } } }),
    node('tail1', 'turn-tail', 1, { data: { closing: null } }),
  ]
  for (const n of nodes) map.set(n.key, n)
  const timeline = { turns: new Map([[1, { status: 'closed', start: { time: 0 }, end: { time: 500 } }]]) }
  const rows = buildTurnFoldRows(nodes.map(n => n.key), map, timeline)
  const group = rows.find(r => r.kind === 'group')
  assert.ok(group)
  assert.equal(group.interrupted, true)
})

test('single final reply produces no process container', () => {
  const map = new Map()
  const nodes = [
    node('u1', 'user', 1),
    node('a1', 'assistant-step', 1, { data: { status: 'settled', finalNode: { seq: 40 } } }),
    node('tail1', 'turn-tail', 1, { data: { closing: { finalNode: { seq: 40 } } } }),
  ]
  for (const n of nodes) map.set(n.key, n)
  const timeline = { turns: new Map([[1, { status: 'closed', start: { time: 0 }, end: { time: 10 } }]]) }
  const rows = buildTurnFoldRows(nodes.map(n => n.key), map, timeline)
  assert.equal(rows.filter(r => r.kind === 'group').length, 0)
})

test('turn markers are still emitted for the navigation rail', () => {
  const map = new Map()
  const nodes = [
    node('u1', 'user', 1),
    node('t1', 'tool-call', 1),
    node('a1', 'assistant-step', 1, { data: { status: 'settled', finalNode: { seq: 20 } } }),
    node('tail1', 'turn-tail', 1, { data: { closing: { finalNode: { seq: 20 } } } }),
  ]
  for (const n of nodes) map.set(n.key, n)
  const timeline = { turns: new Map([[1, { status: 'closed', start: { time: 0 }, end: { time: 10 } }]]) }
  const rows = buildTurnFoldRows(nodes.map(n => n.key), map, timeline)
  assert.ok(rows.some(r => r.kind === 'marker' && r.turn === 1))
})
