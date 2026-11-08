// The per-agent deadline of a cli-review task (lib/cli-review-task.mjs), as the review engine sets it
// (lib/review-run-agent.mjs, lib/review-deadlines.mjs): a task agent that has not answered when its budget runs out is
// abandoned and counts as dead — it leaves no answer file, which the binary asks for again or names as not run, as it
// does for any agent that died. The budget is the engine's per-phase table, the phase read from what the task is for
// (the binary's task kind); a fire is never re-dispatched, since it spent the budget. The sandbox has no
// AbortController, so the abandoned agent keeps its harness slot until the harness reaps it; and no clock, so the
// budget is an armed timer (lib/agent-deadline.mjs).
import { DEADLINE_HIT, makeDeadlineBudget } from './agent-deadline.mjs'
import { deadlineMsFor } from './review-deadlines.mjs'

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
 * `dispatch` raced against the deadline its options carry (`deadlineMs`, stripped before the dispatch): its answer, or
 * DEADLINE_HIT when the budget ran out first, said in the log.
 * @template {{ label?: string, deadlineMs?: number }} O
 * @param {(prompt: string, opts: Omit<O, 'deadlineMs'>) => Promise<unknown>} dispatch
 * @param {(message: string) => void} logLine
 * @returns {(prompt: string, opts: O) => Promise<unknown>}
 */
export function deadlined(dispatch, logLine) {
  return async (prompt, opts) => {
    const { deadlineMs, ...rest } = opts
    const wait = makeDeadlineBudget(Number(deadlineMs) > 0 ? Number(deadlineMs) : deadlineMsFor({}))
    try {
      const got = await Promise.race([dispatch(prompt, rest), wait.hit])
      if (got === DEADLINE_HIT) logLine(`⏱️ task agent '${opts.label || '?'}' exhausted its ${budgetText(wait.total())} budget with no response — abandoning the wait (a fire spends the budget, so it is not re-dispatched; treated as a dead agent: it leaves no answer file, which the binary asks for again or names as not run)`)
      return got
    } finally {
      // The armed timer outlives the answer otherwise, holding the run open for the whole deadline.
      wait.dispose()
    }
  }
}

/** Whether `got` is a deadline fire. @param {unknown} got @returns {boolean} */
export const deadlineFired = got => got === DEADLINE_HIT
