// An external reviewer's PR findings matched against craft's review ledgers on the same branch: for each finding,
// the ledger rows it may be (same file and a line within WINDOW of an anchor, or a symbol the finding names),
// and — once a human or agent has judged which rows share its mechanism (the decisions file) — whether craft saw
// it, and when. The precision side: craft's confirmed Medium+ rows no finding was matched to. The measurement is
// realm @nick/craft, node #378, of transformation #368; a CLI and not an agent, as deterministic work (#375).
import { parseFindings, statusReplies } from './external-findings-parse.mjs'
import { branchRuns, reviewed, str } from './match-external-runs.mjs'

/** @typedef {import('./external-findings-parse.mjs').PrView} PrView @typedef {import('./external-findings-parse.mjs').PrComment} PrComment */
/** @typedef {import('./external-findings-parse.mjs').Finding} Finding @typedef {import('./external-findings-parse.mjs').Reply} Reply */
/** @typedef {import('./match-external-runs.mjs').Row} Row @typedef {import('./match-external-runs.mjs').Run} Run @typedef {import('./match-external-runs.mjs').RunRecord} RunRecord */
/** @typedef {{ matches?: Array<{ rec: string, fp: string, reason?: string }>, note?: string, bucket?: string }} Decision */

export const WINDOW = 15
export const BUCKETS = ['SEEN_CONFIRMED', 'SEEN_WEAK', 'SEEN_LATER', 'NOT_SEEN_COVERED', 'NOT_SEEN_UNCOVERED', 'UNCLEAR']
/** @type {Record<string, number>} */
const CRAFT_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1, Info: 0 }
/** @type {Record<string, number>} */
const EXT_RANK = { critical: 4, 'must-fix': 3, high: 3, 'should-fix': 2, medium: 2, optional: 1, low: 1 }

/** @param {string} s */
const tokens = s => new Set(s.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? [])
/** @param {Set<string>} a @param {Set<string>} b */
const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1) }
/** @param {string | null} sha */
const short = sha => sha?.slice(0, 8) ?? null
/** @param {Record<string, number>} table @param {string | null} k */
const rankIn = (table, k) => table[k ?? ''] ?? 0

/** The finding's own line plus every `path:line(-line)` its body cites. @param {Finding} f */
export function anchors(f) {
  const refs = [...f.body.matchAll(/`([\w./-]+\.\w+):(\d+)(?:-(\d+))?`/g)].map(m => ({ file: str(m[1]), lo: Number(m[2]), hi: Number(m[3] ?? m[2]) }))
  if (f.path && f.line != null) refs.push({ file: f.path, lo: f.line, hi: f.line })
  return refs
}

/** Ledger rows the finding may be, by word overlap; `before` = filed by the finding's round. @param {Finding} f @param {Run[]} runs */
export function rankCandidates(f, runs, window = WINDOW) {
  const refs = anchors(f)
  const words = tokens(f.body)
  const cutoff = Date.parse(f.round.at)
  /** @param {Row} l */
  const near = l => l.line != null && refs.some(x => l.file === x.file && Number(l.line) >= x.lo - window && Number(l.line) <= x.hi + window)
  /** @param {Row} l */
  const named = l => l.file === f.path && l.symbol !== '' && f.body.includes(l.symbol)
  return runs.flatMap(run => run.ledger.filter(l => named(l) || near(l)).map(l => ({
    rec: run.ts, head: short(run.head), fp: l.fp, file: l.file, line: l.line, sev: l.severity, tier: l.tier, disp: l.disposition, title: l.title,
    score: Number(jaccard(words, tokens(`${l.title} ${l.why}`)).toFixed(3)), before: run.at <= cutoff,
  }))).sort((a, b) => b.score - a.score)
}

/** The decided matches, located in the runs (`missing` when the run or row is not there). @param {Decision} d @param {Run[]} runs @param {number} cutoff */
export function resolveMatches(d, runs, cutoff) {
  return (d.matches ?? []).map(m => {
    const run = runs.find(r => r.ts.startsWith(m.rec) && r.ledger.some(x => x.fp === m.fp))
    const l = run?.ledger.find(x => x.fp === m.fp)
    if (!run || !l) return { ...m, missing: true, before: false, tier: '', sev: '' }
    const later = runs.filter(r => r.at > run.at).flatMap(r => r.ledger.filter(x => x.fp === m.fp).slice(0, 1).map(x => `${r.ts}@i${r.hIdx}:${x.disposition}`))
    return { ...m, rec: run.ts, head: short(run.head), hIdx: run.hIdx, missing: false, before: run.at <= cutoff, sev: l.severity, tier: l.tier, disp: l.disposition, title: l.title, laterRecords: later }
  })
}

/**
 * The runs that reviewed the finding's file (`reviewed`): `atHead` — complete runs (neither dead nor delta) from the reviewer's
 * commit up to their own "Fixed at"; `others` — every other run that reviewed it, dead ones included.
 * @param {Finding} f @param {Run[]} runs @param {PrView} pr @param {Reply[]} rep
 */
function coverage(f, runs, pr, rep) {
  const shaIdx = (/** @type {string} */ sha) => pr.commits.findIndex(c => c.oid.startsWith(sha))
  const igIdx = pr.commits.findIndex(c => c.oid === f.round.head)
  const fixed = rep.find(x => x.status === 'fixed')
  // A "Fixed at" commit not on the PR (force-pushed away) bounds nothing.
  const fixAt = fixed ? shaIdx(fixed.sha) : -1
  const fixIdx = fixAt >= 0 ? fixAt : Infinity
  const touching = runs.filter(r => reviewed(r, f.path))
  const atHead = touching.filter(r => !r.dead && !r.delta && igIdx >= 0 && r.hIdx >= igIdx && r.hIdx < fixIdx)
  const lastSeen = Math.max(igIdx, ...rep.filter(x => x.status === 'still present').map(x => shaIdx(x.sha)))
  return { igIdx, fixIdx, atHead, others: touching.filter(r => !atHead.includes(r)), strong: atHead.filter(r => r.hIdx <= lastSeen).length, replies: rep.map(x => `${x.status}@${shaIdx(x.sha)}`) }
}

/** @param {Finding} f @param {ReturnType<typeof resolveMatches>} matches */
function seenBucket(f, matches) {
  const found = matches.filter(m => !m.missing)
  const pre = found.filter(m => m.before)
  const rank = rankIn(EXT_RANK, f.sev)
  if (pre.length) return pre.some(m => m.tier === 'confirmed' && rankIn(CRAFT_RANK, m.sev) >= rank - 1) ? 'SEEN_CONFIRMED' : 'SEEN_WEAK'
  return found.length ? 'SEEN_LATER' : null
}

/** Not seen: a complete run at the head misses it; no run that could have seen it is uncovered; any other — a dead run at the head, or runs only at earlier heads — unclear. @param {ReturnType<typeof coverage>} c */
function unseenBucket(c) {
  if (c.atHead.length) return 'NOT_SEEN_COVERED'
  return c.others.every(r => r.hIdx >= c.fixIdx) ? 'NOT_SEEN_UNCOVERED' : 'UNCLEAR'
}

/**
 * The bucket of one decided finding. Seen before the reviewer's round: confirmed at no more than one rank below
 * theirs is SEEN_CONFIRMED, else SEEN_WEAK; seen only after it, SEEN_LATER. Not seen: a run that covered the file
 * between the reviewer's commit and their own "Fixed at" is NOT_SEEN_COVERED; no run that reviewed the file, or only
 * runs after that fix, NOT_SEEN_UNCOVERED; anything else — only dead or delta runs in that span, or runs only at earlier heads,
 * where the defect may not yet exist — UNCLEAR.
 * @param {Finding} f @param {Decision} d @param {Run[]} runs @param {PrView} pr @param {Map<number, Reply[]>} replies
 */
export function classify(f, d, runs, pr, replies) {
  const c = coverage(f, runs, pr, (f.rootId != null && replies.get(f.rootId)) || [])
  const matches = resolveMatches(d, runs, Date.parse(f.round.at))
  const bucket = d.bucket ?? seenBucket(f, matches) ?? unseenBucket(c)
  return { bucket, igIdx: c.igIdx, fixIdx: Number.isFinite(c.fixIdx) ? c.fixIdx : null, replies: c.replies, matches,
    coveredAtHead: c.atHead.map(r => ({ rec: r.ts, head: short(r.head) })), coveredElsewhere: c.others.length, coveredStrongN: c.strong }
}

/** Confirmed Medium+ ledger rows no decision matched, once per file and fingerprint. @param {Run[]} runs @param {Set<string>} matched */
export function craftOnly(runs, matched) {
  /** @type {Map<string, { fp: string, file: string, line: number | null, sev: string, disp: string, title: string, firstRun: string }>} */
  const seen = new Map()
  for (const run of runs) {
    const rows = run.ledger.filter(l => l.tier === 'confirmed' && rankIn(CRAFT_RANK, l.severity) >= 2 && !matched.has(l.fp))
    for (const l of rows.filter(x => !seen.has(`${x.file}|${x.fp}`))) {
      seen.set(`${l.file}|${l.fp}`, { fp: l.fp, file: l.file, line: l.line, sev: l.severity, disp: l.disposition, title: l.title, firstRun: run.ts })
    }
  }
  return [...seen.values()]
}

/**
 * One PR matched. `decisions` null: candidates only, no bucket and no precision side.
 * @param {{ pr: PrView, comments: PrComment[], records: RunRecord[], projects: Set<string>, options: import('./external-findings-parse.mjs').ParseOptions, decisions: Record<string, Decision> | null, n: number, top: number }} input
 */
export function matchPr({ pr, comments, records, projects, options, decisions, n, top }) {
  const { findings, excluded, unanchored } = parseFindings(pr, comments, options)
  const runs = branchRuns(records, pr, projects)
  const replies = statusReplies(comments, options.reviewers)
  const results = findings.map(f => {
    const cands = rankCandidates(f, runs)
    const base = { id: f.id, path: f.path, line: f.line, sev: f.sev, url: f.url, round: f.round, rounds: f.rounds, nCands: cands.length, cands: cands.slice(0, top), text: f.body.slice(0, 700) }
    if (!decisions) return { ...base, bucket: null, note: null, matches: [] }
    const d = decisions[`${n}:${f.id}`] ?? {}
    return { ...base, note: d.note ?? null, ...classify(f, d, runs, pr, replies) }
  })
  const matched = new Set(results.flatMap(r => r.matches.filter(m => !m.missing).map(m => m.fp)))
  return { head: pr.headRefName, commits: pr.commits.length, reviewers: options.reviewers, excluded, unanchored, results,
    runs: runs.map(r => ({ ts: r.ts, head: short(r.head), hIdx: r.hIdx, verdict: r.verdict, scope: r.scope, dead: r.dead, delta: r.delta, ledger: r.ledger.length })),
    deltaRuns: runs.filter(r => r.delta).length,
    craftOnly: decisions ? craftOnly(runs, matched) : null }
}

/** `<pr>|<severity>|<bucket>` counts, each also under `ALL`, sorted. @param {Record<string, { results: Array<{ sev: string | null, bucket: string | null }> }>} prs */
export function tally(prs) {
  /** @type {Map<string, number>} */
  const sum = new Map()
  for (const [n, p] of Object.entries(prs)) {
    for (const r of p.results.filter(x => x.bucket)) {
      for (const k of [`${n}|${r.sev}|${r.bucket}`, `ALL|${r.sev}|${r.bucket}`]) sum.set(k, (sum.get(k) ?? 0) + 1)
    }
  }
  return [...sum.entries()].sort(([a], [b]) => a.localeCompare(b))
}

/** Decision keys no finding of the matched PRs carries: an id that changed, a finding excluded, a typo. @param {Record<string, Decision>} decisions @param {Record<string, { results: Array<{ id: string }> }>} prs */
export function unmatchedDecisions(decisions, prs) {
  const keys = new Set(Object.entries(prs).flatMap(([n, p]) => p.results.map(r => `${n}:${r.id}`)))
  return Object.keys(decisions).filter(k => !keys.has(k))
}
