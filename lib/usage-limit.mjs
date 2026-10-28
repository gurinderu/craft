// An agent that failed on the account's usage limit is not a one-off death: every dispatch after it
// fails the same way until the limit resets, so a run that keeps dispatching spends the rest of its
// agents on calls that cannot answer and then reports over them (realm @nick/craft, nodes #298, #299).
// Each engine stops at the first such failure it can SEE: a thrown error, or a short text answer, from
// a dispatch routed through its stop (review: every ragent call; adversarial-review: its lenses,
// verifiers, critic, memory recall and judges; rust-audit: its scout, dimensions, verification, memory
// recall and synthesis, plus the limit a nested review reports in its own text: limitInReport,
// lib/limit-report.mjs). Under an account limit agent() usually carries no text at all, it resolves
// null like any dead agent (node #300); that is a stop only when a whole dispatch round died (round,
// below), and the report says which of the two stopped it. A stopped run still attempts its record, but
// the logger runs on the same account, so the record may be lost too, and the stop's advice says what
// can be recovered (limitStopAdvice, lib/limit-report.mjs).
// Imported by lib/review-run-agent.mjs (review), src/adversarial-review.js and src/rust-audit.js.
//
// Only an ACCOUNT limit with a reset stops a run. A transient rate limit (429, "try again") is an
// ordinary death that the engines' re-dispatch already handles, so it is deliberately not matched.
// Only an error's text, or an answer short enough to be one, is read: a report or a finding may well
// talk about limits, and reading those would stop a healthy run.

export const LIMIT_ANSWER_MAX = 400
export const LIMIT_PATTERNS = [
  /\bhit your (?!rate\b)(?:[\w-]+ )?limit\b/i,
  /\b(?:usage|weekly|daily|monthly|session|5-hour) limit\b[^\n]*\b(?:reached|resets?)\b/i,
  /\breached (?:your|the) (?:\w+ )?usage limit\b/i,
]

/**
 * The usage/rate-limit message in a failure's text, trimmed to one line, or '' when the text is not one.
 * @param {unknown} text an error message, or an agent's text answer
 * @returns {string}
 */
export function usageLimitText(text) {
  const s = String(text ?? '')
  if (!s.trim()) return ''
  const line = s.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).find(l => LIMIT_PATTERNS.some(p => p.test(l)))
  return line ? line.slice(0, 200) : ''
}

/** @param {unknown} e @returns {string} */
export function errorText(e) {
  return String((e && typeof e === 'object' && 'message' in e ? /** @type {{ message?: unknown }} */ (e).message : e) ?? '')
}

// The dead round (realm @nick/craft, node #299): a dispatch pass (a lens round, a unit pass, verification,
// a nested engine's phase) in which every agent dispatched, each attempt of its re-dispatch ladder
// counted, came back null, with no live answer at all. A throw is not such a death: it carries its error,
// and a budget-exceeded throw must still fail the run closed. Checked when the round has settled, never
// inside it: a dead agent comes back in seconds and a live one in minutes, so inside a sliding window most of a
// round's queue can die before its first live answer, and any count of deaths stopped runs where one
// slice answered and its findings went unverified. Under a limit a dead agent costs next to nothing; what
// waiting for the round's end costs is time. An attempt counts in exactly the rounds open when it was
// DISPATCHED, in every one open at once, and its death settles against those same rounds, never against
// the rounds open when it comes back: an agent sent before a round opened (review's extra-lens discovery
// beside lens round 1) is no agent of that round, its death neither adds to nor completes the round's dead.
// So a round's deaths never exceed its dispatches, and one live answer among them keeps it alive. A
// deadline fire is a live agent taking too long, neither a dispatch's death nor counted as one, and a round
// with one is not dead.
const DEATHS_LIKELY = "most likely the account's usage limit or a failure (the reason shows in the Workflow tool's failures list)"

/**
 * The run's stop: `seen` what stopped it ('' until something did), `cause` which stop it was,
 * `observeError` and `observeAnswer` read one agent outcome for the limit text and answer whether it was
 * a limit failure, `observeDispatch` counts one agent attempt in the rounds open now and returns its
 * `died`, which counts that attempt's null answer in those same rounds (once, however often called),
 * `round` runs one dispatch pass and stops the run when every agent dispatched in it died.
 * @param {(line: string) => void} say
 * @returns {{ seen: () => string, cause: () => '' | 'limit' | 'deaths', observeError: (e: unknown) => boolean, observeAnswer: (answer: unknown) => boolean, observeDispatch: () => (() => void), round: <T>(name: string, pass: () => Promise<T>) => Promise<T>, note: () => string }}
 */
export function makeLimitStop(say) {
  let hit = ''
  /** @type {'' | 'limit' | 'deaths'} */
  let cause = ''
  /** @type {Set<{ sent: number, dead: number }>} */
  const open = new Set()
  /** @param {'limit' | 'deaths'} why @param {string} text @returns {boolean} */
  const stopOn = (why, text) => {
    if (!text) return false
    if (!hit) {
      hit = text
      cause = why
      say(`\u26d4 ${why === 'limit' ? `usage limit reached (${text})` : `${text} \u2014 ${DEATHS_LIKELY}`} \u2014 no further review agents are dispatched; the run reports what it has as INCOMPLETE`)
    }
    return true
  }
  return {
    seen: () => hit,
    cause: () => cause,
    observeError: e => stopOn('limit', usageLimitText(errorText(e))),
    observeAnswer: answer => typeof answer === 'string' && answer.length <= LIMIT_ANSWER_MAX && stopOn('limit', usageLimitText(answer)),
    observeDispatch: () => {
      const rounds = [...open]
      for (const r of rounds) r.sent++
      let settled = false
      return () => {
        if (settled) return
        settled = true
        for (const r of rounds) r.dead++
      }
    },
    round: async (name, pass) => {
      const r = { sent: 0, dead: 0 }
      open.add(r)
      try {
        return await pass()
      } finally {
        open.delete(r)
        if (r.sent && r.dead === r.sent) stopOn('deaths', `every agent dispatched in ${name} died with no answer`)
      }
    },
    note: () => (cause === 'limit' ? `stopped: usage limit reached (${hit})`
      : cause === 'deaths' ? `stopped: ${hit}, ${DEATHS_LIKELY}` : ''),
  }
}

/**
 * An agent callback that dispatches nothing once the run is stopped (answering null, as a dead agent
 * does), turns a limit failure of its own into that stop and a null, and counts each dispatch and each
 * null answer in the rounds open at its dispatch.
 * @template P, O
 * @param {(prompt: P, opts: O) => Promise<unknown>} call
 * @param {ReturnType<typeof makeLimitStop>} stop
 * @returns {(prompt: P, opts: O) => Promise<unknown>}
 */
export function stopAtLimit(call, stop) {
  return async (prompt, opts) => {
    if (stop.seen()) return null
    const died = stop.observeDispatch()
    try {
      const res = await call(prompt, opts)
      if (stop.observeAnswer(res)) return null
      if (res == null) died()
      return res
    } catch (e) {
      if (stop.observeError(e)) return null
      throw e
    }
  }
}
