// The sorting before publication through the real review engine (realm @nick/craft, nodes #270, #277;
// lib/engine-harness.mjs): with `comment`, only defects are posted; the doubtful ones are listed for the
// reviewer with why, numbered, and the run record counts both; the changed lines come from one agent.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { filedRecord, runEngine } from './engine-harness.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const FILE = 'crates/node/src/db.rs'

/** @param {Record<string, unknown>} [over] */
const finding = (over = {}) => ({
  severity: 'Medium', title: 'unwrap on the row may panic', file: FILE, line: 12, why: 'an empty row panics', fix: 'return an error',
  blastRadius: '', source: 'errors', ruleId: '', symbol: 'load', whereChecked: '', ...over,
})
const FINDINGS = [
  finding(),
  finding({ source: 'compat', title: 'renamed key breaks stored rows', line: 13, symbol: 'save' }),
  finding({ title: 'lock held across await', line: 99, symbol: 'flush' }),
]

/** @param {any[]} findings */
const lensOnce = findings => {
  const seen = new Set()
  return (/** @type {{ opts: { label: string } }} */ { opts }) => {
    const lens = String(/^lens:[^:]+:([\w-]+)/.exec(opts.label)?.[1])
    const first = !seen.has(lens)
    seen.add(lens)
    return { lens, findings: first ? findings.filter(f => f.source === lens) : [] }
  }
}

/** @param {Record<string, unknown>} args @param {unknown} diffLines @param {any[]} [findings] */
const review = (args, diffLines, findings = FINDINGS) => runEngine('review', { args, script: {
  detect: { baseRef: 'main', files: [FILE], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['compat', 'errors'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: lensOnce(findings),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  'diff-lines': diffLines,
  'pr-comments': { posted: 1, reason: 'PR #9' },
  synthesis: null,
  '*': null,
} })
/** @param {any} run @param {string} label */
const calls = (run, label) => run.calls.filter((/** @type {{ label: unknown }} */ c) => c.label === label)
/** @param {any} run */
const postedBodies = run => /** @type {Array<{ body: string }>} */ (JSON.parse(String(calls(run, 'pr-comments')[0]?.prompt).slice(String(calls(run, 'pr-comments')[0]?.prompt).indexOf('[\n')).split('\nReturn {posted')[0] || '[]')).map(x => x.body)

test('comment: only the defect is posted; the compat finding and the one outside the diff are listed for the reviewer', async () => {
  const run = await review({ comment: true }, { lines: [`HUNK\t+10,5\tb/${FILE}`, 'HUNKS-END'], reason: '' })
  const asked = calls(run, 'diff-lines')
  assert.equal(asked.length, 1)
  assert.match(String(asked[0].prompt), /git diff -U0 --no-color --no-ext-diff --merge-base 'main' -- 'crates\/node\/src\/db\.rs'/)
  const bodies = postedBodies(run)
  assert.equal(bodies.length, 1)
  assert.match(String(bodies[0]), /^\[Medium\] unwrap on the row may panic\n/)
  assert.match(run.report, /\n## Doubtful — for the reviewer, not posted\n/)
  assert.match(run.report, /\n\d\. Medium · `crates\/node\/src\/db\.rs:13` · renamed key breaks stored rows · doubtful: raised by the compat lens\n/)
  assert.match(run.report, /\n\d\. Medium · `crates\/node\/src\/db\.rs:99` · lock held across await · doubtful: its line is outside the lines the diff changed\n/)
  assert.match(run.report, /⚠️ Warning/, 'the sorting changes nothing in the verdict')
  const sorting = filedRecord(run).sorting
  assert.deepEqual({ ...sorting, findings: undefined }, { defect: 1, doubtful: 2, inDiffJudged: true, findings: undefined })
  assert.deepEqual(sorting.findings.map((/** @type {any} */ f) => [f.n, f.title, f.line, f.outsideDiff, f.source]), [
    [1, 'renamed key breaks stored rows', 13, false, 'compat'], [2, 'lock held across await', 99, true, 'errors'],
  ])
  assert.equal(sorting.findings[0].why, 'an empty row panics', 'the record carries what the comment is built from')
})

test('comment: a dead diff-lines agent leaves the diff sign unapplied, and the section says so', async () => {
  const run = await review({ comment: true }, null)
  assert.equal(postedBodies(run).length, 2, 'the finding at line 99 is no longer known to be outside the diff')
  assert.match(run.report, /## Doubtful — for the reviewer, not posted\nNot posted on the PR[^\n]*⚠️ the diff-lines agent died, answered unreadably, or its command did not finish/)
  const sorting = filedRecord(run).sorting
  assert.equal(sorting.inDiffJudged, false)
  assert.match(sorting.inDiffNote, /did not finish/)
  assert.deepEqual([sorting.defect, sorting.doubtful], [2, 1])
})

test('without comment nothing is sorted: no agent, no section, no count', async () => {
  const run = await review({}, { lines: [], reason: '' })
  assert.equal(calls(run, 'diff-lines').length, 0)
  assert.equal(calls(run, 'pr-comments').length, 0)
  assert.doesNotMatch(run.report, /## Doubtful/)
  assert.equal(filedRecord(run).sorting, null)
})

test('comment: when every candidate is already doubtful, no agent is asked for the changed lines', async () => {
  const run = await review({ comment: true }, { lines: [], reason: '' }, [FINDINGS[1]])
  assert.equal(calls(run, 'diff-lines').length, 0)
  assert.equal(calls(run, 'pr-comments').length, 0)
  assert.equal(filedRecord(run).sorting.doubtful, 1)
})

test('comment: a finding the verifiers did not confirm is doubtful, never posted', async () => {
  const split = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
  const run = await runEngine('review', { args: { comment: true }, script: {
    detect: { baseRef: 'main', files: [FILE], spec: '', branch: 'feat/x', head: 'abc9999' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['errors'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: lensOnce([finding({ severity: 'High' })]),
    dedup: { groups: [] },
    verify: (/** @type {{ callIndex: number }} */ { callIndex }) => (callIndex === 0 ? { ...split, refuted: true } : split),
    'diff-lines': { lines: [`HUNK\t+10,5\tb/${FILE}`, 'HUNKS-END'], reason: '' },
    'pr-comments': { posted: 1, reason: 'PR #9' },
    synthesis: null,
    '*': null,
  } })
  assert.equal(filedRecord(run).sorting.doubtful, 1, 'a split panel leaves the finding Suspected')
  assert.equal(calls(run, 'pr-comments').length, 0)
  assert.match(run.report, /doubtful: not confirmed \(suspected\)/)
})

test('comment: a changed-lines answer that is empty with a reason judges nothing — the defects are still posted', async () => {
  const run = await review({ comment: true }, { lines: [], reason: 'fatal: bad revision' })
  assert.equal(postedBodies(run).length, 2)
  assert.equal(filedRecord(run).sorting.inDiffJudged, false)
  assert.match(run.report, /⚠️ the diff-lines agent died, answered unreadably, or its command did not finish/)
})
