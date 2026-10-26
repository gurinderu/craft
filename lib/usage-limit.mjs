// An agent that failed on the account's usage limit is not a one-off death: every dispatch after it
// fails the same way until the limit resets, so a run that keeps dispatching spends the rest of its
// agents on calls that cannot answer and then reports over them (realm @nick/craft, nodes #298, #299).
// Each engine stops at the first such failure it can SEE: a thrown error, or a short text answer, from
// a dispatch routed through its stop (review: every ragent call; adversarial-review: its lenses,
// verifiers, critic, memory recall and judges; rust-audit: its scout, dimensions, verification, memory
// recall and synthesis, plus the stop a nested review reports in its own text: limitInReport). A death that reaches an engine as a bare null carries no text and is not a
// stop; the dead agent's coverage hole makes the verdict INCOMPLETE instead. A stopped run still
// attempts its record, but the logger runs on the same account, so under an account-wide limit the
// record is lost too, and the stop's advice says what can be recovered (limitStopAdvice).
// Imported by src/review.js, src/adversarial-review.js and src/rust-audit.js.
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
 * The logger as a human runs it: CLAUDE_PLUGIN_ROOT, else this version's installed copy. Never a
 * craftRoot from the run's arguments, which a model composed: the advice is pasted into a shell.
 * @param {string} version
 * @returns {string}
 */
export function loggerCommand(version) {
  return `node "\${CLAUDE_PLUGIN_ROOT:-\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/${shellSafe(version)}}"/lib/craft-log-run.mjs`
}

/** A version as it may stand inside double quotes: digits, letters, dots and dashes only. @param {string} v */
export function shellSafe(v) {
  return String(v ?? '').replace(/[^\w.-]/g, '')
}

/**
 * What a human does about a run stopped at the usage limit, '' when it was not. The logger shares the
 * account, so the record may be lost to the same limit. An engine that writes phase checkpoints
 * (review) leaves them in `.partial` for `recover`; one that writes none has nothing to recover from,
 * and the honest advice is to rerun it.
 * @param {ReturnType<typeof makeLimitStop>} stop
 * @param {{ version: string, engine: string, checkpoints: boolean }} o
 * @returns {string}
 */
export function limitStopAdvice(stop, { version, engine, checkpoints }) {
  if (!stop.seen()) return ''
  const cmd = loggerCommand(version)
  const recovery = checkpoints
    ? `if it is reported lost, run this in the reviewed repository once the limit resets, to promote this run's .partial checkpoints into a partial record: \`${cmd} recover\``
    : `if it is reported lost, this run's record could not be written (${engine} writes no checkpoints): rerun the ${engine === 'rust-audit' ? 'audit' : 'review'} after the limit resets`
  return `${stop.note()}. The run record was attempted, but its logger runs on the same account; ${recovery}`
}

/**
 * The limit message a nested review's report says it stopped on, or '': the parent reads the child's
 * stop from the child's own words (`stopped: usage limit reached (<text>)`), not from its length.
 * @param {unknown} report
 * @returns {string}
 */
export function limitInReport(report) {
  const m = /stopped: usage limit reached \((.+?)\)(?=[.;:,]|\s|$)/m.exec(typeof report === 'string' ? report : '')
  return m ? usageLimitText(m[1]) : ''
}
