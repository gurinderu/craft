// One recalled prior decision, read and checked: its fields as strings (a memory record, realm @nick/craft node #177, read as it is
// recalled), and what refuses it — a missing field, a field past its ceiling, or an anchor (scope,
// commit, id) unfit for the shell line the scope check runs (lib/prior-decision-scope.mjs). The
// argument as a whole and the matching are lib/prior-decisions.mjs.
// A deferred finding is recorded as an open question, not a decision (realm @nick/craft, node #204):
// a `question` record is read here the same way and carries its kind, so the same scope check and
// matching apply and only its mark and its section differ (lib/prior-decision-apply.mjs).
// Inlined into src/review.js and src/adversarial-review.js (no imports: the sandbox has
// no module system).

// Per-field ceilings. A field over its ceiling refuses the whole decision (said so) — a reason cut
// mid-sentence would mark a finding with a rationale nobody wrote.
export const DECISION_FIELD_MAX = { id: 80, title: 200, scope: 300, reason: 1200, who: 120, when: 40, link: 500 }
/**
 * `deferred`: the record says it defers a review finding (`deferred: true`, a boolean — what makes a
 * question a deferral). `supersedes`: the record ids its `supersedes: <id>` / `answers: <id>` links name.
 * @typedef {{ id: string, title: string, scope: string, reason: string, who: string, when: string, link: string, commit: string, kind: 'decision' | 'question', deferred: boolean, supersedes: string[] }} PriorDecision
 */

// The record kinds a review applies; any other kind (a lesson) is refused by name.
export const PRIOR_RECORD_KINDS = ['decision', 'question']

/** Path segments with `.`, empty segments and separators folded; `..` kept literal. @param {string} p */
export function decisionScopeParts(p) {
  return p.split(/[\\/]+/).filter(s => s && s !== '.')
}

/** @param {unknown} v @returns {string} */
export function decisionText(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * A record's kind, lower-cased; a record without one takes the kind its id prefix names, for every
 * kind of the memory skill (id = `<kind>-<hash>`: `decision-`, `question-`, `lesson-`), and is a
 * `decision` only when its id names none — a launcher that leaves `kind` out must not turn a deferral
 * into a rejection, nor a lesson into a decision.
 * @param {Record<string, unknown>} o @returns {string}
 */
export function recordKind(o) {
  if (o['kind'] != null) return decisionText(o['kind']).toLowerCase()
  const m = /^(decision|question|lesson)-/i.exec(decisionText(o['id']))
  return m ? String(m[1]).toLowerCase() : 'decision'
}

/** The ids a record's `supersedes: <id>` and `answers: <id>` links name. @param {unknown[]} links @returns {string[]} */
export function supersededIds(links) {
  return links.flatMap(l => {
    const m = /^(?:supersedes|answers):\s*(\S+)$/i.exec(decisionText(l))
    return m ? [String(m[1])] : []
  })
}

/**
 * The decision's fields as strings, trimmed. A memory record (skills/memory) is read as it is
 * recalled: `body`, `date` and `author` stand in for `reason`, `when` and `who`, and the first
 * http(s) URL in `links` for `link`. `kind` is `question` only when recordKind reads one; `deferred` only
 * a boolean `true`.
 * @param {Record<string, unknown>} o @returns {PriorDecision}
 */
export function decisionFields(o) {
  /** @param {string} k @param {string} [alt] */
  const f = (k, alt = '') => decisionText(o[k]) || decisionText(o[alt])
  const links = Array.isArray(o['links']) ? o['links'] : []
  const url = decisionText(links.find(l => /^https?:\/\//.test(decisionText(l))))
  return { id: f('id'), title: f('title'), scope: f('scope') || '.', reason: f('reason', 'body'), who: f('who', 'author'), when: f('when', 'date'), link: f('link') || url, commit: f('commit'), kind: recordKind(o) === 'question' ? 'question' : 'decision', deferred: o['deferred'] === true, supersedes: supersededIds(links) }
}

/**
 * What is wrong with a decision, as the tail of a refusal sentence; '' when nothing is.
 * @param {Record<string, unknown>} o @param {PriorDecision} d @returns {string}
 */
export function decisionProblem(o, d) {
  if (!PRIOR_RECORD_KINDS.includes(recordKind(o))) return ` is a ${JSON.stringify(recordKind(o))} record, not a decision or a question`
  if (o['status'] != null && decisionText(o['status']) !== 'active') return ` is not active (status ${JSON.stringify(o['status'])})`
  if (!d.id || !d.title || !d.reason) return ' lacks an id, a title or a reason'
  const over = Object.entries(DECISION_FIELD_MAX).find(([k, max]) => d[/** @type {keyof typeof DECISION_FIELD_MAX} */ (k)].length > max)
  if (over) return `: ${over[0]} is ${d[/** @type {keyof typeof DECISION_FIELD_MAX} */ (over[0])].length} chars, over the ${over[1]}-char ceiling`
  return decisionAnchorProblem(d)
}

// A scope is a repo-relative path of these characters only; the shell line quotes it, and the check
// keeps anything a quote could mishandle out of it.
export const SAFE_SCOPE = /^[A-Za-z0-9._@+/ -]+$/

/** Whether `s` holds a control character (a newline among them). @param {string} s */
export function hasControlChar(s) {
  return [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
}

/**
 * The id, the scope and the commit go into a shell line (scopeCheckScript) and the agent prompt that
 * carries it: no control character in any, the scope a repo-relative path of safe characters, the
 * commit a hash. '' when all hold.
 * @param {PriorDecision} d @returns {string}
 */
export function decisionAnchorProblem(d) {
  const ctl = /** @type {const} */ (['id', 'scope', 'commit']).find(k => hasControlChar(d[k]))
  if (ctl) return `: ${ctl} contains a control character`
  if (/^([\\/]|~|[A-Za-z]:)/.test(d.scope) || decisionScopeParts(d.scope).includes('..')) return `: scope ${JSON.stringify(d.scope)} is not a repo-relative path`
  if (!SAFE_SCOPE.test(d.scope)) return `: scope ${JSON.stringify(d.scope)} has a character outside letters, digits and ._@+/ -`
  if (d.commit && !/^[0-9a-f]{7,40}$/i.test(d.commit)) return `: commit ${JSON.stringify(d.commit)} is not a commit hash`
  return ''
}

/**
 * One decision as given, checked: a refusal sentence, or the decision. `at` is its index in the list,
 * or the label a refusal opens with (lib/memory-recall.mjs names the part it came from).
 * @param {unknown} raw @param {number | string} at @returns {PriorDecision | string}
 */
export function readPriorDecision(raw, at) {
  const label = typeof at === 'number' ? `decision #${at}` : at
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${label} is not an object`
  const o = /** @type {Record<string, unknown>} */ (raw)
  const d = decisionFields(o)
  const problem = decisionProblem(o, d)
  return problem ? `${label}${d.id && !hasControlChar(d.id) ? ` (${d.id})` : ''}${problem}` : d
}
