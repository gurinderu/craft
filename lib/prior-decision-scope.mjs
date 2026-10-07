// The scope check of recalled prior decisions (lib/prior-decisions.mjs): which decisions need it, the
// one shell line per decision the scope-check agent runs — whether the decision's commit is known to
// this repo, and if so whether the code in its scope changed since — and the agent's answer read.
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

/**
 * The shell lines the scope check runs, one per decision: when the repo knows the decision's commit,
 * `git diff --quiet` against it, printing the id and the exit status (0 = unchanged since the commit,
 * working tree included); when it does not (a squash-merged branch, another clone), the id and
 * `missing`. Arguments single-quoted.
 * @param {PriorDecision[]} decisions @returns {string}
 */
export function scopeCheckScript(decisions) {
  /** @param {string} s */
  const q = s => `'${s.replace(/'/g, `'\\''`)}'`
  return decisions.map(d => `if git cat-file -e ${q(`${d.commit}^{commit}`)} 2>/dev/null; then git diff --quiet ${q(d.commit)} -- ${q(d.scope)}; echo ${q(d.id)} $?; else echo ${q(d.id)} missing; fi`).join('\n')
}

// What the scope-check agent returns: the ids it saw print status 0, and those it saw print `missing`.
export const SCOPE_CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['unchanged', 'missing', 'reason'],
  properties: {
    unchanged: { type: 'array', items: { type: 'string' }, description: 'ids whose line ended in exit status 0, exactly as printed' },
    missing: { type: 'array', items: { type: 'string' }, description: 'ids whose line ended in the word missing, exactly as printed' },
    reason: { type: 'string', description: 'one line: anything that did not run' },
  },
}

/** The scope-check agent's prompt. @param {PriorDecision[]} decisions @returns {string} */
export function scopeCheckPrompt(decisions) {
  return `Run these lines in the repository under review, exactly as written (shell only, read only). Each prints a decision id and the exit status of \`git diff --quiet\` against that decision's commit, or the word missing when the repository does not have that commit.
${scopeCheckScript(decisions)}
Return {unchanged: [every id whose printed status was 0], missing: [every id printed with the word missing], reason: one line on anything that did not run}.`
}

/**
 * The ids a scope-check answer names unchanged and missing, or null when the answer is absent or its
 * `unchanged` unreadable — then no decision is shown unchanged and nothing is set aside.
 * @param {unknown} ans @returns {{ unchanged: string[], missing: string[] } | null}
 */
export function readScopeCheck(ans) {
  const o = ans && typeof ans === 'object' ? /** @type {Record<string, unknown>} */ (ans) : {}
  /** @param {unknown} v */
  const ids = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
  return Array.isArray(o['unchanged']) ? { unchanged: ids(o['unchanged']), missing: ids(o['missing']) } : null
}

/**
 * Runs the scope check for `toCheck` (never with none; a commit-based check, an unknown commit raises
 * the finding and is reported — realm @nick/craft, node #184): the ids observed unchanged, and those whose
 * commit the repo does not know. A dead or unreadable answer shows nothing unchanged (said in `notes`).
 * @param {PriorDecision[]} toCheck @param {(toCheck: PriorDecision[]) => Promise<unknown>} checkScopes @param {string[]} notes
 * @returns {Promise<{ toCheck: PriorDecision[], unchanged: Set<string>, missing: Set<string> }>}
 */
export async function runScopeCheck(toCheck, checkScopes, notes) {
  const unchanged = new Set(/** @type {string[]} */ ([]))
  const missing = new Set(/** @type {string[]} */ ([]))
  if (!toCheck.length) return { toCheck, unchanged, missing }
  const ids = readScopeCheck(await checkScopes(toCheck))
  if (ids == null) notes.push(`the scope-check agent died or answered unreadably — no decision could be shown unchanged, so the ${toCheck.length} decision(s) set nothing aside`)
  // An id outside `toCheck` sets nothing aside: splitByDecisions only consults decisions that answer
  // a finding below Critical/High and carry a commit, which is exactly what was checked.
  for (const id of ids?.unchanged || []) unchanged.add(id)
  for (const d of toCheck) if (ids?.missing.includes(d.id)) missing.add(d.id)
  return { toCheck, unchanged, missing }
}
