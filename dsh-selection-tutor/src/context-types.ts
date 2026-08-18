/**
 * Structural types for the DSH cordis services this plugin touches. The
 * browser bundle keeps value imports limited to platform modules, so these
 * declarations live in a shared type-only file.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'

export interface TutorWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface TutorWebServer {
  register(route: TutorWebRoute): () => void
}

export interface TutorSessionHeader {
  cwd?: string
  parentSession?: string
}

export interface TutorSessionEvent {
  type: string
  seq?: number
  time?: number
  data: Record<string, unknown>
}

export interface TutorSession {
  id: string
  header: TutorSessionHeader
  events?: readonly TutorSessionEvent[]
  requestHeader?: () => { config?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number } } | undefined
}

export interface TutorSessionStore {
  get(id: string): TutorSession | undefined
  list(): TutorSession[]
}

export interface TutorAgentOptions {
  provider?: string
  model?: string
  maxTokens?: number
}

export interface TutorAgent {
  readonly id: string
  readonly options: TutorAgentOptions
  readonly session: TutorSession
  readonly ctx: Context
  followup(message: unknown): void
  cancel(cause: { kind: 'user' | 'parent' | 'disposed' } | { kind: 'hook'; reason: string }): void
  whenIdle(): Promise<void>
}

export interface TutorAgentHandle {
  agent: TutorAgent
  dispose(): Promise<void>
}

export interface TutorCreateAgentOptions {
  sessionId: string
  meta?: { cwd?: string; parentSession?: string }
  agentOptions?: TutorAgentOptions
  setup?: (agentCtx: Context) => void | Promise<void>
}

export interface TutorAgentsService {
  get(id: string): TutorAgent | undefined
  create(options: TutorCreateAgentOptions): Promise<TutorAgentHandle>
}

export interface TutorWorkspaceRegistry {
  archiveSession(sessionId: string): Promise<void>
}

/** Runtime-only surface used by promote(): removes one id from the archive set. */
export interface TutorWorkspaceRegistryInternal extends TutorWorkspaceRegistry {
  requireState(): { archivedSessionIds?: readonly string[]; [key: string]: unknown }
  setState(state: unknown): Promise<void>
}

export interface TutorSessionTitleService {
  rename(session: TutorSession, title: string): { title?: string }
}

export interface TutorSessionQuery {
  readSession(sessionId: string): Promise<{ session: TutorSessionHeader; events: TutorSessionEvent[] }>
}

export interface TutorPermissionPresets {
  current(events: readonly TutorSessionEvent[]): string
  set(session: TutorSession, name: string): void
}

export interface TutorAgentPresets {
  composeFrom(agentCtx: Context, parentCtx: Context): string | undefined
}

export interface TutorSettingsService {
  register(ns: unknown, schema: unknown): { get(): unknown; watch(cb: (next: unknown, prev: unknown) => void): () => void }
  describe(opts: { redactSecrets?: boolean }): Array<{ ns: unknown; value?: unknown; revision?: number }>
  update(ns: unknown, patch: Record<string, unknown>, expectedRevision?: number): Promise<void>
}

export interface TutorSessionSummary {
  id: string
  displayTitle: string
}

export interface TutorSessionListSnapshot {
  current: string | undefined
  byId: Record<string, TutorSessionSummary>
}

export interface TutorSessionsService {
  list: {
    getSnapshot(): TutorSessionListSnapshot
    subscribe(fn: () => void): () => void
  }
}

export interface TutorSlotsService {
  inject(name: string, factory: () => () => void): void
  register(options: Record<string, unknown>, component: unknown): () => void
}

export interface TutorLoaderService {
  entries?: () => Iterable<{ options: { id?: string; name?: string; config?: unknown } }>
}

declare module 'cordis' {
  interface Context {
    webServer: TutorWebServer
    sessions: TutorSessionStore & TutorSessionsService
    agents: TutorAgentsService
    workspaceRegistry: TutorWorkspaceRegistry
    sessionTitle: TutorSessionTitleService
    sessionQuery: TutorSessionQuery
    permissionPresets: TutorPermissionPresets
    agentPresets: TutorAgentPresets
    settings: TutorSettingsService
    slots: TutorSlotsService
    loader?: TutorLoaderService
    inject(deps: string[], callback: (ctx: Context) => void): void
    get(name: string): unknown | undefined
    on(name: string, listener: (...args: any[]) => any): () => void
    effect(fn: () => void | (() => void), label?: string): void
  }
}

export type { Context }
