// One recalled prior decision, read and checked: its fields as strings (a memory record read as it is
// recalled), and what refuses it — a missing field, a field past its ceiling, or an anchor (scope,
// commit, id) unfit for the shell line the scope check runs (lib/prior-decision-scope.mjs). The
// argument as a whole and the matching are lib/prior-decisions.mjs.
// Inlined into workflows/review.js and workflows/adversarial-review.js (no imports: the sandbox has
// no module system).

// Per-field ceilings. A field over its ceiling refuses the whole decision (said so) — a reason cut
// mid-sentence would mark a finding with a rationale nobody wrote.
export const DECISION_FIELD_MAX = { id: 80, title: 200, scope: 300, reason: 1200, who: 120, when: 40, link: 500 }
/**
 * @typedef {{ id: string, title: string, scope: string, reason: string, who: string, when: string, link: string, commit: string }} PriorDecision
 */

/** Path segments with `.`, empty segments and separators folded; `..` kept literal. @param {string} p */
export function decisionScopeParts(p) {
  return p.split(/[\\/]+/).filter(s => s && s !== '.')
}

/** @param {unknown} v @returns {string} */
export function decisionText(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The decision's fields as strings, trimmed. A memory record (skills/memory) is read as it is
 * recalled: `body`, `date` and `author` stand in for `reason`, `when` and `who`, and the first
 * http(s) URL in `links` for `link`.
 * @param {Record<string, unknown>} o @returns {PriorDecision}
 */
export function decisionFields(o) {
  /** @param {string} k @param {string} [alt] */
  const f = (k, alt = '') => decisionText(o[k]) || decisionText(o[alt])
  const links = Array.isArray(o['links']) ? o['links'] : []
  const url = decisionText(links.find(l => /^https?:\/\//.test(decisionText(l))))
  return { id: f('id'), title: f('title'), scope: f('scope') || '.', reason: f('reason', 'body'), who: f('who', 'author'), when: f('when', 'date'), link: f('link') || url, commit: f('commit') }
}

/**
 * What is wrong with a decision, as the tail of a refusal sentence; '' when nothing is.
 * @param {Record<string, unknown>} o @param {PriorDecision} d @returns {string}
 */
export function decisionProblem(o, d) {
  if (o['kind'] != null && decisionText(o['kind']) !== 'decision') return ` is a ${JSON.stringify(o['kind'])} record, not a decision`
  if (o['status'] != null && decisionText(o['status']) !== 'active') return ` is not active (status ${JSON.stringify(o['status'])})`
  if (!d.id || !d.title || !d.reason) return ' lacks an id, a title or a reason'
  const over = Object.entries(DECISION_FIELD_MAX).find(([k, max]) => d[/** @type {keyof PriorDecision} */ (k)].length > max)
  if (over) return `: ${over[0]} is ${d[/** @type {keyof PriorDecision} */ (over[0])].length} chars, over the ${over[1]}-char ceiling`
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
 * One decision as given, checked: a refusal sentence, or the decision.
 * @param {unknown} raw @param {number} i @returns {PriorDecision | string}
 */
export function readPriorDecision(raw, i) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `decision #${i} is not an object`
  const o = /** @type {Record<string, unknown>} */ (raw)
  const d = decisionFields(o)
  const problem = decisionProblem(o, d)
  return problem ? `decision #${i}${d.id && !hasControlChar(d.id) ? ` (${d.id})` : ''}${problem}` : d
}
