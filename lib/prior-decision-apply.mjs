// Applying recalled prior decisions (lib/prior-decisions.mjs reads and matches them) to an engine's
// findings, once their scopes are checked (lib/prior-decision-scope.mjs): the split of each tier into
// kept (raised, marked "rejected before" when a decision was overridden) and set aside (out of the
// verdict, marked with the decision), and the report sections of what was set aside. A `question`
// record (a deferred finding, realm @nick/craft, node #204) runs through the same split: only its mark,
// its label in a re-raise note and its section ("Known and deferred") differ, and the engine persists
// it as `deferred` instead of `rejected`.
// Inlined into src/review.js and src/adversarial-review.js after prior-decision-scope.mjs.
import { decisionAnswers, reraisedBySeverity } from './prior-decisions.mjs'
import { decisionsToCheck, runScopeCheck } from './prior-decision-scope.mjs'

/**
 * @typedef {import('./prior-decisions.mjs').PriorDecision} PriorDecision
 * @typedef {import('./prior-decisions.mjs').DecidableFinding} DecidableFinding
 */
/**
 * A finding set aside by a record: its tier, the record's id and kind.
 * @template F @typedef {F & { priorTier: string, priorDecision: string, priorKind: 'decision' | 'question' }} SetAside
 */

/** What a record is called in a note: `decision` or `question`. @param {PriorDecision} d @returns {string} */
export function priorKindLabel(d) {
  return d.kind === 'question' ? 'question' : 'decision'
}

/**
 * Whether a record is a deferral or a decision — the records a finding is matched against. A question is
 * a deferral only when it says so, `deferred: true` (addressing-findings writes it when the author
 * defers; the memory skill's record shape documents it). A question without it (a needs-decision
 * question) is context: its finding is raised normally, unlabelled.
 * @param {PriorDecision} d
 */
export function matchesFindings(d) {
  return d.kind !== 'question' || d.deferred
}

/**
 * Whether a record can set a finding aside: every decision; a question only when it records a deferral
 * (`deferred: true`) AND a commit, which the scope check compares against. A deferral without a commit
 * is still matched (matchesFindings) so its finding is raised again and named, never silently.
 * @param {PriorDecision} d
 */
export function recordsDeferral(d) {
  return d.kind !== 'question' || (d.deferred && !!d.commit)
}

/** The question id the KNOWN AND DEFERRED mark on a carried row names; '' when it names none. @param {unknown} why */
export function deferredQuestionId(why) {
  const all = [...String(why ?? '').matchAll(/\(question ([^\s)]+)\)/g)]
  const last = all[all.length - 1]
  return last ? String(last[1]) : ''
}

/**
 * Whether a carried deferred prior's question no longer holds: a record in hand (recalled or passed)
 * names it in a `supersedes:` / `answers:` link — the memory skill's own way to close a question. The
 * question's ABSENCE never releases it (realm @nick/craft, node #204): absence has benign causes — a
 * launcher forwarding decisions only, a recall answer without its optional `questions` list, a recall
 * from another backend than the one the deferral was written to. A row whose mark names no question
 * is left as it is.
 * @param {unknown} why @param {PriorDecision[]} records
 */
export function deferralReleased(why, records) {
  const id = deferredQuestionId(why)
  return !!id && records.some(d => d.supersedes.includes(id))
}

/** The mark a set-aside finding carries. @param {PriorDecision} d */
export function priorDecisionMark(d) {
  const head = d.kind === 'question' ? 'KNOWN AND DEFERRED' : 'REJECTED BEFORE'
  return `${head}: ${d.reason} — ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}, ${d.link || 'no link'} (${priorKindLabel(d)} ${d.id})`
}

/** Why a decision did not apply when the repo does not know its commit (realm @nick/craft, node #184). @param {PriorDecision} d */
export function commitMissingReason(d) {
  return `commit ${d.commit} not found in this repo — raised normally`
}

/**
 * Why decision `d` cannot set finding `f` aside; '' when it can. `missing`: ids whose commit the repo
 * does not know (a squash-merged branch, another clone) — named apart from a changed scope.
 * @param {DecidableFinding} f @param {PriorDecision} d @param {Set<string>} unchanged @param {Set<string>} [missing] @returns {string}
 */
export function reraiseReason(f, d, unchanged, missing = new Set()) {
  if (reraisedBySeverity(f.severity)) return `a Critical/High finding is never set aside by a prior ${d.kind === 'question' ? 'deferred question' : 'decision'}`
  if (!d.commit) return `the ${priorKindLabel(d)} records no commit, so an unchanged scope cannot be established`
  if (missing.has(d.id)) return commitMissingReason(d)
  if (!unchanged.has(d.id)) return `the code in ${d.scope} changed since ${d.commit} (or that could not be checked)`
  return ''
}

/** The note a finding raised again despite record `d` carries. @param {PriorDecision} d @param {string} why */
export function reraisedNote(d, why) {
  const before = d.kind === 'question' ? 'Deferred before' : 'Rejected before'
  return `${before} (${priorKindLabel(d)} ${d.id}, ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}) — raised again: ${why}.`
}

/**
 * Split one tier's findings by the decisions. `unchanged` holds the ids of decisions whose scope was
 * observed unchanged since their commit; every other decision cannot set a finding aside. The mark
 * is appended to `noteField` — `why` in review, `description` in adversarial-review.
 * @template {DecidableFinding} F
 * @param {F[]} findings @param {PriorDecision[]} decisions @param {Set<string>} unchanged @param {string} tier @param {string} [noteField]
 * @param {Set<string>} [missing]  ids whose commit the repo does not know
 * @returns {{ kept: F[], setAside: Array<SetAside<F>>, reraised: number }}
 */
export function splitByDecisions(findings, decisions, unchanged, tier, noteField = 'why', missing = new Set()) {
  /** @type {F[]} */
  const kept = []
  /** @type {Array<SetAside<F>>} */
  const setAside = []
  let reraised = 0
  for (const f of findings) {
    const d = decisions.find(x => decisionAnswers(f, x))
    if (!d) { kept.push(f); continue }
    const why = reraiseReason(f, d, unchanged, missing)
    const note = `${String(f[noteField] ?? '')} · `
    if (!why) { setAside.push({ ...f, priorTier: String(f.tier || tier), priorDecision: d.id, priorKind: d.kind, [noteField]: note + priorDecisionMark(d) }); continue }
    reraised++
    kept.push({ ...f, [noteField]: note + reraisedNote(d, why) })
  }
  return { kept, setAside, reraised }
}

/**
 * The report sections listing the findings set aside, each with its mark: those a decision answers
 * under Rejected before, those a deferred question answers under Known and deferred.
 * @param {Array<DecidableFinding & { priorKind?: string }>} setAside @returns {string}
 */
export function priorRejectedSection(setAside) {
  /** @param {DecidableFinding} f */
  const setAsideLine = f => `- ${String(f.severity ?? '?')} · \`${String(f.file || '?')}:${String(f['line'] || 0)}\` · ${String(f.title ?? '')} · ${String(f.why ?? '')}`
  const rejected = setAside.filter(f => f.priorKind !== 'question')
  const deferred = setAside.filter(f => f.priorKind === 'question')
  return (rejected.length ? `\n\n## Rejected before (set aside — not in the verdict)\n${rejected.map(setAsideLine).join('\n')}` : '')
    + (deferred.length ? `\n\n## Known and deferred (open question — not in the verdict)\n${deferred.map(setAsideLine).join('\n')}` : '')
}

/**
 * Applies the decisions to every tier of an engine's findings. `checkScopes` runs the scope check for
 * the decisions it is handed (never called with none) and returns the agent's raw answer. `refused`:
 * the decisions whose commit the repo does not know, for the report's Prior decisions not applied.
 * @template {DecidableFinding} F
 * @param {Record<string, F[]>} tiers @param {PriorDecision[]} given  questions that record no deferral are dropped (matchesFindings)
 * @param {(toCheck: PriorDecision[]) => Promise<unknown>} checkScopes @param {string} [noteField]
 * @returns {Promise<{ tiers: Record<string, F[]>, setAside: Array<SetAside<F>>, reraised: number, notes: string[], refused: string[] }>}
 */
export async function applyPriorDecisions(tiers, given, checkScopes, noteField = 'why') {
  /** @type {Array<SetAside<F>>} */
  let setAside = []
  /** @type {string[]} */
  const notes = []
  const context = given.length - given.filter(matchesFindings).length
  if (context) notes.push(`${context} open question(s) record no deferral — context only, set nothing aside`)
  // A record another given record supersedes or answers no longer applies, even when it was handed in.
  const replaced = new Set(given.flatMap(d => d.supersedes))
  const superseded = given.filter(d => matchesFindings(d) && replaced.has(d.id))
  if (superseded.length) notes.push(`${superseded.length} record(s) superseded by another given record — not applied: ${superseded.map(d => d.id).join(', ')}`)
  const decisions = given.filter(d => matchesFindings(d) && !replaced.has(d.id))
  if (!decisions.length) return { tiers, setAside, reraised: 0, notes, refused: [] }
  const { toCheck, unchanged, missing } = await runScopeCheck(decisionsToCheck(Object.values(tiers).flat(), decisions), checkScopes, notes)
  const refused = decisions.filter(d => !recordsDeferral(d)).map(d => `question ${d.id}: records a deferral but no commit, so an unchanged scope cannot be established — raised normally`)
    .concat(toCheck.filter(d => missing.has(d.id)).map(d => `${priorKindLabel(d)} ${d.id}: ${commitMissingReason(d)}`))
  let reraised = 0
  /** @type {Record<string, F[]>} */
  const out = {}
  for (const [tier, list] of Object.entries(tiers)) {
    const r = splitByDecisions(list, decisions, unchanged, tier, noteField, missing)
    out[tier] = r.kept
    setAside = setAside.concat(r.setAside)
    reraised += r.reraised
  }
  const questions = decisions.filter(d => d.kind === 'question').length
  const deferred = setAside.filter(f => f.priorKind === 'question').length
  notes.push(`${decisions.length - questions} decision(s) given, ${setAside.length - deferred} finding(s) set aside as rejected before, ${reraised} raised again`
    + (questions ? `; ${questions} deferred question(s) given, ${deferred} finding(s) set aside as known and deferred` : ''))
  return { tiers: out, setAside, reraised, notes, refused }
}
