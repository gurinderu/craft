// The per-agent deadline of a cli-review task (lib/cli-review-task.mjs), as the review engine sets it
// (lib/review-run-agent.mjs, lib/review-deadlines.mjs): one budget per task, armed at its first dispatch and shared by
// a re-run on the default type, its length the engine's per-phase table read by what the task is for (the binary's
// task kind). A task whose budget runs out before its agent answers is abandoned and counts as dead; the driver names
// it to the binary (`submit --abandoned`), which fails it at once — never handed out again, as the engine never
// re-dispatches a deadline fire — and never reads an answer the agent writes later. The sandbox has no
// AbortController, so the abandoned agent keeps its harness slot until the harness reaps it; and no clock, so the
// budget is an armed timer (lib/agent-deadline.mjs).
import { DEADLINE_HIT, makeDeadlineBudget } from './agent-deadline.mjs'
import { deadlineMsFor, retryFloorMs } from './review-deadlines.mjs'

// The binary's task kinds (`TaskKind`, cli/crates/craft-review/src/state.rs) by the engine phase whose deadline the
// engine gives the same agent: the scout, the memory's recall and the index warm-up beside it; the lenses with the
// consumer's own agents and the unit-mode coordinator; the dedup and the verifiers; the prior round's adjudicators,
// carry-checks and red team; the critic and the memory's judges. A kind not named here takes the default.
const KIND_PHASE = new Map([
  ['scout', 'Scout'], ['recall', 'Scout'], ['warmup', 'Scout'],
  ['lens', 'Lenses'], ['criticLens', 'Lenses'], ['extra', 'Lenses'], ['seam', 'Lenses'],
  ['dedup', 'Verify'], ['verify', 'Verify'], ['verifyBatch', 'Verify'],
  ['adjudicate', 'Adjudicate'], ['carryCheck', 'Adjudicate'], ['redTeam', 'Adjudicate'],
  ['critic', 'Synthesize'], ['matchJudge', 'Synthesize'], ['ruleJudge', 'Synthesize'],
])

/** The deadline of a task of `kind`, in milliseconds. @param {string | undefined} kind @returns {number} */
export const taskDeadlineMs = kind => deadlineMsFor({ phase: KIND_PHASE.get(String(kind)) })

/** A budget as the log names it: minutes, or seconds under one. @param {number} ms @returns {string} */
const budgetText = ms => (ms >= 60000 ? `${Math.round(ms / 60000)}min` : `${Math.max(1, Math.round(ms / 1000))}s`)

/**
 * @typedef {{ hit: Promise<unknown>, fired: boolean, sent: number, total: () => number, belowFloor: () => boolean, dispose: () => void }} Cut
 *   one task's budget: whether a dispatch lost the race to it, how many dispatches it covered, and whether what is
 *   left is under the floor a re-dispatch is worth (lib/review-deadlines.mjs, `retryFloorMs`)
 */

/** The budget of a task of `kind`. @param {string | undefined} kind @returns {Cut} */
export function taskCut(kind) {
  const ms = taskDeadlineMs(kind)
  const wait = makeDeadlineBudget(ms, { floorMs: retryFloorMs(ms) })
  return { hit: wait.hit, fired: false, sent: 0, total: wait.total, belowFloor: wait.belowFloor, dispose: wait.dispose }
}

/**
 * `dispatch` raced against the budget its options carry (`cut`, stripped before the dispatch): its answer, or
 * DEADLINE_HIT when the budget ran out first, the cut marked fired. A re-dispatch under the same budget (the re-run
 * on the default type) is not sent once what is left is under the floor, as the engine's `ragent` holds it: it
 * would time out before it could answer, so it comes back null, a dead agent, said in the log.
 * @template {{ cut?: Cut, label?: string }} O
 * @param {(prompt: string, opts: Omit<O, 'cut'>) => Promise<unknown>} dispatch
 * @param {(message: string) => void} [logLine]
 * @returns {(prompt: string, opts: O) => Promise<unknown>}
 */
export function deadlined(dispatch, logLine = () => {}) {
  return async (prompt, opts) => {
    const { cut, ...rest } = opts
    if (!cut) return dispatch(prompt, rest)
    if (cut.sent > 0 && cut.belowFloor()) {
      logLine(`⏱️ task agent '${opts.label || '?'}' returned no result with less than the ${Math.round(retryFloorMs(cut.total()) / 1000)}s floor left of its ${Math.round(cut.total() / 1000)}s deadline budget — NOT re-dispatching (a second attempt would time out before it could answer); treated as a dead agent`)
      return null
    }
    cut.sent++
    const got = await Promise.race([dispatch(prompt, rest), cut.hit])
    if (got === DEADLINE_HIT) cut.fired = true
    return got
  }
}

/** Whether `got` is a deadline fire. @param {unknown} got @returns {boolean} */
export const deadlineFired = got => got === DEADLINE_HIT

/** The log line of a task abandoned at its deadline. @param {string} label @param {Cut} cut @returns {string} */
export const abandonedLine = (label, cut) => `⏱️ task agent '${label || '?'}' exhausted its ${budgetText(cut.total())} budget with no response — abandoning the wait (one budget for the task, spent by the fire, so it is not re-dispatched; treated as a dead agent: the binary is told it was abandoned, fails it at once and reads no later answer)`
