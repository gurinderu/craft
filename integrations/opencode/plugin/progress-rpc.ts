// The server side of the review's footer line on OpenCode 2.x (realm @nick/craft, node #512): the `craft.review` RPC
// registered once at setup through `ctx.rpc` (observed on opencode 2.2.7, node #503), and a tool call's progress
// emitted on it for the TUI plugin to draw. Nothing here reaches the model's context. A 2.x without `ctx.rpc`, a
// refused registration or a failed emit only cost the line: the tool runs and answers as before.
import type { ToolAnswer, ToolCall } from './host.ts'
import type { V2Context } from './opencode-v2.js'
import { PROGRESS, REVIEW_RPC, type ReviewProgress } from './review-rpc.mjs'

/** Where a tool call's progress goes; never throws. */
export type Say = (progress: ReviewProgress) => void

export interface ProgressChannel {
  say: Say
  dispose(): Promise<void>
}

const SILENT: ProgressChannel = { say: () => undefined, dispose: () => Promise.resolve() }

/** The `craft.review` channel on this server, or a silent one where it cannot be registered. */
export async function progressChannel(ctx: V2Context): Promise<ProgressChannel> {
  const rpc = ctx.rpc
  if (typeof rpc?.register !== 'function') return SILENT
  try {
    const reg = await rpc.register(REVIEW_RPC, {})
    return {
      say: progress => {
        try {
          Promise.resolve(reg.events.emit(PROGRESS, progress)).catch(() => undefined)
        } catch {
          /* a lost line, never a failed tool */
        }
      },
      dispose: () => Promise.resolve(reg.dispose()).catch(() => undefined),
    }
  } catch {
    return SILENT
  }
}

/** The answer's line for the footer's end: its title, or a string answer's first line. */
const endLine = (name: string, answer: string | ToolAnswer) =>
  typeof answer === 'string' ? (answer.split('\n').find(l => l.trim()) ?? `${name}: done`) : answer.title

/**
 * Runs one tool call with its progress said on `say` under the calling session: each progress line while it runs,
 * then one `done` line — the answer's title, or why it stopped. A call that said no progress says no end either.
 */
export async function withProgress(
  name: string,
  say: Say | undefined,
  sessionID: string | undefined,
  run: (progress: ToolCall['progress']) => Promise<string | ToolAnswer>,
): Promise<string | ToolAnswer> {
  if (!say || !sessionID) return run(undefined)
  // An object, not a `let`: the flag is set inside the callback, out of the narrowing's sight.
  const state = { said: false }
  const progress = (line: string) => {
    state.said = true
    say({ sessionID, line, done: false })
  }
  try {
    const answer = await run(progress)
    if (state.said) say({ sessionID, line: endLine(name, answer), done: true })
    return answer
  } catch (error) {
    if (state.said) say({ sessionID, line: `${name}: stopped — ${error instanceof Error ? error.message : String(error)}`, done: true })
    throw error
  }
}
