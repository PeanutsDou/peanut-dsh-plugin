/**
 * Serialize harness messages into CodeMaker Hub chat completions. Text is
 * joined; assistant text becomes `content`, tool calls become `tool_calls`,
 * tool results become separate tool messages, and assistant reasoning is
 * replayed as `reasoning_content` only on tool-call turns. User image blocks
 * become inline `image_url` data-URL parts when the model is multimodal and
 * the durable attachment service can resolve the bytes; image input on a
 * text-only model is refused before the wire.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WireContentPart, WireMessage, WireRequest, WireTool, WireUserMessage } from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'high' | 'max' | undefined
}

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'high' | 'max'
}

function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'high' | 'max' {
  if (effort === 'off' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'high' | 'max'
  }
  throw new LlmError(
    `CodeMaker Hub does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

function resolveThinking(options: GenerateOptions, defaults: RequestDefaults): ResolvedThinking {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError(
      `CodeMaker Hub deployment does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'high' || effort === 'max') {
    return { thinking: 'enabled', reasoningEffort: effort }
  }
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
}

function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Base64-encode bytes without Node type dependencies (btoa is a Node global). */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** Resolve one image block to an inline data-URL part, or throw when bytes are unavailable. */
async function imagePart(
  block: Extract<ContentBlock, { type: 'image' }>,
  attachments: AttachmentStore | undefined,
): Promise<WireContentPart> {
  if (attachments === undefined) {
    throw new LlmError('image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  const stored = await attachments.readImage(block.attachment)
  return {
    type: 'image_url',
    image_url: { url: `data:${stored.ref.mediaType};base64,${toBase64(stored.data)}` },
  }
}

/**
 * Build a user wire message: plain text when the message has no images, a
 * text/image part array when it does. Image input on a model not declared
 * multimodal is refused.
 */
async function serializeUser(
  message: Message,
  attachments: AttachmentStore | undefined,
  multimodal: boolean,
): Promise<WireUserMessage> {
  const images = message.content.filter(block => block.type === 'image')
  const text = flattenText(message.content)
  if (images.length === 0) return { role: 'user', content: text }
  if (!multimodal) {
    throw new LlmError('the selected model does not support image input', 'UNSUPPORTED_CONTENT')
  }
  const parts: WireContentPart[] = []
  if (text.length > 0) parts.push({ type: 'text', text })
  for (const image of images) {
    parts.push(await imagePart(image, attachments))
  }
  return { role: 'user', content: parts }
}

function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    content: text,
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. Tool results become standalone `{role: 'tool'}`
 * messages; a mixed user message contributes its text and images first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @param attachments - durable image byte resolver; required only when images are present.
 * @param multimodal - whether the selected model accepts image input.
 * @returns the wire messages; order preserved.
 */
export async function serializeMessages(
  messages: Message[],
  attachments: AttachmentStore | undefined,
  multimodal: boolean,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.some(block => block.type === 'image')) {
        throw new LlmError('image content is not supported in system messages', 'UNSUPPORTED_CONTENT')
      }
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      if (message.content.some(block => block.type === 'image')) {
        throw new LlmError('the adapter cannot represent assistant image output', 'UNSUPPORTED_CONTENT')
      }
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    wire.push(await serializeUser(message, attachments, multimodal))
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults; undefined fields put nothing on the wire.
 * @param attachments - durable image byte resolver; required only when the conversation contains images.
 * @param multimodal - whether the selected model accepts image input.
 * @returns the chat-completions request body.
 */
export async function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
  attachments: AttachmentStore | undefined,
  multimodal: boolean,
): Promise<WireRequest> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...await serializeMessages(options.messages, attachments, multimodal))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const resolvedThinking = resolveThinking(options, defaults)

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
    ...resolvedThinking.reasoningEffort !== undefined
      ? { reasoning_effort: resolvedThinking.reasoningEffort }
      : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}
