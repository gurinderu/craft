// An agent that failed on the account's usage or rate limit is not a one-off death: every dispatch
// after it fails the same way until the limit resets, so a run that keeps dispatching spends the rest
// of its lenses and verifiers on agents that cannot answer and then reports over them. The engine
// stops dispatching review work at the first such failure, says so, and still files its record
// (realm @nick/craft, nodes #298, #299). Inlined into src/review.js, src/adversarial-review.js and
// src/rust-audit.js.
//
// Only an error's text, or an answer short enough to be one, is read: a report or a finding may well
// talk about rate limits, and reading those would stop a healthy run.

export const LIMIT_ANSWER_MAX = 400
export const LIMIT_PATTERNS = [
  /\bhit your (?:\w+[ -])?limit\b/i,
  /\b(?:usage|weekly|daily|monthly|session) limit (?:reached|exceeded|hit)\b/i,
  /\breached (?:your|the) (?:\w+ )?(?:usage|rate) limit\b/i,
  /\brate[ -]limit(?:ed)?\b[^\n]*\b(?:429|exceeded|reached|try again|resets?)\b/i,
  /\b(?:usage|rate|weekly) limit\b[^\n]*\bresets?\b/i,
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

/**
 * The run's stop at a usage limit: `seen` the first limit message ('' until one arrives), `observe`
 * reads one agent outcome and answers whether it was a limit failure.
 * @param {(line: string) => void} say
 * @returns {{ seen: () => string, observeError: (e: unknown) => boolean, observeAnswer: (answer: unknown) => boolean, note: () => string }}
 */
export function makeLimitStop(say) {
  let hit = ''
  /** @param {string} text */
  const take = text => {
    if (!text) return false
    if (!hit) {
      hit = text
      say(`\u26d4 usage limit reached (${text}) \u2014 no further review agents are dispatched; the run reports what it has as INCOMPLETE`)
    }
    return true
  }
  return {
    seen: () => hit,
    observeError: e => take(usageLimitText(errorText(e))),
    observeAnswer: answer => typeof answer === 'string' && answer.length <= LIMIT_ANSWER_MAX && take(usageLimitText(answer)),
    note: () => (hit ? `stopped: usage limit reached (${hit})` : ''),
  }
}

/**
 * An agent callback that dispatches nothing once the stop has seen a limit (answering null, as a dead
 * agent does), and turns a limit failure of its own into that stop and a null.
 * @template P, O
 * @param {(prompt: P, opts: O) => Promise<unknown>} call
 * @param {ReturnType<typeof makeLimitStop>} stop
 * @returns {(prompt: P, opts: O) => Promise<unknown>}
 */
export function stopAtLimit(call, stop) {
  return async (prompt, opts) => {
    if (stop.seen()) return null
    try {
      const res = await call(prompt, opts)
      return stop.observeAnswer(res) ? null : res
    } catch (e) {
      if (stop.observeError(e)) return null
      throw e
    }
  }
}
