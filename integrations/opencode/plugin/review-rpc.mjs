// The channel the `review` tool's progress takes to the TUI on OpenCode 2.x (realm @nick/craft, node #512): the server
// plugin registers it and emits `progress` (progress-rpc.ts); the TUI plugin subscribes to it and draws the footer line
// (review-footer.mjs). The host publishes each emit as `rpc.craft.review.progress` on its event stream, which reaches
// the TUI and not the model's context (observed on opencode 2.2.7, node #503). One definition for both sides.

/** @typedef {{ sessionID: string, line: string, done: boolean }} ReviewProgress */

export const REVIEW_RPC = Object.freeze({
  id: 'craft.review',
  methods: {},
  events: { progress: { schema: { type: 'object' } } },
})

export const PROGRESS = 'progress'

/** The event's data as a progress, or null when it is not one. @param {unknown} data @returns {ReviewProgress | null} */
export function asProgress(data) {
  if (typeof data !== 'object' || data === null) return null
  const d = /** @type {Record<string, unknown>} */ (data)
  const { sessionID, line, done } = d
  return typeof sessionID === 'string' && typeof line === 'string' && typeof done === 'boolean' ? { sessionID, line, done } : null
}
