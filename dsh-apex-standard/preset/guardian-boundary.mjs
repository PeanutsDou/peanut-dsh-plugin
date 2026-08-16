/**
 * Guardian retry-boundary vocabulary shared by anchor-guardian,
 * apex-bootstrap, and instruction-hint.
 *
 * A guardian retry lands as a durable `user/message` whose `surfaceOp`
 * REPLACES the failed attempt with one fresh user node. Trackers recognize
 * it by its message source and treat it as a boundary that resets promotion
 * to the strict bootstrap phase (`mode: 'fresh'`), while a compaction keeps
 * the controlled phase (`mode: 'controlled'`).
 */

/** Plugin marker for guardian-generated messages. */
export const GUARDIAN_SOURCE_PLUGIN = 'anchor-guardian'

/** Message-source form used by the surface-replacing retry node. */
export const GUARDIAN_RETRY_FORM = 'retry'

/** Message-source form used by the inbox wake message. */
export const GUARDIAN_WAKE_FORM = 'wake'

/**
 * Whether one durable session event is a guardian retry boundary.
 * @param event - a session event, possibly undefined.
 * @returns true for the surface-replacing guardian retry user message.
 */
export function isGuardianRetryBoundary(event) {
  return event?.type === 'user/message'
    && event?.surfaceOp?.op === 'replace'
    && event?.data?.source?.plugin === GUARDIAN_SOURCE_PLUGIN
    && event?.data?.source?.form === GUARDIAN_RETRY_FORM
}
