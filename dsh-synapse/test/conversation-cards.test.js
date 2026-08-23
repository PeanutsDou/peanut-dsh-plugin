import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadConversationCards() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const start = source.indexOf('function overlapsCard')
  const end = source.indexOf('function canvasConnectors')
  const context = { globalThis: {}, CARD_WIDTH: 310, CARD_HEIGHT: 276, CARD_GAP_Y: 42, CAMERA_INSET_X: 56, CAMERA_INSET_Y: 56, messagesFor: thread => thread.messages, FILE_MODIFY_TOOLS: new Set(['write_file', 'write', 'edit', 'edit_file', 'str_replace_editor', 'apply_patch']), state: { branchAnchors: new Map(), cardPositions: new Map(), liveReplies: new Map(), collapsedCardIds: new Set() } }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.conversationCards = conversationCards;globalThis.conversationGraphView = conversationGraphView;globalThis.initialCanvasCamera = initialCanvasCamera`, context)
  return { conversationCards: context.globalThis.conversationCards, conversationGraphView: context.globalThis.conversationGraphView, initialCanvasCamera: context.globalThis.initialCanvasCamera, state: context.state }
}

test('aggregates every user question in one DSH session into a single summary card using the first round', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 1 },
      { kind: 'assistant', text: '第一个回答草稿', sourceSeq: 2 },
      { kind: 'assistant', text: '第一个最终回答', sourceSeq: 3 },
      { kind: 'user', text: '第二个问题', sourceSeq: 4 },
      { kind: 'assistant', text: '第二个最终回答', sourceSeq: 5 },
    ],
  }])

  assert.equal(cards.length, 1)
  assert.equal(cards[0].question, '第一个问题')
  assert.equal(cards[0].answer.text, '第一个最终回答')
  assert.equal(cards[0].totalTurns, 2)
  assert.equal(cards[0].kind, 'session')
  assert.equal(cards[0].canContinue, true)
})

test('marks sessions that used file-modifying tools as document nodes', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-doc', parentId: null,
    messages: [
      { kind: 'user', text: '帮我改一下代码', sourceSeq: 1 },
      {
        kind: 'assistant', text: '已修改', sourceSeq: 2,
        process: [{ callId: 'c1', name: 'write_file', arguments: '{"path":"/a.js"}', result: 'ok' }],
      },
    ],
  }])

  assert.equal(cards.length, 1)
  assert.equal(cards[0].kind, 'document')
})

test('connects a restored fork to its DSH seed boundary, not its canvas position', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null, position: { x: 86, y: 82 },
      messages: [
        { kind: 'user', text: '第一轮', sourceSeq: 1 },
        { kind: 'assistant', text: '第一轮回答', sourceSeq: 2 },
        { kind: 'user', text: '第二轮', sourceSeq: 5 },
        { kind: 'assistant', text: '第二轮回答', sourceSeq: 6 },
        { kind: 'user', text: '第三轮', sourceSeq: 9 },
        { kind: 'assistant', text: '第三轮回答', sourceSeq: 10 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: 8, position: { x: 9999, y: -9999 },
      messages: [
        { kind: 'user', text: '分支问题', sourceSeq: 9 },
        { kind: 'assistant', text: '分支回答', sourceSeq: 10 },
      ],
    },
  ])

  const parentCard = cards.find(card => card.dshThreadId === 'parent')
  const childCard = cards.find(card => card.dshThreadId === 'child')
  assert.equal(childCard.parentId, parentCard.id)
})

test('uses a restored child message sequence to reconnect a legacy fork at its user turn', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null, position: { x: 86, y: 82 },
      messages: [
        { kind: 'user', text: '你好', sourceSeq: 7 },
        { kind: 'assistant', text: '你好，我是助手。', sourceSeq: 111 },
        { kind: 'user', text: '你是谁', sourceSeq: 118 },
        { kind: 'assistant', text: '我是 DSH。', sourceSeq: 278 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: null, position: { x: 1200, y: 900 },
      messages: [
        { kind: 'user', text: '代码是什么', sourceSeq: 121 },
        { kind: 'assistant', text: '代码是指令。', sourceSeq: 569 },
      ],
    },
  ])

  const parentCard = cards.find(card => card.dshThreadId === 'parent')
  const childCard = cards.find(card => card.dshThreadId === 'child')
  assert.equal(childCard.parentId, parentCard.id)
})

test('places a fork beside the exact parent turn while avoiding overlap', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null, position: { x: 86, y: 82 },
      messages: [
        { kind: 'user', text: '第一轮', sourceSeq: 1 },
        { kind: 'assistant', text: '第一轮回答', sourceSeq: 2 },
        { kind: 'user', text: '第二轮', sourceSeq: 5 },
        { kind: 'assistant', text: '第二轮回答', sourceSeq: 6 },
        { kind: 'user', text: '第三轮', sourceSeq: 9 },
        { kind: 'assistant', text: '第三轮回答', sourceSeq: 10 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: 8, position: { x: 86, y: 900 },
      messages: [
        { kind: 'user', text: '第二轮分支', sourceSeq: 9 },
        { kind: 'assistant', text: '分支回答', sourceSeq: 10 },
      ],
    },
  ])

  const parentCard = cards.find(card => card.dshThreadId === 'parent')
  const childCard = cards.find(card => card.dshThreadId === 'child')
  assert.equal(childCard.parentId, parentCard.id)
  assert.equal(childCard.position.x, parentCard.position.x + 365)
  assert.ok(childCard.position.y > parentCard.position.y)
})

test('a fork branch is one separate node and keeps its own first-round summary', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null, position: { x: 86, y: 82 },
      messages: [
        { kind: 'user', text: '第一轮', sourceSeq: 1 },
        { kind: 'assistant', text: '第一轮回答', sourceSeq: 2 },
        { kind: 'user', text: '第二轮', sourceSeq: 5 },
        { kind: 'assistant', text: '第二轮回答', sourceSeq: 6 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: 7, position: { x: 999, y: 999 },
      messages: [
        { kind: 'user', text: '分支第一轮', sourceSeq: 7 },
        { kind: 'assistant', text: '分支第一轮回答', sourceSeq: 8 },
        { kind: 'user', text: '分支第二轮', sourceSeq: 9 },
        { kind: 'assistant', text: '分支第二轮回答', sourceSeq: 10 },
        { kind: 'user', text: '分支第三轮', sourceSeq: 11 },
        { kind: 'assistant', text: '分支第三轮回答', sourceSeq: 12 },
      ],
    },
  ])

  const childCards = cards.filter(card => card.dshThreadId === 'child')
  const parentCard = cards.find(card => card.dshThreadId === 'parent')
  assert.equal(childCards.length, 1)
  assert.equal(childCards[0].question, '分支第一轮')
  assert.equal(childCards[0].totalTurns, 3)
  assert.equal(childCards[0].parentId, parentCard.id)
})

test('moves automatically placed cards below an occupied card instead of overlapping it', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    { id: 'first', parentId: null, position: { x: 86, y: 82 }, messages: [{ kind: 'user', text: '第一条', sourceSeq: 1 }] },
    { id: 'second', parentId: null, position: { x: 86, y: 220 }, messages: [{ kind: 'user', text: '第二条', sourceSeq: 1 }] },
  ])

  assert.equal(cards[0].position.y, 82)
  assert.ok(cards[1].position.y >= 400)
})

test('honors an in-memory dragged card position even far from the natural layout', async () => {
  const { conversationCards, state } = await loadConversationCards()
  state.cardPositions.set('session-1:turn:1', { x: 1280, y: 1280 })
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 1 },
      { kind: 'assistant', text: '第一个回答', sourceSeq: 2 },
    ],
  }])

  assert.equal(cards[0].position.x, 1280)
  assert.equal(cards[0].position.y, 1280)
})

test('does not use a later-turn drag position when the session is aggregated into one node', async () => {
  const { conversationCards, state } = await loadConversationCards()
  state.cardPositions.set('session-1:turn:3', { x: 1280, y: 1280 })
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 1 },
      { kind: 'assistant', text: '第一个回答', sourceSeq: 2 },
      { kind: 'user', text: '第二个问题', sourceSeq: 3 },
      { kind: 'assistant', text: '第二个回答', sourceSeq: 4 },
    ],
  }])

  assert.equal(cards.length, 1)
  assert.equal(cards[0].position.x, 86)
  assert.equal(cards[0].position.y, 82)
})

test('keeps a dragged pending turn position after DSH assigns a source sequence', async () => {
  const { conversationCards, state } = await loadConversationCards()
  state.cardPositions.set('session-1:turn-index:0', { x: 740, y: 360 })
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 21 },
      { kind: 'assistant', text: '第一个回答', sourceSeq: 22 },
    ],
  }])

  assert.equal(cards[0].position.x, 740)
  assert.equal(cards[0].position.y, 360)
})

test('derives root card positions from the visible graph instead of stale persisted thread pixels', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    { id: 'dirty-root', parentId: null, position: { x: 86, y: 3200 }, messages: [{ kind: 'user', text: '脏坐标会话', sourceSeq: 1 }] },
  ])

  assert.equal(cards[0].position.x, 86)
  assert.equal(cards[0].position.y, 82)
})

test('focuses a new-session draft before existing cards when initializing the canvas', async () => {
  const { initialCanvasCamera, state } = await loadConversationCards()
  state.draft = { kind: 'new', text: '', sending: false }
  state.zoom = 1
  const camera = initialCanvasCamera([{ id: 'old-card', position: { x: 86, y: 1600 } }])

  assert.equal(camera.x, -30)
  assert.equal(camera.y, -26)
})

test('collapsing a session node hides all branch descendants without hiding another root', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null,
      messages: [
        { kind: 'user', text: '父问题', sourceSeq: 1 },
        { kind: 'assistant', text: '父回答', sourceSeq: 2 },
        { kind: 'user', text: '父追问', sourceSeq: 5 },
        { kind: 'assistant', text: '父追问回答', sourceSeq: 6 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: 4,
      messages: [
        { kind: 'user', text: '分支问题', sourceSeq: 4 },
        { kind: 'assistant', text: '分支回答', sourceSeq: 5 },
        { kind: 'user', text: '分支追问', sourceSeq: 6 },
      ],
    },
    { id: 'other-root', parentId: null, messages: [{ kind: 'user', text: '独立会话', sourceSeq: 1 }] },
  ])
  const parentCard = cards.find(card => card.dshThreadId === 'parent')
  const graph = conversationGraphView(cards, new Set([parentCard.id]))

  assert.deepEqual(Array.from(graph.cards, card => card.question).sort(), ['父问题', '独立会话'].sort())
  assert.equal(graph.childCounts.get(parentCard.id), 1)
  assert.equal(graph.descendantCounts.get(parentCard.id), 1)
})

test('expanding a card restores branch descendants at their original coordinates', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const cards = conversationCards([
    { id: 'parent', parentId: null, messages: [{ kind: 'user', text: '父问题', sourceSeq: 1 }] },
    { id: 'child1', parentId: 'parent', messages: [{ kind: 'user', text: '分支一', sourceSeq: 2 }] },
    { id: 'child2', parentId: 'parent', messages: [{ kind: 'user', text: '分支二', sourceSeq: 3 }] },
  ])
  const originalPositions = cards.map(card => ({ ...card.position }))
  const parentCard = cards.find(card => card.dshThreadId === 'parent')

  assert.equal(conversationGraphView(cards, new Set([parentCard.id])).cards.length, 1)
  const expanded = conversationGraphView(cards, new Set()).cards
  assert.equal(expanded.length, 3)
  assert.deepEqual(expanded.map(card => ({ ...card.position })), originalPositions)
})

test('a new branch descendant remains hidden while its parent session is collapsed', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const initialCards = conversationCards([
    { id: 'parent', parentId: null, messages: [{ kind: 'user', text: '父问题', sourceSeq: 1 }] },
    { id: 'child1', parentId: 'parent', messages: [{ kind: 'user', text: '旧分支', sourceSeq: 2 }] },
  ])
  const collapsedId = initialCards.find(card => card.dshThreadId === 'parent').id
  const updatedCards = conversationCards([
    { id: 'parent', parentId: null, messages: [{ kind: 'user', text: '父问题', sourceSeq: 1 }] },
    { id: 'child1', parentId: 'parent', messages: [{ kind: 'user', text: '旧分支', sourceSeq: 2 }] },
    { id: 'child2', parentId: 'parent', messages: [{ kind: 'user', text: '后来新增分支', sourceSeq: 3 }] },
  ])

  const graph = conversationGraphView(updatedCards, new Set([collapsedId]))
  assert.deepEqual(Array.from(graph.cards, card => card.question), ['父问题'])
  assert.equal(graph.descendantCounts.get(collapsedId), 2)
})

test('nested collapsed nodes remain visible when their ancestor is expanded', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const cards = conversationCards([
    { id: 'parent', parentId: null, messages: [{ kind: 'user', text: '父问题', sourceSeq: 1 }] },
    { id: 'child', parentId: 'parent', messages: [{ kind: 'user', text: '分支问题', sourceSeq: 2 }] },
    { id: 'grandchild', parentId: 'child', messages: [{ kind: 'user', text: '子分支问题', sourceSeq: 3 }] },
  ])
  const parentCard = cards.find(card => card.dshThreadId === 'parent')
  const childCard = cards.find(card => card.dshThreadId === 'child')

  const nested = conversationGraphView(cards, new Set([parentCard.id, childCard.id]))
  assert.deepEqual(Array.from(nested.cards, card => card.question), ['父问题', '分支问题'])
  const childOnly = conversationGraphView(cards, new Set([childCard.id]))
  assert.deepEqual(Array.from(childOnly.cards, card => card.question), ['父问题', '分支问题'])
})

test('cyclic collapsed roots stay visible and count unique descendants', async () => {
  const { conversationGraphView } = await loadConversationCards()
  const cards = [
    { id: 'a', parentId: 'b', dshThreadId: 'a' },
    { id: 'b', parentId: 'a', dshThreadId: 'b' },
  ]
  const graph = conversationGraphView(cards, new Set(['a', 'b']))

  assert.deepEqual(Array.from(graph.cards, card => card.id), ['a', 'b'])
  assert.equal(graph.descendantCounts.get('a'), 1)
  assert.equal(graph.descendantCounts.get('b'), 1)
})
