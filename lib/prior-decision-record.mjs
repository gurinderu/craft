// One recalled prior decision, read and checked: its fields as strings (a memory record, realm @nick/craft node #177, read as it is
// recalled), and what refuses it — a missing field, a field past its ceiling, or an anchor (scope,
// commit, id) unfit for the shell line the scope check runs (lib/prior-decision-scope.mjs). The
// argument as a whole and the matching are lib/prior-decisions.mjs.
// A deferred finding is recorded as an open question, not a decision (realm @nick/craft, node #204):
// a `question` record is read here the same way and carries its kind, so the same scope check and
// matching apply and only its mark and its section differ (lib/prior-decision-apply.mjs).
// A record that comes without an id gets the memory skill's id, derived from its kind, title and scope
// (lib/memory-record-id.mjs; realm @nick/craft, node #222): a launcher that builds records by hand need
// not hash them. One that lacks any of the three is still refused by name; a record WITH an id and no
// scope reads as the whole repo (`.`). A refusal names only the fields that are missing.
// A record may carry the finding's anchor, `line` and `lens` (realm @nick/craft, node #230): both
// optional — an old record without them still matches by its title (lib/prior-decision-match.mjs) —
// and a malformed one refuses the record by name. A gate tool's finding is anchored by its `ruleId` as
// well (realm @nick/craft, node #236), optional and checked the same way.
// Inlined into src/review.js, src/adversarial-review.js and src/rust-audit.js after memory-record-id.mjs
// (no imports there: the sandbox has no module system).
import { memoryRecordId } from './memory-record-id.mjs'

// Per-field ceilings. A field over its ceiling refuses the whole decision (said so) — a reason cut
// mid-sentence would mark a finding with a rationale nobody wrote.
export const DECISION_FIELD_MAX = { id: 80, title: 200, scope: 300, reason: 1200, who: 120, when: 40, link: 500 }
/**
 * `derived`: the id was derived from kind, title and scope, the record having none.
 * `deferred`: the record says it defers a review finding (`deferred: true`, a boolean — what makes a
 * question a deferral). `supersedes`: the record ids its `supersedes: <id>` / `answers: <id>` links name.
 * `stores`: the store's own ids its `store: <id>` links name — the ids a link may still name it by once
 * the engine set the skill's (realm @nick/craft, node #226); present only when there is one.
 * `line` and `lens`: the finding's anchor (realm @nick/craft, node #230), present only when given;
 * `ruleId`: the rule a gate tool's finding fired, beside them (realm @nick/craft, node #236).
 * `overrides`: the ids of the successors an overriding passed record was applied over (realm
 * @nick/craft, node #229) — set by the engine's merge, so the record is tried before them.
 * @typedef {{ id: string, title: string, scope: string, reason: string, who: string, when: string, link: string, commit: string, kind: 'decision' | 'question', deferred: boolean, supersedes: string[], stores?: string[], derived?: true, line?: number, lens?: string, ruleId?: string, overrides?: string[] }} PriorDecision
 */

// The longest lens a record may name, and the longest ruleId.
export const DECISION_LENS_MAX = 80
export const DECISION_RULE_ID_MAX = 120

/**
 * A record's `line`: a non-negative integer, or a string of digits; 0 when absent (0 is "no line", as
 * in a finding); -1 when malformed. @param {unknown} v @returns {number}
 */
export function recordLine(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v < 1e9 ? v : -1
  return typeof v === 'string' && /^\s*\d{1,9}\s*$/.test(v) ? Number(v) : -1
}

/** What is wrong with a record's anchor (`line`, `lens`, `ruleId`); '' when nothing is. @param {Record<string, unknown>} o @returns {string} */
export function anchorFieldProblem(o) {
  if (recordLine(o['line']) < 0) return `: line ${JSON.stringify(o['line'])} is not a line number`
  return anchorTextProblem(o, 'lens', DECISION_LENS_MAX) || anchorTextProblem(o, 'ruleId', DECISION_RULE_ID_MAX)
}

/** What is wrong with a text field of the anchor; '' when it is absent or fit. @param {Record<string, unknown>} o @param {string} k @param {number} max @returns {string} */
export function anchorTextProblem(o, k, max) {
  const v = o[k]
  if (v == null) return ''
  if (typeof v !== 'string') return `: ${k} ${JSON.stringify(v)} is not a string`
  if (v.trim().length > max) return `: ${k} is ${v.trim().length} chars, over the ${max}-char ceiling`
  return hasControlChar(v) ? `: ${k} contains a control character` : ''
}

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

/**
 * The memory skill's id of a record, from its own kind, title and scope, whatever id it carries (realm
 * @nick/craft, node #222); '' when it lacks any of the three — no scope is guessed.
 * @param {Record<string, unknown>} o @returns {string}
 */
export function skillRecordId(o) {
  const [kind, title, scope] = [decisionText(o['kind']).toLowerCase(), decisionText(o['title']), decisionText(o['scope'])]
  return kind && title && scope ? memoryRecordId(kind, title, scope) : ''
}

/**
 * The id a record without one gets by the memory skill's rule (skillRecordId); '' when it has an id or
 * lacks any of kind, title and scope. @param {Record<string, unknown>} o @returns {string}
 */
export function derivedRecordId(o) {
  return decisionText(o['id']) ? '' : skillRecordId(o)
}

/** The record's id: its own, else the derived one, else ''. @param {Record<string, unknown>} o @returns {string} */
export function recordId(o) {
  return decisionText(o['id']) || derivedRecordId(o)
}

/** The ids a record's `supersedes: <id>` and `answers: <id>` links name. @param {unknown[]} links @returns {string[]} */
export function supersededIds(links) {
  return linkedIds(links, /^(?:supersedes|answers):\s*(\S+)$/i)
}

/** The ids the links matching `re` (its group 1) name. @param {unknown[]} links @param {RegExp} re @returns {string[]} */
export function linkedIds(links, re) {
  return links.flatMap(l => {
    const m = re.exec(decisionText(l))
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
  const derived = derivedRecordId(o)
  const stores = linkedIds(links, /^store:\s*(\S+)$/i)
  return { id: f('id') || derived, title: f('title'), scope: f('scope') || '.', reason: f('reason', 'body'), who: f('who', 'author'), when: f('when', 'date'), link: f('link') || url, commit: f('commit'), kind: recordKind(o) === 'question' ? 'question' : 'decision', deferred: o['deferred'] === true, supersedes: supersededIds(links), ...(stores.length ? { stores } : {}), ...(derived ? { derived: /** @type {const} */ (true) } : {}), ...recordAnchor(o) }
}

/**
 * The record's anchor and overrides, each present only when given: `line` above 0, `lens` and `ruleId`
 * non-empty (realm @nick/craft, node #236), `overrides` the ids of a list of strings. @param {Record<string, unknown>} o
 * @returns {{ line?: number, lens?: string, ruleId?: string, overrides?: string[] }}
 */
export function recordAnchor(o) {
  const line = recordLine(o['line'])
  const lens = decisionText(o['lens'])
  const ruleId = decisionText(o['ruleId'])
  const overrides = Array.isArray(o['overrides']) ? o['overrides'].map(decisionText).filter(Boolean) : []
  return { ...(line > 0 ? { line } : {}), ...(lens ? { lens } : {}), ...(ruleId ? { ruleId } : {}), ...(overrides.length ? { overrides } : {}) }
}

/**
 * The required fields missing, as the tail of a refusal sentence — only those that are; '' when none
 * is. A record with a title and a reason but no id lacked the kind or the scope its id is derived from
 * (derivedRecordId). @param {PriorDecision} d @returns {string}
 */
export function missingFieldProblem(d) {
  if (!d.id && d.title && d.reason) return ' lacks an id, and the kind or the scope its id is derived from'
  const missing = [d.id ? '' : 'an id', d.title ? '' : 'a title', d.reason ? '' : 'a reason'].filter(Boolean)
  return missing.length ? ` lacks ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ` : ''}${missing.at(-1)}` : ''
}

/**
 * What is wrong with a decision, as the tail of a refusal sentence; '' when nothing is.
 * @param {Record<string, unknown>} o @param {PriorDecision} d @returns {string}
 */
export function decisionProblem(o, d) {
  if (!PRIOR_RECORD_KINDS.includes(recordKind(o))) return ` is a ${JSON.stringify(recordKind(o))} record, not a decision or a question`
  if (o['status'] != null && decisionText(o['status']) !== 'active') return ` is not active (status ${JSON.stringify(o['status'])})`
  const missing = missingFieldProblem(d)
  if (missing) return missing
  const over = Object.entries(DECISION_FIELD_MAX).find(([k, max]) => d[/** @type {keyof typeof DECISION_FIELD_MAX} */ (k)].length > max)
  if (over) return `: ${over[0]} is ${d[/** @type {keyof typeof DECISION_FIELD_MAX} */ (over[0])].length} chars, over the ${over[1]}-char ceiling`
  return anchorFieldProblem(o) || decisionAnchorProblem(d)
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
