/**
 * CodeMaker Hub provider route for DeepSeek Harness.
 *
 * Registers the single `codemaker-hub` provider route on `ctx.llm`, served by
 * the multimodal-capable {@link CodeMakerHubAdapter} pointed at the local
 * CodeMaker Hub proxy (`http://127.0.0.1:15721/v1`), which forwards to the
 * company AI gateway with its own managed credentials. The hub ignores the
 * client API key, so any value works; the default credential reference is
 * `CODEMAKER_HUB_API_KEY`.
 *
 * Models named in `multimodalModels` declare `[text, image]` input and accept
 * attached images (resolved through the durable attachment service); every
 * other model stays text-only, so the harness gates image attachment
 * automatically per model — no separate vision provider needed.
 *
 * Connection facts resolve per request like `llm-deepseek` does: the
 * `llm-codemaker-hub:` user-settings section overrides any field without a
 * restart, and the API key resolves through the credential seam at each
 * stream call.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekCatalogModel } from '@deepseek-ai/dsh-llm-deepseek'
import { CodeMakerHubAdapter } from './adapter.ts'
import type { HubConnectionOptions } from './adapter.ts'

export const name = 'llm-codemaker-hub'
export const inject = ['llm']

const NS = settingsNamespace('llm-codemaker-hub')
const DEFAULT_API_KEY_ENV = 'CODEMAKER_HUB_API_KEY'
/** The single provider route this plugin owns. */
const PROVIDER = 'codemaker-hub'
/** Local CodeMaker Hub proxy endpoint (OpenAI-compatible /v1). */
const HUB_BASE_URL = 'http://127.0.0.1:15721/v1'

/**
 * Gateway model codes as of the hub's model cache (2026-08-14). The `[1m]`
 * suffixes some client configs use are UI labels, not wire model codes; the
 * gateway rejects them. Unlisted ids still pass through unchanged.
 */
const DEFAULT_MODELS: DeepSeekCatalogModel[] = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5-2026-04-24', name: 'GPT-5.5' },
  { id: 'gpt-5.4-2026-03-05', name: 'GPT-5.4' },
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus' },
  { id: 'qwen3.5-flash', name: 'Qwen3.5 Flash' },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
  { id: 'MiniMax-M3', name: 'MiniMax M3' },
  { id: 'glm-5v-turbo', name: 'GLM-5V Turbo' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite' },
]

/** Multimodal gateway models: these declare `[text, image]` input. */
const DEFAULT_MULTIMODAL_MODELS = ['gpt-5.6-luna', 'glm-5v-turbo']

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-codemaker-hub` settings-section shape. Every field is optional:
 * a missing key fails the request with `MISSING_CREDENTIAL` (never at load),
 * the base URL defaults to the local hub proxy, and omitted reasoning effort
 * uses the adapter default.
 */
export interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `CODEMAKER_HUB_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; defaults to the local CodeMaker Hub proxy. */
  baseURL?: string
  /** Default thinking effort (default `high`); `off` disables thinking per request. */
  reasoningEffort?: 'off' | 'high' | 'max'
  /** Default per-request output cap (default 256,000); a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 1,000,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to the gateway catalog. */
  models?: DeepSeekCatalogModel[]
  /** Model ids that accept image input; defaults to the known multimodal gateway models. */
  multimodalModels?: string[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<DeepSeekCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: Schema<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(HUB_BASE_URL),
  reasoningEffort: z.union(['off', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  multimodalModels: z.array(z.string()).default(DEFAULT_MULTIMODAL_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: HubConnectionOptions | undefined
  const options = (): HubConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const base = resolveAdapterOptions(raw, launchEnvironmentOf(ctx))
      const next: HubConnectionOptions = {
        ...base,
        multimodalModels: raw.multimodalModels ?? DEFAULT_MULTIMODAL_MODELS,
      }
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-codemaker-hub: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: HubConnectionOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-codemaker-hub', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-codemaker-hub', ref)
      }
    }
    throw new LlmError(
      `llm-codemaker-hub: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ' service (the web Models page writes it), or export the reference in the launching environment',
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new CodeMakerHubAdapter({
    options,
    resolveApiKey,
    resolveUserId: () => getOrCreateAnonymousUserId(),
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'CodeMaker Hub', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}
