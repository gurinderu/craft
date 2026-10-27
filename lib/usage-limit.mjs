// An agent that failed on the account's usage limit is not a one-off death: every dispatch after it
// fails the same way until the limit resets, so a run that keeps dispatching spends the rest of its
// agents on calls that cannot answer and then reports over them (realm @nick/craft, nodes #298, #299).
// Each engine stops at the first such failure it can SEE: a thrown error, or a short text answer, from
// a dispatch routed through its stop (review: every ragent call; adversarial-review: its lenses,
// verifiers, critic, memory recall and judges; rust-audit: its scout, dimensions, verification, memory
// recall and synthesis, plus the stop a nested review reports in its own text: limitInReport and
// deathsInReport, lib/limit-report.mjs). A death that reaches an engine as a bare null carries no text; one
// such death is not a stop (its coverage hole makes the verdict INCOMPLETE), a streak of them is (below,
// DEATH_STREAK_STOP), and the report says which of the two stopped it. A stopped run still
// attempts its record, but the logger runs on the same account, so under an account-wide limit the
// record is lost too, and the stop's advice says what can be recovered (limitStopAdvice, lib/limit-report.mjs).
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

// The death streak (realm @nick/craft, nodes #299, #300): under an account limit the Workflow tool's
// agent() neither throws nor answers the limit text, it resolves null like any dead agent (the text
// shows only in the tool's failures list after the run), so the limit read above never fires and a run
// kept dispatching into it: 267-360 dead agents a run. A streak of DEATH_STREAK_STOP deaths with no live
// answer between them, counted in completion order across the whole run, is the same stop. A dead agent
// comes back in seconds and a live lens in minutes, so the threshold sits above what one concurrency
// window can die through its whole re-dispatch ladder before any live answer (realm @nick/craft, node
// #299): review's lens window, 16 dispatches of up to four agents each (reviewer agent and generic
// subagent, each re-dispatched once), is 64; its verification window, 24 agents each re-dispatched once,
// is 48. adversarial-review dispatches in barrier batches (4 by default) with no re-dispatch inside one,
// and rust-audit fans out its dimensions at two agents each, both well under. lib/usage-limit.test.mjs
// holds the relation against the real window constants. review's extra lenses run beside round 1 and are
// not in that window, so review raises its run's threshold by their burst once their list is known
// (raise, lib/review-extra-lens-run.mjs). A deadline fire is not a death here: it is a
// live agent taking too long against the engine's own budget, and the caller does not report it.
export const DEATH_STREAK_STOP = 65
export const DEATHS_LIKELY = "most likely an account usage limit or an outage (the reason shows in the Workflow tool's failures list)"

/**
 * The run's stop at a usage limit: `seen` what stopped it ('' until something did), `observeError` and
 * `observeAnswer` read one agent outcome for the limit text and answer whether it was a limit failure,
 * `observeDeath` counts one agent that came back with no answer and answers whether the run is now
 * stopped, `observeReportedDeaths` takes a streak a nested run reported (deathsInReport), `observeLive`
 * ends the streak, `cause` says which stop it was, `raise` lifts the streak threshold by a burst the run
 * dispatches beside its windows.
 * @param {(line: string) => void} say
 * @param {number} [threshold] the deaths in a row that stop the run
 * @returns {{ seen: () => string, cause: () => '' | 'limit' | 'deaths', observeError: (e: unknown) => boolean, observeAnswer: (answer: unknown) => boolean, observeDeath: () => boolean, observeReportedDeaths: (text: string) => boolean, observeLive: () => void, raise: (by: number) => void, note: () => string }}
 */
export function makeLimitStop(say, threshold = DEATH_STREAK_STOP) {
  let hit = ''
  /** @type {'' | 'limit' | 'deaths'} */
  let cause = ''
  let streak = 0
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
    observeDeath: () => {
      if (hit) return true
      if (++streak < threshold) return false
      return stopOn('deaths', `${streak} agents in a row died with no answer`)
    },
    observeReportedDeaths: text => stopOn('deaths', text),
    observeLive: () => { streak = 0 },
    raise: by => { threshold += Math.max(0, by) },
    note: () => (cause === 'limit' ? `stopped: usage limit reached (${hit})`
      : cause === 'deaths' ? `stopped: ${hit}, ${DEATHS_LIKELY}` : ''),
  }
}

/**
 * An agent callback that dispatches nothing once the stop has seen a limit (answering null, as a dead
 * agent does), turns a limit failure of its own into that stop and a null, and counts its null answers
 * toward the death streak and its live ones against it.
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
      if (stop.observeAnswer(res)) return null
      if (res == null) stop.observeDeath()
      else stop.observeLive()
      return res
    } catch (e) {
      if (stop.observeError(e)) return null
      throw e
    }
  }
}
