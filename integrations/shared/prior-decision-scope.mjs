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

/** A shell word for `s`, single-quoted. @param {string} s */
const shellWord = s => `'${s.replace(/'/g, `'\\''`)}'`

// The trunk, as each line resolves it: origin/HEAD when it names a commit, else origin/main, else origin/master;
// the command substitution fails when none does.
const TRUNK = `$(for r in "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do [ -n "$r" ] && git rev-parse -q --verify "$r^{commit}" >/dev/null && echo "$r" && break; done | grep .)`

// The URL prefixes under which origin names a GitHub repository, `.git` after it or not.
const ORIGIN_FORMS = ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/']

/**
 * The line of a decision naming no commit but a date: compared against the trunk's last commit before that day.
 * @param {PriorDecision} d @param {string} day @returns {string}
 */
function datedLine(d, day) {
  const id = shellWord(d.id)
  return (
    `if [ ${shellWord(day.replace(/-/g, ''))} -gt "$(date -u +%F | tr -d -)" ]; then echo ${id} future; ` +
    `elif ! t=${TRUNK}; then echo ${id} no-trunk; ` +
    `elif ! b=$(git rev-list -1 --first-parent ${shellWord(`--before=${day} 00:00:00 +1400`)} "$t" 2>/dev/null); then echo ${id} unreadable; ` +
    `elif [ -n "$b" ]; then git diff --quiet "$b" -- ${shellWord(d.scope)}; echo ${id} $?; else echo ${id} missing; fi`
  )
}

/**
 * The line of a decision naming no commit but pull requests (realm @nick/craft, node #682): `n` is the number of
 * the first whose repository origin names, lower-cased; its merge `m` on the trunk tip's first-parent line
 * the newest commit whose subject is GitHub's `Merge pull request #<n> from …`, else the oldest whose subject
 * ends `(#<n>)` — the squash itself, not a later commit citing the request. Found, the
 * scope is diffed against it and the line says `merge <n>` after the status; not, the date's line runs, or
 * with no date the line prints `unmerged`.
 * @param {PriorDecision} d @param {import('./prior-decision-record.mjs').Pull[]} pulls @param {string} day @returns {string}
 */
function mergeLine(d, pulls, day) {
  /** @param {import('./prior-decision-record.mjs').Pull} p */
  const forms = p => ORIGIN_FORMS.flatMap(f => [`${f}${shellWord(p.repo)}`, `${f}${shellWord(p.repo)}.git`]).join('|')
  const pick = pulls.map(p => `${forms(p)}) n=${String(p.number)};;`).join(' ')
  const pickMerge =
    `'{ s = substr($0, index($0, " ") + 1) } m == "" && index(s, "Merge pull request #" n " from ") == 1 { m = $1; next } ` +
    `s ~ ("\\\\(#" n "\\\\)$") { q = $1 } END { print (m != "" ? m : q) }'`
  const log = `git log --first-parent --no-show-signature --format='%H %s' "$t" 2>/dev/null | awk -v n="$n" ${pickMerge}`
  return (
    `u=$(git remote get-url origin 2>/dev/null | tr '[:upper:]' '[:lower:]'); case "$u" in ${pick} *) n=;; esac; ` +
    `if [ -n "$n" ] && t=${TRUNK} && m=$(${log}) && [ -n "$m" ]; then git diff --quiet "$m" -- ${shellWord(d.scope)}; echo ${shellWord(d.id)} $? merge "$n"; ` +
    `else ${day ? datedLine(d, day) : `echo ${shellWord(d.id)} unmerged`}; fi`
  )
}

/**
 * The shell lines the scope check runs, one per decision: when the repo knows the decision's commit,
 * `git diff --quiet` against it, printing the id and the exit status (0 = unchanged since the commit,
 * working tree included); when it does not (a squash-merged branch, another clone), the id and
 * `missing`. A decision naming no commit but a pull request of this repository is compared the same way
 * against that request's merge on the trunk, the line printing `merge <N>` after the status (mergeLine;
 * realm @nick/craft, node #682); its merge not found, by its date as below, or with none `unmerged`. A
 * decision naming no commit but a date is compared the same way against the last commit
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
  /** @param {PriorDecision} d */
  const line = d => {
    if (d.commit)
      return `if git cat-file -e ${shellWord(`${d.commit}^{commit}`)} 2>/dev/null; then git diff --quiet ${shellWord(d.commit)} -- ${shellWord(d.scope)}; echo ${shellWord(d.id)} $?; else echo ${shellWord(d.id)} missing; fi`
    return d.pulls?.length ? mergeLine(d, d.pulls, decisionDate(d)) : datedLine(d, decisionDate(d))
  }
  return decisions.map(line).join('\n')
}

// The words a scope-check line prints, after the id, for a decision whose anchor names no commit to compare.
const UNUSABLE_WORDS = ['future', 'no-trunk', 'unreadable', 'unmerged']

// What the scope-check agent returns: the ids it saw print status 0, those it saw print `missing`, those
// it saw print another word in place of a status, and those whose status was followed by `merge <N>`.
export const SCOPE_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['unchanged', 'missing', 'unusable', 'merged', 'reason'],
  properties: {
    unchanged: { type: 'array', items: { type: 'string' }, description: 'ids whose line ended in exit status 0, exactly as printed' },
    missing: { type: 'array', items: { type: 'string' }, description: 'ids whose line ended in the word missing, exactly as printed' },
    unusable: {
      type: 'array',
      description: 'ids whose line ended in the word future, no-trunk, unreadable or unmerged, each with that word',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'word'],
        properties: { id: { type: 'string' }, word: { type: 'string', enum: UNUSABLE_WORDS } },
      },
    },
    merged: {
      type: 'array',
      description: 'ids whose status was followed by the word merge and a number, each with that number',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'pr'],
        properties: { id: { type: 'string' }, pr: { type: 'integer' } },
      },
    },
    reason: { type: 'string', description: 'one line: anything that did not run' },
  },
}

/** The scope-check agent's prompt. @param {PriorDecision[]} decisions @returns {string} */
export function scopeCheckPrompt(decisions) {
  return `Run these lines in the repository under review, exactly as written (shell only, read only). Each prints a decision id and the exit status of \`git diff --quiet\` against that decision's commit (or, for a decision naming a pull request, that request's merge on the trunk, the status then followed by merge and the request's number; for one naming only a date, the trunk's last commit before that date), or the word missing when the repository does not have that commit — or, for a date, future, no-trunk or unreadable when it cannot be compared, and unmerged when a pull request's merge is not found and there is no date.
${scopeCheckScript(decisions)}
Return {unchanged: [every id whose printed status was 0], missing: [every id printed with the word missing], unusable: [{id, word} for every id printed with the word future, no-trunk, unreadable or unmerged], merged: [{id, pr} for every id whose status was followed by merge and a number, pr that number], reason: one line on anything that did not run}.`
}

/**
 * The ids a scope-check answer names unchanged and missing, the word it names each unusable one by, and the
 * pull request whose merge it names each merged one compared against, or null when the answer is absent or
 * its `unchanged` unreadable — then no decision is shown unchanged and nothing is set aside. An answer
 * without `unusable` or `merged`, which the schema requires, names none.
 * @param {unknown} ans
 * @returns {{ unchanged: string[], missing: string[], unusable: Array<{ id: string, word: string }>, merged: Array<{ id: string, pr: number }> } | null}
 */
export function readScopeCheck(ans) {
  const o = ans && typeof ans === 'object' ? /** @type {Record<string, unknown>} */ (ans) : {}
  /** @param {unknown} v */
  const ids = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
  /** @param {unknown} x @returns {Record<string, unknown>} */
  const entry = x => (x && typeof x === 'object' ? /** @type {Record<string, unknown>} */ (x) : {})
  /** @param {unknown} x @returns {x is { id: string, word: string }} */
  const named = x => {
    const e = entry(x)
    return typeof e['id'] === 'string' && typeof e['word'] === 'string' && UNUSABLE_WORDS.includes(e['word'])
  }
  /** @param {unknown} x @returns {x is { id: string, pr: number }} */
  const numbered = x => typeof entry(x)['id'] === 'string' && Number.isInteger(entry(x)['pr'])
  /** @param {unknown} v @returns {unknown[]} */
  const list = v => (Array.isArray(v) ? v : [])
  const unusable = list(o['unusable'])
    .filter(named)
    .map(e => ({ id: e.id, word: e.word }))
  const merged = list(o['merged'])
    .filter(numbered)
    .map(e => ({ id: e.id, pr: e.pr }))
  return Array.isArray(o['unchanged']) ? { unchanged: ids(o['unchanged']), missing: ids(o['missing']), unusable, merged } : null
}

/**
 * Runs the scope check for `toCheck` (never with none; an anchor naming no commit raises the finding and is
 * reported — realm @nick/craft, node #184): the ids observed unchanged since their commit, pull request merge
 * or date; those whose anchor names no commit to compare, each with the word its line printed (`missing`,
 * `future`, `no-trunk`, `unreadable`, `unmerged`); and those compared against a pull request's merge, each
 * with that request's number — one the decision links, else none (realm @nick/craft, node #682). A dead or
 * unreadable answer shows nothing unchanged (said in `notes`).
 * @param {PriorDecision[]} toCheck @param {(toCheck: PriorDecision[]) => Promise<unknown>} checkScopes @param {string[]} notes
 * @returns {Promise<{ toCheck: PriorDecision[], unchanged: Set<string>, missing: Map<string, string>, merged: Map<string, number> }>}
 */
export async function runScopeCheck(toCheck, checkScopes, notes) {
  const unchanged = new Set(/** @type {string[]} */ ([]))
  const missing = new Map(/** @type {Array<[string, string]>} */ ([]))
  const merged = new Map(/** @type {Array<[string, number]>} */ ([]))
  if (!toCheck.length) return { toCheck, unchanged, missing, merged }
  const ids = readScopeCheck(await checkScopes(toCheck))
  if (ids == null)
    notes.push(
      `the scope-check agent died or answered unreadably — no decision could be shown unchanged, so the ${toCheck.length} decision(s) set nothing aside`,
    )
  // An id outside `toCheck` sets nothing aside: splitByDecisions only consults decisions that answer
  // a finding below Critical/High and carry a commit or a date, which is exactly what was checked.
  for (const id of ids?.unchanged || []) unchanged.add(id)
  if (ids) for (const d of toCheck) missingWord(d, ids, missing)
  if (ids) for (const d of toCheck) mergedPull(d, ids, merged)
  return { toCheck, unchanged, missing, merged }
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

/**
 * Notes in `merged` the pull request whose merge the answer `ids` says decision `d`'s scope was compared
 * against, when `d` names no commit and links that request.
 * @param {PriorDecision} d @param {NonNullable<ReturnType<typeof readScopeCheck>>} ids @param {Map<string, number>} merged
 */
function mergedPull(d, ids, merged) {
  const pr = d.commit ? undefined : ids.merged.find(m => m.id === d.id)?.pr
  if (pr && d.pulls?.some(p => p.number === pr)) merged.set(d.id, pr)
}
