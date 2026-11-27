// The rounds every kind of run of the CLI's step protocol drives (realm @nick/craft, node #453): the step's tasks run,
// their answers submitted, the next step read, until the binary says the run is done. What a round dispatches, how it
// submits, what a lost step comes back as and when the driver gives up are the kind's (integrations/shared/cli-review-steps.mjs
// for the review).

/**
 * @template {{ run: string, done: false }} P  a pending step, its tasks to run
 * @template {{ run: string, done: true }} F  the finished step
 * @template E  how the run ends, as the kind says it
 * @typedef {object} Rounds
 * @property {number} maxRounds  the rounds after which the driver gives up, a backstop: the binary decides when the run is done
 * @property {(step: P, round: number) => Promise<void>} dispatch  runs the step's tasks
 * @property {(step: P, round: number) => Promise<{ step: P | F } | { error: string, harness?: string }>} submit  hands their answers back and reads the next step
 * @property {(step: P | F) => void} heard  a step read, as the kind keeps it
 * @property {(read: { error: string, harness?: string }) => Promise<E>} lost  how the run ends when a step could not be read
 * @property {(step: P) => E} gaveUp  how it ends past `maxRounds`
 * @property {(step: F) => E} finished  how it ends once the binary is done
 */

/**
 * Rounds of agents and submits from `first` until the binary is done, a step is lost, or `maxRounds` are spent.
 * @template {{ run: string, done: false }} P @template {{ run: string, done: true }} F @template E
 * @param {P | F} first @param {Rounds<P, F, E>} kind @returns {Promise<E>}
 */
export async function stepRounds(first, kind) {
  /** @type {{ step: P | F } | { error: string, harness?: string }} */
  let read = { step: first }
  for (let round = 1; ; round++) {
    if ('error' in read) return kind.lost(read)
    const step = read.step
    if (binaryDone(step)) return kind.finished(step)
    if (round > kind.maxRounds) return kind.gaveUp(step)
    await kind.dispatch(step, round)
    read = await kind.submit(step, round)
    if ('step' in read) kind.heard(read.step)
  }
}

/**
 * Whether the binary is done with the run.
 * @template {{ done: false }} P @template {{ done: true }} F @param {P | F} step @returns {step is F}
 */
const binaryDone = step => step.done

/**
 * A pending step's tasks run in parallel through `runner`, in the Agents phase, the round logged with `what` the
 * kind adds ('' none). No schema: the binary checks each answer file, and a dead agent leaves none, which the
 * binary asks for again.
 * @param {{ phase: (title: string) => void, log: (message: string) => void, parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>> }} sb
 * @param {{ run: (t: import('./cli-review-step.mjs').Task) => Promise<unknown> }} runner
 * @param {{ tasks: import('./cli-review-step.mjs').Task[] }} step @param {number} round @param {string} [what]
 */
export async function dispatchTasks(sb, runner, step, round, what = '') {
  sb.phase('Agents')
  sb.log(`round ${round}${what ? ` (${what})` : ''}: ${step.tasks.length} task(s) — ${step.tasks.map(t => t.label).join(', ')}`)
  await sb.parallel(step.tasks.map(t => () => runner.run(t)))
}
