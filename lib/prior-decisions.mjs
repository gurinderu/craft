// Prior decisions on findings, handed to the review engine by the session that launched it: the
// project's recorded rejections ("not a bug here, because …"), recalled from whatever memory the
// project keeps (the `memory` skill) for the paths of the diff. The engine never drops a finding a
// decision answers — it sets it aside under its own section, marked with who rejected it, when, why
// and where. A finding is raised again normally when it is Critical or High, when the code in the
// decision's scope changed since the commit the decision was recorded at, or when that cannot be
// established. An absent or malformed argument changes nothing. Inlined into workflows/review.js
// (no imports: the sandbox has no module system).

// The most decisions one run applies; the rest are refused by name and their findings raised normally.
export const PRIOR_DECISIONS_MAX = 100
// Per-field ceilings. A field over its ceiling refuses the whole decision (said so) — a reason cut
// mid-sentence would mark a finding with a rationale nobody wrote.
export const DECISION_FIELD_MAX = { id: 80, title: 200, scope: 300, reason: 1200, who: 120, when: 40, link: 500 }
// A decision answers a finding when the finding's file sits inside the decision's scope AND their
// titles share at least this share of words (of the longer one).
export const DECISION_TITLE_OVERLAP = 0.6

/**
 * @typedef {{ id: string, title: string, scope: string, reason: string, who: string, when: string, link: string, commit: string }} PriorDecision
 * @typedef {{ file?: unknown, title?: unknown, severity?: unknown, why?: unknown, tier?: unknown, [k: string]: unknown }} DecidableFinding
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
 * The decision's fields as strings, trimmed; `body` and `date` (the memory record's names) stand in
 * for `reason` and `when`.
 * @param {Record<string, unknown>} o @returns {PriorDecision}
 */
export function decisionFields(o) {
  /** @param {string} k @param {string} [alt] */
  const f = (k, alt = '') => decisionText(o[k]) || decisionText(o[alt])
  return { id: f('id'), title: f('title'), scope: f('scope') || '.', reason: f('reason', 'body'), who: f('who'), when: f('when', 'date'), link: f('link'), commit: f('commit') }
}

/**
 * What is wrong with a decision, as the tail of a refusal sentence; '' when nothing is.
 * @param {Record<string, unknown>} o @param {PriorDecision} d @returns {string}
 */
export function decisionProblem(o, d) {
  if (o['status'] != null && decisionText(o['status']) !== 'active') return ` is not active (status ${JSON.stringify(o['status'])})`
  if (!d.id || !d.title || !d.reason) return ' lacks an id, a title or a reason'
  const over = Object.entries(DECISION_FIELD_MAX).find(([k, max]) => d[/** @type {keyof PriorDecision} */ (k)].length > max)
  if (over) return `: ${over[0]} is ${d[/** @type {keyof PriorDecision} */ (over[0])].length} chars, over the ${over[1]}-char ceiling`
  return decisionAnchorProblem(d)
}

/**
 * The scope and the commit go into a shell line (scopeCheckScript): a repo-relative path and a hash
 * only. '' when both are.
 * @param {PriorDecision} d @returns {string}
 */
export function decisionAnchorProblem(d) {
  if (/^([\\/]|~|[A-Za-z]:)/.test(d.scope) || decisionScopeParts(d.scope).includes('..')) return `: scope ${JSON.stringify(d.scope)} is not a repo-relative path`
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
  return problem ? `decision #${i}${d.id ? ` (${d.id})` : ''}${problem}` : d
}

/**
 * The `priorDecisions` argument, checked. Absent → nothing, silently: that is every run before this
 * existed. Anything else that is not a list of decisions → nothing applied, each problem named.
 * @param {unknown} raw
 * @returns {{ decisions: PriorDecision[], refused: string[] }}
 */
export function parsePriorDecisions(raw) {
  if (raw == null || raw === '') return { decisions: [], refused: [] }
  let list = raw
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw) } catch { return { decisions: [], refused: ['priorDecisions is a string that is not JSON — no decision applied'] } }
  }
  if (!Array.isArray(list)) return { decisions: [], refused: ['priorDecisions is not a list — no decision applied'] }
  /** @type {PriorDecision[]} */
  const decisions = []
  /** @type {string[]} */
  const refused = []
  list.slice(0, PRIOR_DECISIONS_MAX).forEach((item, i) => {
    const d = readPriorDecision(item, i)
    if (typeof d === 'string') refused.push(d)
    // The scope check answers by id: two decisions under one id could lend one's unchanged scope to
    // the other, so the second is refused.
    else if (decisions.some(x => x.id === d.id)) refused.push(`decision #${i} (${d.id}) repeats an id already given — not applied`)
    else decisions.push(d)
  })
  if (list.length > PRIOR_DECISIONS_MAX) {
    refused.push(`${list.length - PRIOR_DECISIONS_MAX} decision(s) past the cap of ${PRIOR_DECISIONS_MAX} were not applied — findings they would answer are raised normally`)
  }
  return { decisions, refused }
}

/** Lower-cased alphanumeric words of a title. @param {unknown} t */
export function titleWords(t) {
  return new Set(String(t ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
}

/**
 * Whether `d` answers finding `f`: the file inside the scope, and the titles overlapping enough.
 * @param {DecidableFinding} f @param {PriorDecision} d @returns {boolean}
 */
export function decisionAnswers(f, d) {
  const file = decisionScopeParts(String(f.file ?? ''))
  const scope = decisionScopeParts(d.scope)
  if (!file.length || scope.length > file.length || scope.some((s, i) => s !== file[i])) return false
  const a = titleWords(f.title)
  const b = titleWords(d.title)
  if (!a.size || !b.size) return false
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.max(a.size, b.size) >= DECISION_TITLE_OVERLAP
}

/** @param {unknown} sev */
export function reraisedBySeverity(sev) {
  return /^(critical|high)$/i.test(String(sev ?? '').trim())
}

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
 * The report section naming what of `priorDecisions` was not applied; empty when everything was.
 * @param {string[]} refused @returns {string}
 */
export function priorDecisionsRefusedSection(refused) {
  if (!refused.length) return ''
  return `\n\n## Prior decisions not applied\n${refused.map(r => `- ⚠️ ${r}`).join('\n')}\n`
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
