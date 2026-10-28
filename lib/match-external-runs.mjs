// The run-store side of matching an external reviewer's PR findings (lib/match-external-findings.mjs): which review
// runs belong to the PR, and which of them covered a file. The store is shared by every repository, so a run is
// the PR's only when its `project` (the main checkout root, lib/repo-key.mjs) is a checkout of the PR's repository
// and it is on the PR's branch or at one of its commits — as prior rounds are keyed (lib/run-record.mjs,
// selectPriorRounds).

/** @typedef {import('./external-findings-parse.mjs').PrView} PrView */
/** @typedef {{ fp: string, file: string, line: number | null, symbol: string, severity: string, tier: string, disposition: string, title: string, why: string }} Row */
/** @typedef {{ name?: unknown, ts?: unknown, project?: unknown, branch?: unknown, head?: unknown, path?: unknown, lensScope?: unknown, partial?: unknown, notRun?: unknown, ledger?: unknown, uncoveredFiles?: unknown, verdict?: unknown }} RunRecord */
/** @typedef {{ ts: string, head: string | null, at: number, hIdx: number, ledger: Row[], scope: string, dead: boolean, delta: boolean, uncovered: unknown[], verdict: unknown }} Run */

/** @param {unknown} v */
export const str = v => (typeof v === 'string' ? v : '')
/** A run-store timestamp (`2026-10-21T19-12-00Z`) as epoch ms. @param {string} ts */
export const runTime = ts => Date.parse(ts.replace(/T(\d\d)-(\d\d)-(\d\d)Z$/, 'T$1:$2:$3Z'))

/**
 * The GitHub `owner/name`s a `git remote -v` output names, lower-cased: https, ssh and scp-style URLs.
 * @param {string} remoteV @returns {Set<string>}
 */
export function remoteRepos(remoteV) {
  const out = new Set()
  for (const m of remoteV.matchAll(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=\s|$)/gm)) out.add(`${m[1]}/${m[2]}`.toLowerCase())
  return out
}

/**
 * The record projects that are checkouts of `repo` (`owner/name`), by what each project's git remotes name.
 * @param {RunRecord[]} records @param {string} repo @param {(dir: string) => string} remotesOf  `git remote -v` in dir, '' when none
 */
export function projectsOf(records, repo, remotesOf) {
  const dirs = new Set(records.map(r => str(r.project)).filter(Boolean))
  return new Set([...dirs].filter(d => remoteRepos(remotesOf(d)).has(repo.toLowerCase())))
}

/** A ledger row with every field present. @param {Record<string, unknown>} l @returns {Row} */
const row = l => ({ fp: str(l['fp']), file: str(l['file']), line: typeof l['line'] === 'number' ? l['line'] : null, symbol: str(l['symbol']),
  severity: str(l['severity']), tier: str(l['tier']), disposition: str(l['disposition']), title: str(l['title']), why: str(l['why']) })

/**
 * A run whose lenses did not all report: recovered after it died (`partial`), its verdict `INCOMPLETE`, or a phase
 * or lens named in `notRun`. Its silence about a file says nothing.
 * @param {RunRecord} r
 */
const isDead = r => r.partial === true || str(r.verdict).startsWith('INCOMPLETE') || (Array.isArray(r.notRun) && r.notRun.length > 0)

/** @param {RunRecord} r @param {PrView} pr @param {Map<string, number>} idx @param {Set<string>} projects */
const isPrRun = (r, pr, idx, projects) => r.name === 'review' && typeof r.ts === 'string' && projects.has(str(r.project))
  && (r.branch === pr.headRefName || idx.has(str(r.head)))

/** The PR's review runs, oldest first. @param {RunRecord[]} records @param {PrView} pr @param {Set<string>} projects @returns {Run[]} */
export function branchRuns(records, pr, projects) {
  const idx = new Map(pr.commits.map((c, i) => [c.oid, i]))
  return records.filter(r => isPrRun(r, pr, idx, projects)).map(r => {
    const ts = str(r.ts)
    const head = str(r.head) || null
    const ledger = Array.isArray(r.ledger) ? r.ledger.filter(l => l && typeof l === 'object').map(row) : []
    return { ts, head, at: runTime(ts), hIdx: idx.get(str(head)) ?? -1, ledger, scope: str(r.path).replace(/\/+$/, '').replace(/^\.$/, ''), dead: isDead(r), delta: r.lensScope === 'delta',
      uncovered: Array.isArray(r.uncoveredFiles) ? r.uncoveredFiles : [], verdict: r.verdict }
  }).sort((a, b) => a.at - b.at)
}

// A glob pathspec's wildcards: `**/` any directories (none included), `**` anything, `*` and `?` within one segment.
/** @type {Record<string, string>} */
const WILDCARD = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' }

/**
 * Whether `file` is under the record's `path` pathspec: a plain path covers itself and everything below it; one with
 * `*` or `?` is matched as a glob, and what it names covers everything below it too.
 * @param {string} spec @param {string} file
 */
export function inPathspec(spec, file) {
  if (spec === '') return true
  if (!/[*?]/.test(spec)) return file === spec || file.startsWith(`${spec}/`)
  const body = spec.split(/(\*\*\/|\*\*|\*|\?)/).map(t => WILDCARD[t] ?? t.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp(`^${body}(?:/.*)?$`).test(file)
}

/**
 * Whether the run reviewed `file`: inside its `path` pathspec (the whole repository when empty; a finding with no
 * file only then) and not among its `uncoveredFiles`. Liveness (`dead`) and delta scope (`delta`: it names no files
 * it reviewed) are separate; an empty ledger still covers.
 * @param {Run} r @param {string | null} file
 */
export function reviewed(r, file) {
  if (file == null) return r.scope === ''
  return inPathspec(r.scope, file) && !r.uncovered.includes(file)
}
