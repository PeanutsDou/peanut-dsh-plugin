/**
 * Decode an SSE byte stream into event `data` payloads. Framing is handled by
 * `eventsource-parser`; comments are reported only through an optional
 * transport-activity callback. The literal `[DONE]` is yielded so the caller
 * owns final flushing, and EOF before it raises `LlmError`.
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import type { EventSourceMessage } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'

export const DONE = '[DONE]'

/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
 * value and returns; blank `data:` keepalive events are skipped; throws
 * `LlmError('STREAM_CLOSED')` when the stream ends without it.
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
 * @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  // The DOM `ReadableStream` type lacks async-iterator typing; Node's runtime
  // stream is async-iterable, which is what the cast names.
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment })) as unknown as AsyncIterable<EventSourceMessage>
  for await (const { data } of events) {
    // The hub proxy (and upstream gateways) may emit blank `data:` events as
    // keepalives during long silent phases (large-context prefill). They carry
    // no payload, so skip them; yielding an empty string would make the
    // downstream JSON.parse fail with MALFORMED_RESPONSE and kill the stream.
    if (data !== DONE && data.trim().length === 0) continue
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}
