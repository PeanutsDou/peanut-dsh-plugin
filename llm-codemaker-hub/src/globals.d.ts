/**
 * Ambient declaration for `eventsource-parser/stream`: the installed package
 * exports no `types` condition, so its subpath resolves typeless. Mirrors the
 * published source contract (`EventSourceParserStream extends
 * TransformStream<string, EventSourceMessage>`).
 */
declare module 'eventsource-parser/stream' {
  export interface EventSourceMessage {
    data: string
    event?: string
    id?: string
    retry?: number
  }
  export interface StreamOptions {
    onComment?: (comment: string) => void
    onError?: 'terminate' | ((error: Error) => void)
    onRetry?: (retry: number) => void
  }
  export class EventSourceParserStream extends TransformStream<string, EventSourceMessage> {
    constructor(options?: StreamOptions)
  }
}
