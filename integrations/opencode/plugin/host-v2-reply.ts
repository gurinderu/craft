// A 2.x child session's reply (host-v2.ts): its prompt admitted, then `wait`/`context` read until the last message
// is a finished assistant turn. That path is UNOBSERVED with a real model (opencode-v2.d.ts) and was seen to hang on
// 2.2.7, so each session has a hard reply deadline of its own: past it the session is interrupted and the reply fails
// with a named error, which the review's task reports as unanswered with that text (lib/opencode-review-task.mjs).
import type { V2Context, V2Message } from "./opencode-v2.js"

// How many reads of a session that is not yet done before giving up with no text.
const MAX_POLLS = 3 * 60 * 60 * 2
// The reply deadline when CRAFT_OPENCODE_REPLY_MIN sets none, in minutes.
const REPLY_MIN = 5

const STOPPED = "the child session was stopped at its deadline"

// Why a stopped session's reply failed: the Error its stop was given.
const reasonOf = (stop: AbortSignal): Error => (stop.reason instanceof Error ? stop.reason : new Error(STOPPED))

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The reply deadline in milliseconds: CRAFT_OPENCODE_REPLY_MIN minutes when it is a positive number, else five. */
export function replyDeadlineMs(env: NodeJS.ProcessEnv): number {
  const min = Number(env["CRAFT_OPENCODE_REPLY_MIN"])
  return (Number.isFinite(min) && min > 0 ? min : REPLY_MIN) * 60000
}

/** The error a session that gave no finished turn within `ms` fails with. */
export const noReplyText = (ms: number) => `no reply from OpenCode 2.x child session within ${Number((ms / 60000).toPrecision(2))} min`

// The text of the session's last message, when it is a finished assistant turn; null while it is not.
export function finishedReply(messages: readonly V2Message[]): string | null {
  const last = messages.at(-1)
  if (!last || last.type !== "assistant") return null
  if (last.finish === undefined && last.time?.completed === undefined) return null
  return (last.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n").trim()
}

// `wait` may resolve before the admitted prompt's loop has started, so idle is read as "look again", and only a
// finished assistant message is an answer. A stop ends the loop at its next look.
async function polled(ctx: V2Context, sessionID: string, pollMs: number, stop: AbortSignal): Promise<string> {
  for (let i = 0; i < MAX_POLLS && !stop.aborted; i++) {
    await ctx.session.wait({ sessionID })
    if (stop.aborted) break
    const reply = finishedReply(await ctx.session.context({ sessionID }))
    if (reply !== null) return reply
    await pause(pollMs)
  }
  if (stop.aborted) throw reasonOf(stop)
  return ""
}

export interface ReplyBound {
  // The reply deadline, already clamped to the caller's own.
  ms: number
  pollMs: number
  // The caller's abort (its task deadline).
  signal?: AbortSignal
}

/**
 * The reply to the prompt `send` admits, or a rejection once the reply deadline or the caller's abort comes first:
 * either interrupts the session (`session.interrupt`, observed on 2.2.7) and rejects at once, even while a `wait`
 * or the prompt itself never returns.
 */
export async function replyOf(ctx: V2Context, sessionID: string, send: () => Promise<unknown>, bound: ReplyBound): Promise<string> {
  const stop = new AbortController()
  const stopped = new Promise<never>((_, reject) => {
    stop.signal.addEventListener("abort", () => {
      ctx.session.interrupt({ sessionID }).catch(() => undefined)
      reject(reasonOf(stop.signal))
    }, { once: true })
  })
  const timer = setTimeout(() => stop.abort(new Error(noReplyText(bound.ms))), bound.ms)
  const onCaller = () => stop.abort(new Error(STOPPED))
  if (bound.signal?.aborted) onCaller()
  bound.signal?.addEventListener("abort", onCaller, { once: true })
  try {
    const reply = (async () => {
      await send()
      return polled(ctx, sessionID, bound.pollMs, stop.signal)
    })()
    return await Promise.race([reply, stopped])
  } finally {
    clearTimeout(timer)
    bound.signal?.removeEventListener("abort", onCaller)
  }
}
