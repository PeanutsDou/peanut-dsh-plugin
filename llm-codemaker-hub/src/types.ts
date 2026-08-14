/**
 * CodeMaker Hub chat-completions wire format (OpenAI-compatible, DeepSeek
 * dialect). Types only. User content may carry image parts for multimodal
 * models; everything else mirrors the DeepSeek wire vocabulary.
 */

/** One user-content part: visible text or an inline image data URL. */
export type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** Request body for `POST {baseURL}/chat/completions`. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  thinking?: { type: 'enabled' | 'disabled' }
  reasoning_effort?: 'high' | 'max'
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
}

/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
  role: 'system'
  content: string
}

/** User-role message: plain text, or content parts when images are present. */
export interface WireUserMessage {
  role: 'user'
  content: string | WireContentPart[]
}

/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage =
  | WireSystemMessage
  | WireUserMessage
  | WireAssistantMessage
  | WireToolMessage

export interface WireAssistantMessage {
  role: 'assistant'
  content: string | null
  reasoning_content?: string
  tool_calls?: WireToolCall[]
}

export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface WireChunk {
  choices?: WireChoice[]
  usage?: WireUsage | null
}

export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

export interface WireDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

export interface WireToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface WireError {
  error?: { message?: string; type?: string; code?: string }
}
