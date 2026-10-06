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
const COMMIT = /^[0-9a-f]{7,40}$/i

/**
 * @typedef {{ id: string, title: string, scope: string, reason: string, who: string, when: string, link: string, commit: string }} PriorDecision
 * @typedef {{ file?: unknown, title?: unknown, severity?: unknown, why?: unknown, tier?: unknown, [k: string]: unknown }} DecidableFinding
 */

/** Path segments with `.`, empty segments and separators folded; `..` kept literal. @param {string} p */
function scopeParts(p) {
  return p.split(/[\\/]+/).filter(s => s && s !== '.')
}

/** @param {unknown} v @returns {string} */
const text = v => (typeof v === 'string' ? v.trim() : '')

/**
 * One decision as given, checked: a refusal sentence, or the decision.
 * @param {unknown} raw @param {number} i @returns {PriorDecision | string}
 */
function readDecision(raw, i) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `decision #${i} is not an object`
  const o = /** @type {Record<string, unknown>} */ (raw)
  const d = { id: text(o['id']), title: text(o['title']), scope: text(o['scope']) || '.', reason: text(o['reason'] ?? o['body']), who: text(o['who']), when: text(o['when'] ?? o['date']), link: text(o['link']), commit: text(o['commit']) }
  const label = `decision #${i}${d.id ? ` (${d.id})` : ''}`
  if (o['status'] != null && text(o['status']) !== 'active') return `${label} is not active (status ${JSON.stringify(o['status'])})`
  if (!d.id || !d.title || !d.reason) return `${label} lacks an id, a title or a reason`
  for (const [k, max] of Object.entries(DECISION_FIELD_MAX)) {
    const len = d[/** @type {keyof PriorDecision} */ (k)].length
    if (len > max) return `${label}: ${k} is ${len} chars, over the ${max}-char ceiling`
  }
  if (/^([\\/]|~|[A-Za-z]:)/.test(d.scope) || scopeParts(d.scope).includes('..')) return `${label}: scope ${JSON.stringify(d.scope)} is not a repo-relative path`
  if (d.commit && !COMMIT.test(d.commit)) return `${label}: commit ${JSON.stringify(d.commit)} is not a commit hash`
  return d
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
    const d = readDecision(item, i)
    if (typeof d === 'string') refused.push(d)
    else decisions.push(d)
  })
  if (list.length > PRIOR_DECISIONS_MAX) {
    refused.push(`${list.length - PRIOR_DECISIONS_MAX} decision(s) past the cap of ${PRIOR_DECISIONS_MAX} were not applied — findings they would answer are raised normally`)
  }
  return { decisions, refused }
}

/** Lower-cased alphanumeric words of a title. @param {unknown} t */
function words(t) {
  return new Set(String(t ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
}

/**
 * Whether `d` answers finding `f`: the file inside the scope, and the titles overlapping enough.
 * @param {DecidableFinding} f @param {PriorDecision} d @returns {boolean}
 */
export function decisionAnswers(f, d) {
  const file = scopeParts(String(f.file ?? ''))
  const scope = scopeParts(d.scope)
  if (!file.length || scope.length > file.length || scope.some((s, i) => s !== file[i])) return false
  const a = words(f.title)
  const b = words(d.title)
  if (!a.size || !b.size) return false
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.max(a.size, b.size) >= DECISION_TITLE_OVERLAP
}

/** @param {unknown} sev */
const reraisedBySeverity = sev => /^(critical|high)$/i.test(String(sev ?? '').trim())

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
 * Split one tier's findings by the decisions. `unchanged` holds the ids of decisions whose scope was
 * observed unchanged since their commit; every other decision cannot set a finding aside.
 * @template {DecidableFinding} F
 * @param {F[]} findings @param {PriorDecision[]} decisions @param {Set<string>} unchanged @param {string} tier
 * @returns {{ kept: F[], setAside: Array<F & { priorTier: string, priorDecision: string }>, reraised: number }}
 */
export function splitByDecisions(findings, decisions, unchanged, tier) {
  /** @type {F[]} */
  const kept = []
  /** @type {Array<F & { priorTier: string, priorDecision: string }>} */
  const setAside = []
  let reraised = 0
  for (const f of findings) {
    const d = decisions.find(x => decisionAnswers(f, x))
    if (!d) { kept.push(f); continue }
    const why = reraisedBySeverity(f.severity)
      ? 'a Critical/High finding is never set aside by a prior decision'
      : !d.commit ? 'the decision records no commit, so an unchanged scope cannot be established'
      : !unchanged.has(d.id) ? `the code in ${d.scope} changed since ${d.commit} (or that could not be checked)`
      : ''
    if (!why) { setAside.push({ ...f, priorTier: String(f.tier || tier), priorDecision: d.id, why: `${String(f.why ?? '')} · ${priorDecisionMark(d)}` }); continue }
    reraised++
    kept.push({ ...f, why: `${String(f.why ?? '')} · Rejected before (decision ${d.id}, ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}) — raised again: ${why}.` })
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
