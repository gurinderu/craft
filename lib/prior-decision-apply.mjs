// Applying recalled prior decisions (lib/prior-decisions.mjs reads and matches them) to an engine's
// findings: which decisions need their scope checked, the one `git diff --quiet` line per decision
// the scope-check agent runs, and the split of each tier into kept (raised, marked "rejected before"
// when a decision was overridden) and set aside (out of the verdict, marked with the decision).
// Inlined into workflows/review.js and workflows/adversarial-review.js after prior-decisions.mjs.
import { decisionAnswers, reraisedBySeverity } from './prior-decisions.mjs'

/**
 * @typedef {import('./prior-decisions.mjs').PriorDecision} PriorDecision
 * @typedef {import('./prior-decisions.mjs').DecidableFinding} DecidableFinding
 */

/**
 * The decisions whose scope must be checked for change: those that answer some finding a decision
 * could set aside (not Critical/High) and that recorded a commit to compare against.
 * @param {DecidableFinding[]} findings @param {PriorDecision[]} decisions @returns {PriorDecision[]}
 */
export function decisionsToCheck(findings, decisions) {
  const out = new Set(/** @type {PriorDecision[]} */ ([]))
  for (const f of findings) {
    if (reraisedBySeverity(f.severity)) continue
    const d = decisions.find(x => decisionAnswers(f, x))
    if (d && d.commit) out.add(d)
  }
  return [...out]
}

/** The mark a set-aside finding carries. @param {PriorDecision} d */
export function priorDecisionMark(d) {
  return `REJECTED BEFORE: ${d.reason} — ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}, ${d.link || 'no link'} (decision ${d.id})`
}

/**
 * Why decision `d` cannot set finding `f` aside; '' when it can.
 * @param {DecidableFinding} f @param {PriorDecision} d @param {Set<string>} unchanged @returns {string}
 */
export function reraiseReason(f, d, unchanged) {
  if (reraisedBySeverity(f.severity)) return 'a Critical/High finding is never set aside by a prior decision'
  if (!d.commit) return 'the decision records no commit, so an unchanged scope cannot be established'
  if (!unchanged.has(d.id)) return `the code in ${d.scope} changed since ${d.commit} (or that could not be checked)`
  return ''
}

/**
 * Split one tier's findings by the decisions. `unchanged` holds the ids of decisions whose scope was
 * observed unchanged since their commit; every other decision cannot set a finding aside. The mark
 * is appended to `noteField` — `why` in review, `description` in adversarial-review.
 * @template {DecidableFinding} F
 * @param {F[]} findings @param {PriorDecision[]} decisions @param {Set<string>} unchanged @param {string} tier @param {string} [noteField]
 * @returns {{ kept: F[], setAside: Array<F & { priorTier: string, priorDecision: string }>, reraised: number }}
 */
export function splitByDecisions(findings, decisions, unchanged, tier, noteField = 'why') {
  /** @type {F[]} */
  const kept = []
  /** @type {Array<F & { priorTier: string, priorDecision: string }>} */
  const setAside = []
  let reraised = 0
  for (const f of findings) {
    const d = decisions.find(x => decisionAnswers(f, x))
    if (!d) { kept.push(f); continue }
    const why = reraiseReason(f, d, unchanged)
    const note = `${String(f[noteField] ?? '')} · `
    if (!why) { setAside.push({ ...f, priorTier: String(f.tier || tier), priorDecision: d.id, [noteField]: note + priorDecisionMark(d) }); continue }
    reraised++
    kept.push({ ...f, [noteField]: `${note}Rejected before (decision ${d.id}, ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}) — raised again: ${why}.` })
  }
  return { kept, setAside, reraised }
}

/**
 * The shell lines the scope check runs: one `git diff --quiet` per decision, printing its id and the
 * exit status (0 = unchanged since the commit, working tree included). Arguments single-quoted.
 * @param {PriorDecision[]} decisions @returns {string}
 */
export function scopeCheckScript(decisions) {
  /** @param {string} s */
  const q = s => `'${s.replace(/'/g, `'\\''`)}'`
  return decisions.map(d => `git diff --quiet ${q(d.commit)} -- ${q(d.scope)}; echo ${q(d.id)} $?`).join('\n')
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

// What the scope-check agent returns: the ids it saw print status 0.
export const SCOPE_CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['unchanged', 'reason'],
  properties: {
    unchanged: { type: 'array', items: { type: 'string' }, description: 'ids whose line ended in exit status 0, exactly as printed' },
    reason: { type: 'string', description: 'one line: anything that did not run' },
  },
}

/** The scope-check agent's prompt. @param {PriorDecision[]} decisions @returns {string} */
export function scopeCheckPrompt(decisions) {
  return `Run these lines in the repository under review, exactly as written (shell only, read only). Each prints a decision id and the exit status of \`git diff --quiet\` against that decision's commit.
${scopeCheckScript(decisions)}
Return {unchanged: [every id whose printed status was 0], reason: one line on anything that did not run}.`
}

/**
 * The ids a scope-check answer names unchanged, or null when the answer is missing or unreadable —
 * then no decision is shown unchanged and nothing is set aside.
 * @param {unknown} ans @returns {string[] | null}
 */
export function readScopeCheck(ans) {
  const u = ans && typeof ans === 'object' ? /** @type {Record<string, unknown>} */ (ans)['unchanged'] : null
  return Array.isArray(u) ? u.filter(x => typeof x === 'string') : null
}

/**
 * Applies the decisions to every tier of an engine's findings. `checkScopes` runs the scope check for
 * the decisions it is handed (never called with none) and returns the agent's raw answer.
 * @template {DecidableFinding} F
 * @param {Record<string, F[]>} tiers @param {PriorDecision[]} decisions
 * @param {(toCheck: PriorDecision[]) => Promise<unknown>} checkScopes @param {string} [noteField]
 * @returns {Promise<{ tiers: Record<string, F[]>, setAside: Array<F & { priorTier: string, priorDecision: string }>, reraised: number, notes: string[] }>}
 */
export async function applyPriorDecisions(tiers, decisions, checkScopes, noteField = 'why') {
  /** @type {Array<F & { priorTier: string, priorDecision: string }>} */
  let setAside = []
  /** @type {string[]} */
  const notes = []
  if (!decisions.length) return { tiers, setAside, reraised: 0, notes }
  const toCheck = decisionsToCheck(Object.values(tiers).flat(), decisions)
  const unchanged = new Set(/** @type {string[]} */ ([]))
  if (toCheck.length) {
    const ids = readScopeCheck(await checkScopes(toCheck))
    if (ids == null) notes.push(`the scope-check agent died or answered unreadably — no decision could be shown unchanged, so the ${toCheck.length} decision(s) set nothing aside`)
    // An id outside `toCheck` sets nothing aside: splitByDecisions only consults decisions that answer
    // a finding below Critical/High and carry a commit, which is exactly what was checked.
    for (const id of ids || []) unchanged.add(id)
  }
  let reraised = 0
  /** @type {Record<string, F[]>} */
  const out = {}
  for (const [tier, list] of Object.entries(tiers)) {
    const r = splitByDecisions(list, decisions, unchanged, tier, noteField)
    out[tier] = r.kept
    setAside = setAside.concat(r.setAside)
    reraised += r.reraised
  }
  notes.push(`${decisions.length} decision(s) given, ${setAside.length} finding(s) set aside as rejected before, ${reraised} raised again`)
  return { tiers: out, setAside, reraised, notes }
}
