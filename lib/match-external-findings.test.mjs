// External findings against craft's run ledgers (lib/match-external-findings.mjs): candidates, buckets, precision side.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { anchors, classify, craftOnly, matchPr, rankCandidates, tally, unmatchedDecisions, WINDOW } from './match-external-findings.mjs'
import { branchRuns as runsOf } from './match-external-runs.mjs'
import { DEFAULT_SEVERITY } from './external-findings-parse.mjs'

const sha = (/** @type {number} */ i) => String(i).repeat(40).slice(0, 40)
const PR = { author: { login: 'pr-author' }, headRefName: 'feat/x', commits: [0, 1, 2, 3, 4].map(i => ({ oid: sha(i + 1) })), reviews: [] }
/** @param {Record<string, unknown>} [over] */
const row = (over = {}) => ({ fp: 'fp000001', file: 'src/a.rs', line: 40, symbol: '', severity: 'High', tier: 'confirmed', disposition: 'open', title: 'lock dropped before write', why: 'the guard goes out of scope', ...over })
/** @param {string} ts @param {number} head  index into PR.commits @param {any[]} ledger @param {Record<string, unknown>} [over] */
const rec = (ts, head, ledger, over = {}) => ({ name: 'review', ts, project: '/work/repo', branch: 'feat/x', head: sha(head + 1), ledger, uncoveredFiles: [], verdict: 'Warning', ...over })
/** @param {Record<string, unknown>} [over] @returns {any} */
const finding = (over = {}) => ({ id: 'FR-RACE-abc123', path: 'src/a.rs', line: 40, sev: 'must-fix', body: 'FR-RACE-abc123 must-fix: the lock guard dropped before the write', ctx: '',
  url: null, rootId: 1, round: { at: '2026-10-02T12:00:00Z', head: sha(3) }, rounds: 1, ...over })

const PROJECTS = new Set(['/work/repo'])
/** @param {any[]} records */
const branchRuns = (records, /** @type {any} */ pr) => runsOf(records, pr, PROJECTS)

test('anchors are the finding\'s own line and every path:line range its body cites', () => {
  assert.deepEqual(anchors(finding({ body: 'see `src/b.rs:10-12` and `src/c.rs:5`' })), [{ file: 'src/b.rs', lo: 10, hi: 12 }, { file: 'src/c.rs', lo: 5, hi: 5 }, { file: 'src/a.rs', lo: 40, hi: 40 }])
})

test('candidates: the same file within the window, a cited range, or a named symbol; ranked by word overlap', () => {
  const ledger = [row({ fp: 'in', line: 40 + WINDOW }), row({ fp: 'out', line: 40 + WINDOW + 1 }), row({ fp: 'otherfile', file: 'src/z.rs' }),
    row({ fp: 'sym', line: 400, symbol: 'flush_all', title: 'unrelated' }), row({ fp: 'cited', file: 'src/b.rs', line: 30, title: 'x' })]
  const runs = branchRuns([rec('2026-10-01T00-00-00Z', 2, ledger), rec('2026-10-03T00-00-00Z', 3, [row({ fp: 'late' })])], PR)
  const c = rankCandidates(finding({ body: 'FR-RACE-abc123 the lock guard dropped before the write in flush_all; see `src/b.rs:20`' }), runs)
  assert.deepEqual(c.map(x => x.fp).sort(), ['cited', 'in', 'late', 'sym'])
  assert.ok((c[0]?.score ?? 0) > (c.at(-1)?.score ?? 1), 'best overlap first')
  assert.deepEqual(c.filter(x => !x.before).map(x => x.fp), ['late'], 'filed after the reviewer\'s round')
})

/** @param {any[]} records @param {any} d @param {any} [f] @param {Map<number, any[]>} [replies] */
const bucket = (records, d, f = finding(), replies = new Map()) => classify(f, d, branchRuns(records, PR), PR, replies).bucket

test('seen before the reviewer\'s round: confirmed within one rank of theirs, else weak', () => {
  const runs = [rec('2026-10-01T00-00-00Z', 2, [row(), row({ fp: 'low', severity: 'Low' }), row({ fp: 'sus', tier: 'suspected' })])]
  assert.equal(bucket(runs, { matches: [{ rec: '2026-10-01', fp: 'fp000001' }] }), 'SEEN_CONFIRMED')
  assert.equal(bucket(runs, { matches: [{ rec: '2026-10-01', fp: 'low' }] }), 'SEEN_WEAK', 'Low against must-fix')
  assert.equal(bucket(runs, { matches: [{ rec: '2026-10-01', fp: 'sus' }] }), 'SEEN_WEAK', 'not confirmed')
  assert.equal(bucket(runs, { matches: [{ rec: '2026-10-01', fp: 'low' }] }, finding({ sev: 'optional' })), 'SEEN_CONFIRMED')
})

test('seen only after the round is SEEN_LATER; a match naming no such row does not count', () => {
  const runs = [rec('2026-10-05T00-00-00Z', 4, [row()])]
  assert.equal(bucket(runs, { matches: [{ rec: '2026-10-05', fp: 'fp000001' }] }), 'SEEN_LATER')
  assert.equal(bucket(runs, { matches: [{ rec: '2026-10-05', fp: 'nope' }] }), 'NOT_SEEN_COVERED')
})

test('not seen: covered at the reviewer\'s head, uncovered, or only earlier heads (unclear)', () => {
  assert.equal(bucket([rec('2026-10-03T00-00-00Z', 2, [row()])], {}), 'NOT_SEEN_COVERED')
  assert.equal(bucket([rec('2026-10-03T00-00-00Z', 2, [row()], { uncoveredFiles: ['src/a.rs'] })], {}), 'NOT_SEEN_UNCOVERED')
  assert.equal(bucket([rec('2026-10-01T00-00-00Z', 1, [row({ fp: 'other' })])], {}), 'UNCLEAR')
  assert.equal(bucket([rec('2026-10-03T00-00-00Z', 2, [row()], { path: 'src/other' })], {}), 'NOT_SEEN_UNCOVERED', 'outside the run\'s path scope')
  assert.equal(bucket([rec('2026-10-03T00-00-00Z', 2, [row()], { path: 'src' })], {}), 'NOT_SEEN_COVERED', 'inside it')
})

test('a complete run with an empty ledger covers; a dead run at the head alone leaves it unclear', () => {
  assert.equal(bucket([rec('2026-10-03T00-00-00Z', 2, [])], {}), 'NOT_SEEN_COVERED')
  for (const dead of [{ partial: true }, { verdict: 'INCOMPLETE' }, { notRun: ['safety lens never returned'] }]) {
    assert.equal(bucket([rec('2026-10-03T00-00-00Z', 2, [row()], dead)], {}), 'UNCLEAR', JSON.stringify(dead))
  }
  assert.equal(bucket([rec('2026-10-03T00-00-00Z', 2, [], { partial: true }), rec('2026-10-04T00-00-00Z', 3, [])], {}), 'NOT_SEEN_COVERED', 'a complete run beside it')
})

test('runs only after the reviewer\'s own "Fixed at" leave it uncovered; a fix commit off the PR bounds nothing', () => {
  const runs = [rec('2026-10-04T00-00-00Z', 3, [row({ fp: 'other' })])]
  const fixedAt = (/** @type {string} */ s) => new Map([[1, [{ status: 'fixed', sha: s, at: '' }]]])
  assert.equal(bucket(runs, {}, finding({ round: { at: '2026-10-02T00:00:00Z', head: sha(2) } }), fixedAt('4444444')), 'NOT_SEEN_UNCOVERED')
  assert.equal(bucket(runs, {}, finding({ round: { at: '2026-10-02T00:00:00Z', head: sha(2) } }), fixedAt('abcdef0')), 'NOT_SEEN_COVERED')
})

test('a delta run covers nothing (it names no files), yet a row it filed still proves the finding seen', () => {
  const delta = { lensScope: 'delta' }
  assert.equal(bucket([rec('2026-10-03T00-00-00Z', 2, [row({ fp: 'other' })], delta)], {}), 'UNCLEAR')
  assert.equal(bucket([rec('2026-10-01T00-00-00Z', 2, [row()], delta)], { matches: [{ rec: '2026-10-01', fp: 'fp000001' }] }), 'SEEN_CONFIRMED')
  assert.equal(bucket([rec('2026-10-03T00-00-00Z', 2, [], delta), rec('2026-10-03T00-00-01Z', 2, [], { lensScope: 'full' })], {}), 'NOT_SEEN_COVERED')
})

test('a decided bucket overrides the computed one', () => {
  assert.equal(bucket([], { bucket: 'UNCLEAR', matches: [] }), 'UNCLEAR')
})

test('the precision side: confirmed Medium+ rows no finding matched, once per file and fingerprint', () => {
  const runs = branchRuns([rec('2026-10-01T00-00-00Z', 1, [row(), row({ fp: 'm' , severity: 'Medium' }), row({ fp: 'l', severity: 'Low' }), row({ fp: 's', tier: 'suspected' })]),
    rec('2026-10-02T00-00-00Z', 2, [row({ fp: 'm', severity: 'Medium' })])], PR)
  assert.deepEqual(craftOnly(runs, new Set(['fp000001'])).map(c => [c.fp, c.firstRun]), [['m', '2026-10-01T00-00-00Z']])
})

test('one PR without decisions: candidates only; with them, buckets, matches and the precision side', () => {
  const comments = [{ id: 1, user: { login: 'ext-reviewer' }, body: 'FR-RACE-abc123 must-fix lock guard dropped', path: 'src/a.rs', line: 41, original_commit_id: sha(3), created_at: '2026-10-02T12:00:00Z' }]
  const records = [rec('2026-10-01T00-00-00Z', 2, [row(), row({ fp: 'extra', line: 300, severity: 'Medium' })])]
  const options = { reviewers: ['ext-reviewer'], idRe: /FR-[A-Z]+-[0-9a-f]{6}/, exRe: null, sevRe: DEFAULT_SEVERITY }
  const bare = matchPr({ pr: PR, comments, records, projects: PROJECTS, options, decisions: null, n: 7, top: 4 })
  assert.equal(bare.results[0]?.bucket, null)
  assert.deepEqual(bare.results[0]?.cands.map(c => c.fp), ['fp000001'])
  assert.equal(bare.craftOnly, null)
  const decided = matchPr({ pr: PR, comments, records, projects: PROJECTS, options, decisions: { '7:FR-RACE-abc123': { matches: [{ rec: '2026-10-01', fp: 'fp000001' }] } }, n: 7, top: 4 })
  assert.equal(decided.results[0]?.bucket, 'SEEN_CONFIRMED')
  assert.deepEqual(decided.craftOnly?.map(c => c.fp), ['extra'])
  assert.deepEqual(tally({ 7: decided }), [['7|must-fix|SEEN_CONFIRMED', 1], ['ALL|must-fix|SEEN_CONFIRMED', 1]])
})

test('decision keys no matched finding carries are named', () => {
  const prs = { 7: { results: [{ id: 'a' }] } }
  assert.deepEqual(unmatchedDecisions({ '7:a': {}, '7:b': {}, '8:a': {} }, prs), ['7:b', '8:a'])
})
