// Applying recalled prior decisions (lib/prior-decisions.mjs reads and matches them) to an engine's
// findings, once their scopes are checked (lib/prior-decision-scope.mjs): the split of each tier into
// kept (raised, marked "rejected before" when a decision was overridden) and set aside (out of the
// verdict, marked with the decision), and the report section of what was set aside.
// Inlined into workflows/review.js and workflows/adversarial-review.js after prior-decision-scope.mjs.
import { decisionAnswers, reraisedBySeverity } from './prior-decisions.mjs'
import { decisionsToCheck, runScopeCheck } from './prior-decision-scope.mjs'

/**
 * @typedef {import('./prior-decisions.mjs').PriorDecision} PriorDecision
 * @typedef {import('./prior-decisions.mjs').DecidableFinding} DecidableFinding
 */

/** The mark a set-aside finding carries. @param {PriorDecision} d */
export function priorDecisionMark(d) {
  return `REJECTED BEFORE: ${d.reason} — ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}, ${d.link || 'no link'} (decision ${d.id})`
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
  if (reraisedBySeverity(f.severity)) return 'a Critical/High finding is never set aside by a prior decision'
  if (!d.commit) return 'the decision records no commit, so an unchanged scope cannot be established'
  if (missing.has(d.id)) return commitMissingReason(d)
  if (!unchanged.has(d.id)) return `the code in ${d.scope} changed since ${d.commit} (or that could not be checked)`
  return ''
}

/**
 * Split one tier's findings by the decisions. `unchanged` holds the ids of decisions whose scope was
 * observed unchanged since their commit; every other decision cannot set a finding aside. The mark
 * is appended to `noteField` — `why` in review, `description` in adversarial-review.
 * @template {DecidableFinding} F
 * @param {F[]} findings @param {PriorDecision[]} decisions @param {Set<string>} unchanged @param {string} tier @param {string} [noteField]
 * @param {Set<string>} [missing]  ids whose commit the repo does not know
 * @returns {{ kept: F[], setAside: Array<F & { priorTier: string, priorDecision: string }>, reraised: number }}
 */
export function splitByDecisions(findings, decisions, unchanged, tier, noteField = 'why', missing = new Set()) {
  /** @type {F[]} */
  const kept = []
  /** @type {Array<F & { priorTier: string, priorDecision: string }>} */
  const setAside = []
  let reraised = 0
  for (const f of findings) {
    const d = decisions.find(x => decisionAnswers(f, x))
    if (!d) { kept.push(f); continue }
    const why = reraiseReason(f, d, unchanged, missing)
    const note = `${String(f[noteField] ?? '')} · `
    if (!why) { setAside.push({ ...f, priorTier: String(f.tier || tier), priorDecision: d.id, [noteField]: note + priorDecisionMark(d) }); continue }
    reraised++
    kept.push({ ...f, [noteField]: `${note}Rejected before (decision ${d.id}, ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}) — raised again: ${why}.` })
  }
  return { kept, setAside, reraised }
}

/**
 * The report section listing the findings set aside by a prior decision, each with its mark.
 * @param {DecidableFinding[]} setAside @returns {string}
 */
export function priorRejectedSection(setAside) {
  if (!setAside.length) return ''
  return `\n\n## Rejected before (set aside — not in the verdict)\n`
    + setAside.map(f => `- ${String(f.severity ?? '?')} · \`${String(f.file || '?')}:${String(f['line'] || 0)}\` · ${String(f.title ?? '')} · ${String(f.why ?? '')}`).join('\n')
}

/**
 * Applies the decisions to every tier of an engine's findings. `checkScopes` runs the scope check for
 * the decisions it is handed (never called with none) and returns the agent's raw answer. `refused`:
 * the decisions whose commit the repo does not know, for the report's Prior decisions not applied.
 * @template {DecidableFinding} F
 * @param {Record<string, F[]>} tiers @param {PriorDecision[]} decisions
 * @param {(toCheck: PriorDecision[]) => Promise<unknown>} checkScopes @param {string} [noteField]
 * @returns {Promise<{ tiers: Record<string, F[]>, setAside: Array<F & { priorTier: string, priorDecision: string }>, reraised: number, notes: string[], refused: string[] }>}
 */
export async function applyPriorDecisions(tiers, decisions, checkScopes, noteField = 'why') {
  /** @type {Array<F & { priorTier: string, priorDecision: string }>} */
  let setAside = []
  /** @type {string[]} */
  const notes = []
  if (!decisions.length) return { tiers, setAside, reraised: 0, notes, refused: [] }
  const { toCheck, unchanged, missing } = await runScopeCheck(decisionsToCheck(Object.values(tiers).flat(), decisions), checkScopes, notes)
  const refused = toCheck.filter(d => missing.has(d.id)).map(d => `decision ${d.id}: ${commitMissingReason(d)}`)
  let reraised = 0
  /** @type {Record<string, F[]>} */
  const out = {}
  for (const [tier, list] of Object.entries(tiers)) {
    const r = splitByDecisions(list, decisions, unchanged, tier, noteField, missing)
    out[tier] = r.kept
    setAside = setAside.concat(r.setAside)
    reraised += r.reraised
  }
  notes.push(`${decisions.length} decision(s) given, ${setAside.length} finding(s) set aside as rejected before, ${reraised} raised again`)
  return { tiers: out, setAside, reraised, notes, refused }
}
