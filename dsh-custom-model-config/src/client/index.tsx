/**
 * dsh-custom-model-config — client half.
 *
 * Registers ONE settings nav page named "自定义模型配置". Other plugins can
 * register model-related settings cards through the window-level contract
 * `window.__DSH_MODEL_CONFIG_REGISTRY__` (or the pre-registry pending queue).
 *
 * The page itself is a pure container: it owns no settings values and only
 * renders cards contributed by feature plugins.
 */
import { useSyncExternalStore, type ReactNode } from 'react'

export const name = 'dsh-custom-model-config-client'
export const inject = ['slots']

interface SlotEntry {
  name: string
  id: string
  order: number
  label: () => string
}

interface SlotsContext {
  slots: {
    inject(name: string, factory: () => () => void): void
    register(options: SlotEntry, component: unknown): () => void
  }
}

const GLOBAL_REGISTRY_KEY = '__DSH_MODEL_CONFIG_REGISTRY__'
const GLOBAL_PENDING_KEY = '__DSH_MODEL_CONFIG_PENDING__'

/** One settings card contributed by another plugin. */
export interface ModelConfigCard {
  id: string
  title: string
  description?: string
  order: number
  render: () => ReactNode
}

interface ModelConfigRegistry {
  register(card: ModelConfigCard): () => void
  unregister(id: string): void
  getCards(): ModelConfigCard[]
  subscribe(listener: () => void): () => void
}

type MutableWindow = Window & {
  [GLOBAL_REGISTRY_KEY]?: ModelConfigRegistry
  [GLOBAL_PENDING_KEY]?: ModelConfigCard[]
}

function ensureRegistry(): ModelConfigRegistry {
  const win = window as unknown as MutableWindow
  const existing = win[GLOBAL_REGISTRY_KEY]
  if (existing !== undefined) return existing

  const cards = new Map<string, ModelConfigCard>()
  const listeners = new Set<() => void>()
  let snapshot: ModelConfigCard[] = []
  const notify = (): void => {
    snapshot = [...cards.values()]
    for (const listener of [...listeners]) listener()
  }

  const registry: ModelConfigRegistry = {
    register(card) {
      cards.set(card.id, card)
      notify()
      return () => { registry.unregister(card.id) }
    },
    unregister(id) {
      if (cards.delete(id)) notify()
    },
    getCards() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  win[GLOBAL_REGISTRY_KEY] = registry

  // Drain cards that registered before this page plugin was loaded.
  const pending = win[GLOBAL_PENDING_KEY]
  if (pending !== undefined) {
    for (const card of pending.splice(0)) registry.register(card)
  }
  return registry
}

/** Register one model-config card from any plugin (load-order safe). */
export function registerModelConfigCard(card: Omit<ModelConfigCard, 'order'> & { order?: number }): () => void {
  const normalized: ModelConfigCard = { order: 100, ...card }
  const win = window as unknown as MutableWindow
  const registry = win[GLOBAL_REGISTRY_KEY]
  if (registry !== undefined) return registry.register(normalized)
  const pending = win[GLOBAL_PENDING_KEY] ?? []
  win[GLOBAL_PENDING_KEY] = pending
  pending.push(normalized)
  let active = true
  return () => {
    if (!active) return
    active = false
    const index = pending.indexOf(normalized)
    if (index >= 0) pending.splice(index, 1)
    else win[GLOBAL_REGISTRY_KEY]?.unregister(normalized.id)
  }
}

function ensureStyles(): void {
  const id = 'dsh-custom-model-config-styles'
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = `
.dsh-cmc-page{padding:4px 0 24px;display:flex;flex-direction:column;gap:14px}
.dsh-cmc-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:28px 18px;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center}
.dsh-cmc-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:14px 16px}
.dsh-cmc-card-title{margin:0 0 4px;font-size:14px;font-weight:600}
.dsh-cmc-card-desc{margin:0 0 10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
`
  document.head.append(style)
}

function ModelConfigPage(): JSX.Element {
  const registry = ensureRegistry()
  const cards = useSyncExternalStore(
    registry.subscribe,
    registry.getCards,
    registry.getCards,
  )
  const ordered = [...cards].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return (
    <div className="dsh-cmc-page">
      {ordered.length === 0 ? (
        <p className="dsh-cmc-empty">暂无模型配置项。安装使用本页签的插件后，其配置会出现在这里。</p>
      ) : null}
      {ordered.map(card => (
        <section className="dsh-cmc-card" key={card.id}>
          <h3 className="dsh-cmc-card-title">{card.title}</h3>
          {card.description !== undefined ? <p className="dsh-cmc-card-desc">{card.description}</p> : null}
          {card.render()}
        </section>
      ))}
    </div>
  )
}

export function apply(ctx: SlotsContext): void {
  ensureStyles()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-custom-model-config',
    order: 115,
    label: () => '自定义模型配置',
  }, ModelConfigPage))
}
