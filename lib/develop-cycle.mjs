// One record per craft:develop cycle in the run store (realm @nick/craft, node #281): its rounds — each
// one's engine, whether it reviewed the whole branch diff or the fixed delta (the light loop, node #278),
// its verdict and its open Medium+ count — whether it converged, hit the round cap or stopped without a
// verdict (node #263), and every full review run after convergence with what it found. The develop skill
// hands the cycle to `craft-log-run develop-cycle`, the one writer of the store (node #39); analyze-runs
// prints the DEVELOP section from these records and keeps them out of the review aggregates.

export const DEVELOP_KIND = 'develop'
export const DEVELOP_OUTCOMES = ['converged', 'capped', 'no-verdict']
export const DEVELOP_MODES = ['light', 'full']
// Generous beyond the 4-round cap of node #263: a project that declares its own cap is recorded as it ran.
export const DEVELOP_ROUNDS_MAX = 12
const TEXT_MAX = 120

/**
 * @typedef {{ n: number, engine: string, scope: 'full' | 'delta', verdict: string, mediumPlus: number | null }} DevelopRound
 * @typedef {{ afterRound: number, engine: string, verdict: string, mediumPlus: number | null }} FullReview
 * @typedef {{ mode: string, outcome: string, rounds: DevelopRound[], fullReviews: FullReview[] }} DevelopCycle
 * @typedef {import('./run-record.mjs').RunRecord} RunRecord
 */

/** A short text field, or a throw naming it. @param {unknown} v @param {string} what @returns {string} */
function text(v, what) {
  if (typeof v !== 'string' || !v.trim() || v.length > TEXT_MAX || [...v].some(ch => ch.charCodeAt(0) < 32)) throw new Error(`${what} must be a one-line string of at most ${TEXT_MAX} chars, got ${JSON.stringify(v)}`)
  return v.trim()
}

/** A count of open Medium+ findings, null when the round had no verdict. @param {unknown} v @param {string} what @returns {number | null} */
function count(v, what) {
  if (v === null) return null
  if (!Number.isInteger(v) || /** @type {number} */ (v) < 0) throw new Error(`${what} must be a non-negative integer or null, got ${JSON.stringify(v)}`)
  return /** @type {number} */ (v)
}

/** @param {unknown} v @param {string} what @returns {Record<string, unknown>} */
function obj(v, what) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} must be an object`)
  return /** @type {Record<string, unknown>} */ (v)
}

/** @param {unknown} v @param {number} i @returns {DevelopRound} */
function readRound(v, i) {
  const o = obj(v, `rounds[${i}]`)
  const scope = o['scope']
  if (scope !== 'full' && scope !== 'delta') throw new Error(`rounds[${i}].scope must be "full" or "delta", got ${JSON.stringify(scope)}`)
  return { n: i + 1, engine: text(o['engine'], `rounds[${i}].engine`), scope, verdict: text(o['verdict'], `rounds[${i}].verdict`), mediumPlus: count(o['mediumPlus'], `rounds[${i}].mediumPlus`) }
}

/** @param {unknown} v @param {number} i @param {number} rounds @returns {FullReview} */
function readFullReview(v, i, rounds) {
  const o = obj(v, `fullReviews[${i}]`)
  const after = o['afterRound']
  if (!Number.isInteger(after) || /** @type {number} */ (after) < 1 || /** @type {number} */ (after) > rounds) throw new Error(`fullReviews[${i}].afterRound must name one of the ${rounds} round(s), got ${JSON.stringify(after)}`)
  return { afterRound: /** @type {number} */ (after), engine: text(o['engine'], `fullReviews[${i}].engine`), verdict: text(o['verdict'], `fullReviews[${i}].verdict`), mediumPlus: count(o['mediumPlus'], `fullReviews[${i}].mediumPlus`) }
}

/** One of `allowed`, or a throw naming the field. @param {unknown} v @param {string} what @param {string[]} allowed @returns {string} */
function oneOf(v, what, allowed) {
  if (typeof v !== 'string' || !allowed.includes(v)) throw new Error(`${what} must be one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`)
  return v
}

/** The rounds, numbered from 1. @param {unknown} raw @returns {DevelopRound[]} */
function readRounds(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > DEVELOP_ROUNDS_MAX) throw new Error(`rounds must hold 1 to ${DEVELOP_ROUNDS_MAX} round(s)`)
  return raw.map(readRound)
}

/** The full reviews, each after one of the rounds. @param {unknown} raw @param {number} rounds @returns {FullReview[]} */
function readFullReviews(raw, rounds) {
  if (!Array.isArray(raw)) throw new Error('fullReviews must be an array')
  return raw.map((v, i) => readFullReview(v, i, rounds))
}

/** Whether the last round, and every full review run after it, left no open Medium+. @param {DevelopRound[]} rounds @param {FullReview[]} fullReviews */
function endsClean(rounds, fullReviews) {
  const fullClean = fullReviews.every(f => f.afterRound !== rounds.length || f.mediumPlus === 0)
  return rounds[rounds.length - 1]?.mediumPlus === 0 && fullClean
}

/**
 * The cycle as the develop skill reports it, read strictly: a throw names the first field that does not fit.
 * A converged cycle's last round raised no open Medium+, and neither did any full review run after it.
 * @param {unknown} payload @returns {DevelopCycle}
 */
export function readDevelopCycle(payload) {
  const o = obj(payload, 'the cycle')
  const mode = oneOf(o['mode'] ?? 'light', 'mode', DEVELOP_MODES)
  const outcome = oneOf(o['outcome'], 'outcome', DEVELOP_OUTCOMES)
  const rounds = readRounds(o['rounds'])
  const fullReviews = readFullReviews(o['fullReviews'] ?? [], rounds.length)
  if (outcome === 'converged' && !endsClean(rounds, fullReviews)) throw new Error('outcome "converged" needs the last round, and a full review after it, to leave no open Medium+')
  return { mode, outcome, rounds, fullReviews }
}

/**
 * The run record of a cycle: `kind` develop, the outcome as its verdict, its round count as `round`, the
 * cycle under `develop`; the writer stamps the project, branch, head and time. @param {unknown} payload @returns {RunRecord}
 */
export function developCycleRecord(payload) {
  const cycle = readDevelopCycle(payload)
  return { schemaVersion: 1, runtime: 'claude-code', kind: DEVELOP_KIND, name: 'develop', verdict: cycle.outcome, round: cycle.rounds.length, develop: cycle }
}

/** Whether a stored record is a develop cycle. @param {{ kind?: unknown }} r @returns {boolean} */
export function isDevelopRecord(r) {
  return r.kind === DEVELOP_KIND
}
