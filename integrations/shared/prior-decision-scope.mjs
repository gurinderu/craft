// The scope check of recalled prior decisions (integrations/shared/prior-decisions.mjs): which decisions need it, the
// one shell line per decision the scope-check agent runs — whether the decision's commit is known to
// this repo (for a decision dated but naming no commit, whether a commit precedes its date), and if so
// whether the code in its scope changed since — and the agent's answer read.
// Imported by integrations/claude-code/src/triage-findings.js.
import { reraisedByRank } from './prior-decisions.mjs'
import { decisionDate, hasAnchor } from './prior-decision-anchor.mjs'
import { findingPlan, sureMatchOf, triedOrder } from './prior-decision-match.mjs'

/**
 * @typedef {import('./prior-decisions.mjs').PriorDecision} PriorDecision
 * @typedef {import('./prior-decisions.mjs').DecidableFinding} DecidableFinding
 * @typedef {import('./prior-decision-match.mjs').PriorMatch} PriorMatch
 */

/**
 * The decisions whose scope must be checked for change: those that answer some finding a decision
 * could set aside (not one its severity raises again: a Critical, a High no human's decision answers) and that recorded a commit or a date to compare against. `matchOf` is the
 * match the split runs on (integrations/shared/prior-decision-match.mjs); by default, the sure matches alone.
 * @param {DecidableFinding[]} findings @param {PriorDecision[]} decisions
 * @param {(f: DecidableFinding) => PriorMatch | undefined} [matchOf] @returns {PriorDecision[]}
 */
export function decisionsToCheck(findings, decisions, matchOf = sureMatchOf(decisions)) {
  const out = new Set(/** @type {PriorDecision[]} */ ([]))
  for (const f of findings) {
    const d = matchOf(f)?.d
    if (d && hasAnchor(d) && !reraisedByRank(f.severity, d)) out.add(d)
  }
  return [...out]
}

/**
 * Every decision that could answer some finding a decision could set aside — a sure match or a candidate
 * for the judge — and that recorded a commit or a date: checked once BEFORE the judge, so the one judge call can also
 * ask whether a sure match re-raised for a changed scope shows the code going against its record (realm
 * @nick/craft, node #282). A superset of decisionsToCheck under any match.
 * @param {DecidableFinding[]} findings @param {PriorDecision[]} decisions @returns {PriorDecision[]}
 */
export function candidatesToCheck(findings, decisions) {
  const ordered = triedOrder(decisions)
  const out = new Set(/** @type {PriorDecision[]} */ ([]))
  for (const f of findings) {
    const plan = findingPlan(f, ordered)
    for (const d of plan.sure ? [...plan.disputed, plan.sure.d] : plan.disputed) if (hasAnchor(d) && !reraisedByRank(f.severity, d)) out.add(d)
  }
  return [...out]
}

/**
 * The shell lines the scope check runs, one per decision: when the repo knows the decision's commit,
 * `git diff --quiet` against it, printing the id and the exit status (0 = unchanged since the commit,
 * working tree included); when it does not (a squash-merged branch, another clone), the id and
 * `missing`. A decision naming no commit but a date is compared the same way against the last commit
 * before that day began anywhere (00:00 at +14:00) on the first-parent line of the trunk's tip — not
 * over HEAD's history nor from where HEAD forks from the trunk, where a branch's backdated commit, or a
 * side branch's commit dated before the day but merged after it, would be the base and hide a later
 * change of the scope; diffed against the working tree, the change's own edits and any trunk commit the
 * checkout lacks count as after the record (realm @nick/craft, node #676) — printing `future` for a date
 * later than today in UTC, `no-trunk` when no trunk resolves (origin/HEAD when it names a commit, else
 * origin/main, else origin/master), `unreadable` when git fails listing the trunk, and `missing` when the
 * trunk holds no commit before the day. Each line resolves the trunk itself, so it stands alone for the
 * agent that runs it. Arguments single-quoted.
 * @param {PriorDecision[]} decisions @returns {string}
 */
export function scopeCheckScript(decisions) {
  /** @param {string} s */
  const q = s => `'${s.replace(/'/g, `'\\''`)}'`
  /** @param {PriorDecision} d */
  const dated = d => {
    const [day, id] = [decisionDate(d), q(d.id)]
    return (
      `if [ ${q(day.replace(/-/g, ''))} -gt "$(date -u +%F | tr -d -)" ]; then echo ${id} future; ` +
      `elif ! t=$(for r in "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do [ -n "$r" ] && git rev-parse -q --verify "$r^{commit}" >/dev/null && echo "$r" && break; done | grep .); then echo ${id} no-trunk; ` +
      `elif ! b=$(git rev-list -1 --first-parent ${q(`--before=${day} 00:00:00 +1400`)} "$t" 2>/dev/null); then echo ${id} unreadable; ` +
      `elif [ -n "$b" ]; then git diff --quiet "$b" -- ${q(d.scope)}; echo ${id} $?; else echo ${id} missing; fi`
    )
  }
  /** @param {PriorDecision} d */
  const line = d =>
    d.commit
      ? `if git cat-file -e ${q(`${d.commit}^{commit}`)} 2>/dev/null; then git diff --quiet ${q(d.commit)} -- ${q(d.scope)}; echo ${q(d.id)} $?; else echo ${q(d.id)} missing; fi`
      : dated(d)
  return decisions.map(line).join('\n')
}

// The words a scope-check line prints, after the id, for a decision whose anchor names no commit to compare.
const UNUSABLE_WORDS = ['future', 'no-trunk', 'unreadable']

// What the scope-check agent returns: the ids it saw print status 0, those it saw print `missing`, and
// those it saw print another word in place of a status.
export const SCOPE_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['unchanged', 'missing', 'unusable', 'reason'],
  properties: {
    unchanged: { type: 'array', items: { type: 'string' }, description: 'ids whose line ended in exit status 0, exactly as printed' },
    missing: { type: 'array', items: { type: 'string' }, description: 'ids whose line ended in the word missing, exactly as printed' },
    unusable: {
      type: 'array',
      description: 'ids whose line ended in the word future, no-trunk or unreadable, each with that word',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'word'],
        properties: { id: { type: 'string' }, word: { type: 'string', enum: UNUSABLE_WORDS } },
      },
    },
    reason: { type: 'string', description: 'one line: anything that did not run' },
  },
}

/** The scope-check agent's prompt. @param {PriorDecision[]} decisions @returns {string} */
export function scopeCheckPrompt(decisions) {
  return `Run these lines in the repository under review, exactly as written (shell only, read only). Each prints a decision id and the exit status of \`git diff --quiet\` against that decision's commit (or, for a decision naming only a date, the trunk's last commit before that date), or the word missing when the repository does not have that commit — or, for a date, future, no-trunk or unreadable when it cannot be compared.
${scopeCheckScript(decisions)}
Return {unchanged: [every id whose printed status was 0], missing: [every id printed with the word missing], unusable: [{id, word} for every id printed with the word future, no-trunk or unreadable], reason: one line on anything that did not run}.`
}

/**
 * The ids a scope-check answer names unchanged and missing, and the word it names each unusable one by,
 * or null when the answer is absent or its `unchanged` unreadable — then no decision is shown unchanged
 * and nothing is set aside. An answer without `unusable`, which the schema requires, names none unusable.
 * @param {unknown} ans @returns {{ unchanged: string[], missing: string[], unusable: Array<{ id: string, word: string }> } | null}
 */
export function readScopeCheck(ans) {
  const o = ans && typeof ans === 'object' ? /** @type {Record<string, unknown>} */ (ans) : {}
  /** @param {unknown} v */
  const ids = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
  /** @param {unknown} x @returns {x is { id: string, word: string }} */
  const named = x => {
    const e = x && typeof x === 'object' ? /** @type {Record<string, unknown>} */ (x) : {}
    return typeof e['id'] === 'string' && typeof e['word'] === 'string' && UNUSABLE_WORDS.includes(e['word'])
  }
  const unusable = (Array.isArray(o['unusable']) ? o['unusable'] : []).filter(named).map(e => ({ id: e.id, word: e.word }))
  return Array.isArray(o['unchanged']) ? { unchanged: ids(o['unchanged']), missing: ids(o['missing']), unusable } : null
}

/**
 * Runs the scope check for `toCheck` (never with none; an anchor naming no commit raises the finding and is
 * reported — realm @nick/craft, node #184): the ids observed unchanged since their commit or date, and those
 * whose anchor names no commit to compare, each with the word its line printed (`missing`, `future`,
 * `no-trunk`, `unreadable`). A dead or unreadable answer shows nothing unchanged (said in `notes`).
 * @param {PriorDecision[]} toCheck @param {(toCheck: PriorDecision[]) => Promise<unknown>} checkScopes @param {string[]} notes
 * @returns {Promise<{ toCheck: PriorDecision[], unchanged: Set<string>, missing: Map<string, string> }>}
 */
export async function runScopeCheck(toCheck, checkScopes, notes) {
  const unchanged = new Set(/** @type {string[]} */ ([]))
  const missing = new Map(/** @type {Array<[string, string]>} */ ([]))
  if (!toCheck.length) return { toCheck, unchanged, missing }
  const ids = readScopeCheck(await checkScopes(toCheck))
  if (ids == null)
    notes.push(
      `the scope-check agent died or answered unreadably — no decision could be shown unchanged, so the ${toCheck.length} decision(s) set nothing aside`,
    )
  // An id outside `toCheck` sets nothing aside: splitByDecisions only consults decisions that answer
  // a finding below Critical/High and carry a commit or a date, which is exactly what was checked.
  for (const id of ids?.unchanged || []) unchanged.add(id)
  if (ids) for (const d of toCheck) missingWord(d, ids, missing)
  return { toCheck, unchanged, missing }
}

/**
 * Notes in `missing` the word the answer `ids` gives decision `d` when its anchor names no commit to
 * compare: `missing`, or for a date another word its line printed.
 * @param {PriorDecision} d @param {NonNullable<ReturnType<typeof readScopeCheck>>} ids @param {Map<string, string>} missing
 */
function missingWord(d, ids, missing) {
  if (ids.missing.includes(d.id)) missing.set(d.id, 'missing')
  const said = d.commit ? undefined : ids.unusable.find(u => u.id === d.id)?.word
  if (said) missing.set(d.id, said)
}
