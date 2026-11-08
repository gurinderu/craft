// What a cli-review run cost as the driver observes it (lib/cli-review-steps.mjs), for its record's `runtimeStats`
// in the shape craft-log-run's transcript reading gives the engine's (`agents`, `wallClockMinutes`; lib/light-runs.mjs
// and analyze-runs read them) and its phase checkpoints. The sandbox reads no clock (lib/agent-deadline.mjs), so the
// wall time is the binary's: each step it prints carries `at`, when it printed it, and `took`, how long that command
// ran, both in milliseconds. The run's wall clock runs from the first command's start to the last step; the time
// between two steps is the phase whose tasks the earlier one handed out (its agents, then the submit that read them),
// and the first command's own time is `start`. The fetch of the binary before it and the record's write after it are
// outside. A binary that stamps no time leaves the minutes out, never zero; one that names no phase, the checkpoints.

/** @typedef {{ done: boolean, phase?: string, at?: number | null, took?: number | null }} Stamped  a step as the clock reads it */
/** @typedef {{ agents: number, wallClockMinutes?: number, phaseMinutes?: Record<string, number> }} RuntimeStats */
/** @typedef {import('./cli-review-steps.mjs').Agent} Agent */

/** Milliseconds as minutes to one place, as craft-log-run's `runtimeStats` rounds them. @param {number} ms */
const minutes = ms => Math.round(ms / 6000) / 10

/** A non-negative number of milliseconds, else null. @param {unknown} v @returns {number | null} */
export const millis = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/** The clock of one run. */
export function runClock() {
  let agents = 0
  /** @type {number | null} when the first stamped command began */
  let first = null
  /** @type {number | null} when the last stamped step was printed */
  let last = null
  // The phase of the tasks the last step handed out, '' when none or unnamed, and the agent count when it began.
  let current = ''
  let agentsAtPhase = 0
  /** @type {Record<string, number>} */
  const spent = {}
  /** @param {string} name @param {number} ms */
  const add = (name, ms) => { spent[name] = (spent[name] ?? 0) + ms }
  /** @param {Stamped} step */
  function stamp(step) {
    const at = millis(step.at)
    if (at === null) return
    const took = millis(step.took) ?? 0
    if (first === null) {
      first = at - took
      add('start', took)
    } else if (last !== null && current) {
      add(current, Math.max(0, at - last))
    }
    last = at
  }
  return {
    /** `dispatch` with each call counted. @param {Agent} dispatch @returns {Agent} */
    counted: dispatch => (prompt, opts) => { agents++; return dispatch(prompt, opts) },
    /**
     * Reads one step the binary printed: its time into the phase it closes, and the phase its tasks run in. Returns
     * the phase that ended with it, with its minutes so far (a phase the run comes back to adds up) and the agents
     * dispatched since it began; null when none ended.
     * @param {Stamped} step @returns {{ phase: string, minutes: number | null, agents: number } | null}
     */
    observe(step) {
      stamp(step)
      const next = step.done ? '' : String(step.phase ?? '')
      if (next === current) return null
      const ended = current ? { phase: current, minutes: current in spent ? minutes(spent[current] ?? 0) : null, agents: agents - agentsAtPhase } : null
      current = next
      agentsAtPhase = agents
      return ended
    },
    /** @returns {RuntimeStats} */
    stats() {
      if (first === null || last === null) return { agents }
      const phaseMinutes = Object.fromEntries(Object.entries(spent).map(([k, ms]) => [k, minutes(ms)]))
      return { agents, wallClockMinutes: minutes(last - first), phaseMinutes }
    },
  }
}
