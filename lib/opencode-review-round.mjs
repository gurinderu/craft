// One step's tasks run in OpenCode (realm @nick/craft, node #453): the round runner the shared driver loop takes
// (lib/codex-review-run.mjs, `runRound` in its context) — the shared round (lib/codex-review-round.mjs, roundOf), each
// task its own child session (lib/opencode-review-task.mjs).
import { roundOf } from './codex-review-round.mjs'
import { runTask } from './opencode-review-task.mjs'

/**
 * The round runner of one review.
 * @param {import('./opencode-review-task.mjs').TaskContext & { concurrency: number, log: (line: string) => void }} ctx
 * @returns {import('./codex-review-run.mjs').RoundRunner}
 */
export const openCodeRounds = ctx => (tasks, round, watch) => roundOf(tasks, round, ctx, watch, t => runTask(t, ctx), 'OpenCode')
