// An agent that failed on the account's usage limit is not a one-off death: every dispatch after it
// fails the same way until the limit resets, so a run that keeps dispatching spends the rest of its
// lenses and verifiers on agents that cannot answer and then reports over them. The engine stops
// dispatching review work at the first such failure and says so; it still attempts its record, but
// the logger runs on the same account, so under an account-wide limit the record stays in `.partial`
// for `craft-log-run recover` (realm @nick/craft, nodes #298, #299). Inlined into src/review.js,
// src/adversarial-review.js and src/rust-audit.js.
//
// Only an ACCOUNT limit with a reset stops a run. A transient rate limit (429, "try again") is an
// ordinary death that the engines' re-dispatch already handles, so it is deliberately not matched.
// Only an error's text, or an answer short enough to be one, is read: a report or a finding may well
// talk about limits, and reading those would stop a healthy run.

export const LIMIT_ANSWER_MAX = 400
export const LIMIT_PATTERNS = [
  /\bhit your (?:[\w-]+ )?limit\b/i,
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

/**
 * The shell command that promotes a run's `.partial` checkpoints into a partial record, run in the
 * reviewed repository with the installed plugin of this version.
 * @param {string} version
 * @returns {string}
 */
export function recoverCommand(version) {
  return `node "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/${version}/lib/craft-log-run.mjs" recover`
}

/**
 * What a human does about a run stopped at the usage limit, '' when it was not: the logger shares the
 * account, so a record lost to the same limit is recovered from `.partial` once the limit resets.
 * @param {ReturnType<typeof makeLimitStop>} stop
 * @param {string} version
 * @returns {string}
 */
export function limitStopAdvice(stop, version) {
  if (!stop.seen()) return ''
  return `${stop.note()}. The run record was attempted, but its logger runs on the same account; if it is reported lost, run this in the reviewed repository once the limit resets, to promote this run's .partial checkpoints into a partial record: \`${recoverCommand(version)}\``
}
