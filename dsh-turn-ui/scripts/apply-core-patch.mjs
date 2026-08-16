// apply-core-patch.mjs — replace the compiled ChatView inside DSH's installed
// @deepseek-ai/dsh-client-ui-conversation client bundle with the TurnFold
// variant. Idempotent-ish: applying twice detects the already-patched marker
// and exits 0. Re-run after a DSH upgrade (the script fails loudly when the
// expected anchor no longer exists).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const target = process.env.DSH_UI_CONVERSATION_BUNDLE
  || path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js')

const START = 'function ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {'

const PATCHED = String.raw`function turnFoldTurnOf(node) {
  const loc = node && node.location
  return loc && (loc.kind === "step" || loc.kind === "turn") ? loc.turn.turn : null
}

function turnFoldEnsureStyles() {
  if (typeof document === "undefined" || document.getElementById("dsh-turn-fold-styles") !== null) return
  const style = document.createElement("style")
  style.id = "dsh-turn-fold-styles"
  style.textContent = [
    ".dsh-turn-marker{height:0;margin:0;padding:0;border:0}",
    ".dsh-turn-fold{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);margin:6px 0;overflow:hidden}",
    ".dsh-turn-fold.running{border-color:var(--dsw-alias-state-business-primary)}",
    ".dsh-turn-fold.interrupted{border-color:var(--dsw-alias-state-error-primary)}",
    ".dsh-turn-fold-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;display:flex;align-items:center;gap:8px;padding:8px 12px}",
    ".dsh-turn-fold-header:hover{background:var(--dsw-alias-interactive-bg-hover)}",
    ".dsh-turn-fold-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s;display:inline-flex}",
    ".dsh-turn-fold.expanded .dsh-turn-fold-chevron{transform:rotate(90deg)}",
    ".dsh-turn-fold-status{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}",
    ".dsh-turn-fold.running .dsh-turn-fold-status{background:var(--dsw-alias-state-business-primary);animation:dsh-turn-fold-pulse 1.2s ease-in-out infinite}",
    ".dsh-turn-fold.interrupted .dsh-turn-fold-status{background:var(--dsw-alias-state-error-primary)}",
    ".dsh-turn-fold-label{font-size:13px;font-weight:500;line-height:20px}",
    ".dsh-turn-fold-meta{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}",
    ".dsh-turn-fold-body{padding:2px 10px 10px}",
    "@keyframes dsh-turn-fold-pulse{0%,100%{opacity:1}50%{opacity:.35}}"
  ].join("\n")
  document.head.append(style)
}

function buildTurnFoldRows(order, nodeStore, timeline) {
  const entries = []
  for (const key of order) {
    const node = nodeStore.get(key)
    if (node === void 0) continue
    entries.push({ key, node, turn: turnFoldTurnOf(node) })
  }

  const foldDisabled = typeof document !== "undefined" && document.documentElement.dataset.turnFoldDisabled === "1"
  if (foldDisabled) {
    const rows = []
    let currentTurn = null
    for (const entry of entries) {
      if (entry.turn !== currentTurn) {
        currentTurn = entry.turn
        if (entry.turn !== null) rows.push({ kind: "marker", turn: entry.turn })
      }
      rows.push({ kind: "node", key: entry.key })
    }
    return rows
  }

  const closingSeqByTurn = new Map()
  for (const entry of entries) {
    const node = entry.node
    if (entry.turn === null || node.kind !== "turn-tail") continue
    const closing = node.data && node.data.closing ? node.data.closing : null
    if (closing !== null && closing.finalNode) closingSeqByTurn.set(entry.turn, closing.finalNode.seq)
  }

  const finalKeyByTurn = new Map()
  for (const entry of entries) {
    const node = entry.node
    if (entry.turn === null || node.kind !== "assistant-step") continue
    const finalNode = node.data && node.data.finalNode ? node.data.finalNode : null
    if (finalNode !== null && finalNode.seq === closingSeqByTurn.get(entry.turn)) {
      finalKeyByTurn.set(entry.turn, entry.key)
    }
  }

  const processKinds = new Set(["assistant-step", "tool-call", "model-retry", "manual-compaction"])
  const rows = []
  let currentTurn = null
  let group = null
  const flushGroup = () => {
    if (group === null) return
    const toolCount = group.nodes.filter(item => item.node.kind === "tool-call").length
    const interrupted = group.nodes.some(item => item.node.kind === "assistant-step" && item.node.data && item.node.data.status === "interrupted")
    const turn = timeline.turns.get(group.turn)
    const durationMs = turn && turn.start && turn.end ? Math.max(0, turn.end.time - turn.start.time) : null
    rows.push({
      kind: "group",
      turn: group.turn,
      nodes: group.nodes.map(item => item.key),
      toolCount,
      interrupted,
      durationMs,
    })
    group = null
  }

  for (const entry of entries) {
    if (entry.turn !== currentTurn) {
      flushGroup()
      currentTurn = entry.turn
      if (entry.turn !== null) rows.push({ kind: "marker", turn: entry.turn })
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
      rows.push({ kind: "node", key: entry.key })
    }
  }
  flushGroup()
  return rows
}

function TurnFold({ turn, running, interrupted, toolCount, durationMs, t, children }) {
  const [expanded, setExpanded] = react.useState(running)
  react.useEffect(() => {
    setExpanded(running)
  }, [running])
  const parts = []
  parts.push(children.length + " 个过程")
  if (toolCount > 0) parts.push(toolCount + " 个工具调用")
  if (durationMs !== null) parts.push(formatRunDuration(durationMs, t))
  const label = running ? "任务进行中" : interrupted ? "任务已中断" : "任务过程"
  return react.createElement("div", {
    className: "dsh-turn-fold" + (running ? " running" : "") + (interrupted ? " interrupted" : "") + (expanded ? " expanded" : ""),
    "data-turn-fold": String(turn),
    "data-turn-start": String(turn),
    "data-turn-anchor": "",
    "data-chat-anchor-key": "turn-fold-" + turn
  }, react.createElement("button", {
    type: "button",
    className: "dsh-turn-fold-header",
    "aria-expanded": expanded,
    onClick: () => { setExpanded(value => !value) }
  }, react.createElement("span", { className: "dsh-turn-fold-chevron", "aria-hidden": "true" }, "›"), react.createElement("span", { className: "dsh-turn-fold-status", "aria-hidden": "true" }), react.createElement("span", { className: "dsh-turn-fold-label" }, label), react.createElement("span", { className: "dsh-turn-fold-meta" }, parts.join(" · "))), expanded ? react.createElement("div", { className: "dsh-turn-fold-body" }, children) : null)
}

function ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {
  const order = useSession((s) => s.chat.order)
  const nodeStore = useSession((s) => s.chat.nodes)
  const timeline = useSession((s) => s.chat.timeline)
  const inbox = useSession((s) => s.queue)
  const cwd = useSessions((s) => s.byId[sessionId]?.cwd)
  const running = useSession((s) => s.running)
  const openState = useSession((s) => s.openState)
  const openError = useSession((s) => s.openError)
  const hasMore = useSession((s) => s.hasMore)
  const loadingOlder = useSession((s) => s.loadingOlder)
  const selectedCallId = useStore((s) => s.selection?.callId)
  const pendingSteering = (0, react.useMemo)(() => inbox.filter((item) => item.placement === "steering"), [inbox])
  const runningTurnStart = (0, react.useMemo)(() => runningTurnStartTime(timeline), [timeline])
  const turnRows = (0, react.useMemo)(() => buildTurnFoldRows(order, nodeStore, timeline), [order, nodeStore, timeline])
  const listRef = (0, react.useRef)(null)
  const columnRef = (0, react.useRef)(null)
  const atBottomRef = (0, react.useRef)(true)
  const [atBottom, setAtBottom] = (0, react.useState)(true)
  const observedTopRef = (0, react.useRef)(0)
  const anchorRef = (0, react.useRef)(null)
  const firstSeqRef = (0, react.useRef)(null)
  const openedRef = (0, react.useRef)(false)
  const lastKeyRef = (0, react.useRef)(null)
  const lastSteeringIdRef = (0, react.useRef)(null)
  const followSigRef = (0, react.useRef)(null)
  const firstKey = order[0]
  const firstSeq = firstKey === void 0 ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = order.at(-1) ?? null
  const lastNode = lastKey === null ? void 0 : nodeStore.get(lastKey)
  const lastSteeringId = pendingSteering[pendingSteering.length - 1]?.id ?? null
  const followSig = [openState, firstSeq, lastKey, order.length, running ? 1 : 0, lastSteeringId ?? ""].join(":")
  const toBottom = (el) => {
    anchorRef.current = null
    el.scrollTop = el.scrollHeight
    observedTopRef.current = el.scrollTop
    atBottomRef.current = true
    setAtBottom(true)
    chatScroll.save(null)
  }
  ;(0, react.useLayoutEffect)(() => {
    const local = listRef.current
    if (local === null) return
    const el = scrollerOf(local)
    if (openState === "open" && !openedRef.current) {
      openedRef.current = true
      const saved = chatScroll.read()
      if (saved === null) toBottom(el)
      else {
        el.scrollTop = saved.scrollTop
        const row = anchorElement(local, saved.anchorKey)
        if (row !== null) el.scrollTop += flowTop(row, el) - saved.anchorTop
        observedTopRef.current = el.scrollTop
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 25
        atBottomRef.current = isAtBottom
        setAtBottom(isAtBottom)
        const normalized = isAtBottom ? null : scrollPosition(local, el)
        if (isAtBottom) chatScroll.save(null)
        else if (normalized !== null) chatScroll.save(normalized)
      }
      firstSeqRef.current = firstSeq
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
      const anchor = anchorRef.current
      anchorRef.current = null
      const row = anchorElement(local, anchor.key)
      if (row !== null) el.scrollTop += flowTop(row, el) - anchor.top
      observedTopRef.current = el.scrollTop
      firstSeqRef.current = firstSeq
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    firstSeqRef.current = firstSeq
    const appendedUser = lastKey !== lastKeyRef.current && lastNode?.kind === "user"
    const appendedSteering = lastSteeringId !== null && lastSteeringId !== lastSteeringIdRef.current
    const tipMoved = followSigRef.current !== followSig
    lastKeyRef.current = lastKey
    lastSteeringIdRef.current = lastSteeringId
    followSigRef.current = followSig
    if (appendedUser || appendedSteering || tipMoved && atBottomRef.current) toBottom(el)
  })
  const onScrollRef = (0, react.useRef)(() => {})
  onScrollRef.current = () => {
    const local = listRef.current
    if (local === null) return
    const el = scrollerOf(local)
    const floor = Math.max(0, el.scrollHeight - el.clientHeight)
    const movedByReader = Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > .5
    const isAtBottom = movedByReader ? floor - el.scrollTop <= 25 : atBottomRef.current
    if (!movedByReader && isAtBottom) {
      toBottom(el)
      return
    }
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    const position = isAtBottom ? null : scrollPosition(local, el)
    if (isAtBottom) anchorRef.current = null
    else if (anchorRef.current !== null && position !== null) anchorRef.current = {
      key: position.anchorKey,
      top: position.anchorTop
    }
    if (isAtBottom) chatScroll.save(null)
    else if (position !== null) chatScroll.save(position)
    observedTopRef.current = el.scrollTop
  }
  ;(0, react.useEffect)(() => {
    turnFoldEnsureStyles()
    const local = listRef.current
    if (local === null) return
    const el = scrollerOf(local)
    const onScroll = () => {
      onScrollRef.current()
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      el.removeEventListener("scroll", onScroll)
    }
  }, [])
  const followRef = (0, react.useRef)(null)
  followRef.current = () => {
    const local = listRef.current
    if (local !== null && atBottomRef.current) {
      const el = scrollerOf(local)
      el.scrollTop = el.scrollHeight
      observedTopRef.current = el.scrollTop
      chatScroll.save(null)
    }
  }
  ;(0, react.useEffect)(() => {
    const column = columnRef.current
    const local = listRef.current
    if (column === null || local === null || typeof ResizeObserver === "undefined") return
    const composer = scrollerOf(local).querySelector("[data-composer-seat]")
    const observer = new ResizeObserver(() => {
      followRef.current?.()
    })
    observer.observe(column)
    if (composer !== null) observer.observe(composer)
    return () => {
      observer.disconnect()
    }
  }, [])
  ;(0, react.useEffect)(() => {
    if (!loadingOlder) anchorRef.current = null
  }, [loadingOlder])
  const loadOlderAnchored = () => {
    const local = listRef.current
    if (local !== null) {
      const el = scrollerOf(local)
      const row = pagingAnchor(local, el)
      if (row !== null && row.dataset.chatAnchorKey !== void 0) anchorRef.current = {
        key: row.dataset.chatAnchorKey,
        top: flowTop(row, el)
      }
    }
    loadOlder()
  }
  return (0, react_jsx_runtime.jsx)("div", {
    className: ChatView_module_css_default.root,
    children: (0, react_jsx_runtime.jsxs)("div", {
      ref: listRef,
      className: ChatView_module_css_default.scroll,
      children: [(0, react_jsx_runtime.jsxs)("div", {
        ref: columnRef,
        className: ChatView_module_css_default.column,
        "data-chat-flow": "",
        children: [
          openState === "loading" && (0, react_jsx_runtime.jsx)("div", {
            className: ChatView_module_css_default.hint,
            children: t("chat.loadingHistory")
          }),
          openState === "error" && openError !== null && (0, react_jsx_runtime.jsx)("div", {
            className: ChatView_module_css_default.openError,
            children: t("chat.loadError", {
              message: openError.message,
              code: openError.code
            })
          }),
          hasMore && (0, react_jsx_runtime.jsx)("div", {
            className: ChatView_module_css_default.older,
            children: (0, react_jsx_runtime.jsx)("button", {
              type: "button",
              disabled: loadingOlder,
              onClick: loadOlderAnchored,
              children: loadingOlder ? t("loading") : t("chat.loadOlder")
            })
          }),
          turnRows.map((row) => {
            if (row.kind === "marker") {
              return (0, react_jsx_runtime.jsx)("div", {
                className: "dsh-turn-marker",
                "data-turn-start": String(row.turn),
                "data-turn-anchor": ""
              }, "turn-marker-" + row.turn)
            }
            if (row.kind === "group") {
              const turn = timeline.turns.get(row.turn)
              const children = row.nodes.map((nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {
                nodeKey,
                useSession,
                selectedCallId,
                cwd,
                openFile,
                inspectCall,
                forkAt,
                loadImage,
                fileMentions,
                renderSlot,
                t
              }, nodeKey))
              return (0, react_jsx_runtime.jsx)(TurnFold, {
                turn: row.turn,
                running: turn !== void 0 && turn.status === "open",
                interrupted: row.interrupted,
                toolCount: row.toolCount,
                durationMs: row.durationMs,
                t,
                children
              }, "turn-fold-" + row.turn)
            }
            return (0, react_jsx_runtime.jsx)(ChatNodeSeat, {
              nodeKey: row.key,
              useSession,
              selectedCallId,
              cwd,
              openFile,
              inspectCall,
              forkAt,
              loadImage,
              fileMentions,
              renderSlot,
              t
            }, row.key)
          }),
          running && (0, react_jsx_runtime.jsx)(TurnStatus, {
            startTime: runningTurnStart,
            t
          }),
          pendingSteering.map((item) => (0, react_jsx_runtime.jsx)(PendingSteeringBubble, {
            content: item.content,
            loadImage,
            t
          }, item.id))
        ]
      }), !atBottom && (0, react_jsx_runtime.jsx)("div", {
        className: ChatView_module_css_default.toBottomSlot,
        children: (0, react_jsx_runtime.jsx)("button", {
          type: "button",
          className: ChatView_module_css_default.toBottom,
          "aria-label": t("chat.toBottom"),
          onClick: () => {
            const local = listRef.current
            if (local !== null) toBottom(scrollerOf(local))
          },
          children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
        })
      })]
    })
  })
}`

const marker = 'data-turn-fold": String(turn)'

const force = process.argv.includes('--force')
const file = path.resolve(target)
if (!fs.existsSync(file)) {
  console.error(`[turn-fold] bundle not found: ${file}`)
  process.exit(2)
}
let source = fs.readFileSync(file, 'utf8')
if (source.includes('"data-turn-fold": String(turn)') && !force) {
  console.log('[turn-fold] already patched, nothing to do (use --force to re-apply)')
  process.exit(0)
}

const start = source.indexOf(START)
if (start < 0) {
  console.error('[turn-fold] ChatView anchor not found; DSH may have changed the bundle. Aborting.')
  process.exit(3)
}
const regionEnd = source.indexOf('//#endregion', start)
if (regionEnd < 0) {
  console.error('[turn-fold] ChatView region end not found. Aborting.')
  process.exit(3)
}

const backup = file + '.pre-turnfold.bak'
if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
const patched = source.slice(0, start) + PATCHED + source.slice(regionEnd)

if (!patched.includes(marker)) {
  console.error('[turn-fold] validation failed: patched marker missing.')
  process.exit(4)
}

fs.writeFileSync(file, patched, 'utf8')
console.log(`[turn-fold] patched ${file}`)
console.log(`[turn-fold] backup kept at ${backup}`)
