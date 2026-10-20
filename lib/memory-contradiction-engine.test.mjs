// A finding going against project memory through the real engines (realm @nick/craft, node #282;
// lib/engine-harness.mjs): the one decision judge marks it, review's sorting posts it as a defect though a
// doubt sign holds, the report names the record, and both engines' run records count it.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { filedRecord, runEngine } from './engine-harness.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const FILE = 'crates/node/src/retry.rs'
const DECISION = { id: 'decision-cap', kind: 'decision', title: 'retries stay capped at three', scope: FILE, reason: 'a dead peer must not spin', who: 'nick', when: '2026-10-01', link: '', commit: 'abc1234', line: 30, lens: 'compat' }
const FINDING = { severity: 'Medium', title: 'retry loop has no ceiling', file: FILE, line: 12, why: 'a dead peer spins forever', fix: 'cap it', blastRadius: '', source: 'compat', ruleId: '', symbol: 'retry', whereChecked: '' }

/** @param {boolean} violates */
const judge = violates => (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: JSON.parse(String(prompt.match(/^\[\{"pair".*\]$/m)?.[0])).map((/** @type {{ pair: number }} */ p) => ({ pair: p.pair, same: false, violates, why: violates ? 'the cap was removed' : 'another concern' })) })

/** @param {unknown} matcher @param {Record<string, unknown>} [args] */
const review = (matcher, args = { comment: true }) => runEngine('review', { args: { priorDecisions: [DECISION], ...args }, script: {
  detect: { baseRef: 'main', files: [FILE], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['compat'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'compat', findings: callIndex === 0 ? [FINDING] : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  'decision-match': matcher,
  'diff-lines': { lines: [`HUNK\t+10,5\tb/${FILE}`, 'HUNKS-END'], reason: '' },
  'pr-comments': { posted: 1, reason: 'PR #9' },
  'memory-recall': null,
  synthesis: null,
  '*': null,
} })
/** @param {any} run @param {string} label */
const calls = (run, label) => run.calls.filter((/** @type {{ label: unknown }} */ c) => c.label === label)

test('review: a compat finding the judge says goes against a decision is posted as a defect, named, and counted', async () => {
  const run = await review(judge(true))
  assert.equal(calls(run, 'decision-match').length, 1, 'one judge call, no new agent')
  assert.match(run.report, /## Contradicts project memory — a defect, whatever the doubt signs say\n- Medium · `crates\/node\/src\/retry\.rs:12` · retry loop has no ceiling · goes against decision decision-cap: the cap was removed/)
  assert.doesNotMatch(run.report, /## Doubtful — for the reviewer/)
  assert.equal(calls(run, 'pr-comments').length, 1)
  const rec = filedRecord(run)
  assert.deepEqual([rec.sorting.defect, rec.sorting.doubtful], [1, 0])
  assert.equal(rec.memoryContradictions.count, 1)
  assert.equal(rec.memoryContradictions.doubtSignsAlone, 1, 'the compat lens alone would have sent it to the reviewer')
  assert.deepEqual(rec.memoryContradictions.findings.map((/** @type {any} */ f) => [f.record, f.toPr, f.doubtSigns]), [['decision-cap', true, ['raised by the compat lens']]])
  assert.match(String(rec.memoryContradictions.findings[0].fp), /^[0-9a-f]{8}$/)
})

test('review: without the mark the compat finding stays doubtful; without comment the count is kept, nothing posted', async () => {
  const no = await review(judge(false))
  assert.match(no.report, /## Doubtful — for the reviewer, not posted/)
  assert.equal(filedRecord(no).memoryContradictions.count, 0)
  const quiet = await review(judge(true), {})
  const rec = filedRecord(quiet).memoryContradictions
  assert.deepEqual([rec.count, rec.inDiffJudged, rec.findings[0].toPr], [1, false, false])
})

test('adversarial-review: the judge marks the finding and the run record counts it', async () => {
  const run = await runEngine('adversarial-review', { args: { priorDecisions: [DECISION] }, script: {
    scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: [FILE], notes: 'x' },
    'index-warmup': { indexed: false, notes: 'x' },
    review: { findings: [{ title: 'retry loop has no ceiling', file: FILE, line: 25, severity: 'medium', description: 'spins', fix: 'f', whereChecked: '' }] },
    'coverage-critic': { findings: [] },
    'decision-match': judge(true),
    'memory-recall': null,
    'log-run': { ok: true },
    '*': (/** @type {{ opts: { label?: string } }} */ { opts }) => (/^verify/.test(String(opts.label)) ? { refuted: false, premiseSupported: true, reasoning: 'ok', severity: 'medium' } : null),
  } })
  assert.equal(run.reportValue.confirmed[0]?.memoryContradicts?.id, 'decision-cap')
  assert.match(String(run.reportValue.contradictsMemory), /^## Contradicts project memory — a defect, whatever the doubt signs say\n- medium · `crates\/node\/src\/retry\.rs:25` · retry loop has no ceiling · goes against decision decision-cap: the cap was removed$/)
  const rec = filedRecord(run).memoryContradictions
  assert.deepEqual([rec.count, rec.inDiffJudged, rec.findings[0].toPr], [1, false, null], 'this engine posts nothing: toPr is null, not false')
})

/** A finding at the decision's own site (a sure match), the scope check answering `unchanged`. @param {string[]} unchanged @param {string[]} prompts */
const sureRun = (unchanged, prompts) => runEngine('review', { args: { priorDecisions: [DECISION], comment: true }, script: {
  detect: { baseRef: 'main', files: [FILE], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['compat'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'compat', findings: callIndex === 0 ? [{ ...FINDING, line: 31 }] : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  'decision-scope': { unchanged, missing: [], reason: '' },
  'decision-match': (/** @type {{ prompt: string }} */ c) => { prompts.push(c.prompt); return judge(true)(c) },
  'diff-lines': { lines: [`HUNK\t+10,25\tb/${FILE}`, 'HUNKS-END'], reason: '' },
  'pr-comments': { posted: 1, reason: 'PR #9' },
  'memory-recall': null,
  synthesis: null,
  '*': null,
} })

test('review: a sure match re-raised because its scope changed is asked about violates in the same one judge call', async () => {
  /** @type {string[]} */
  const prompts = []
  const run = await sureRun([], prompts)
  assert.equal(prompts.length, 1, 'one judge call')
  assert.equal(calls(run, 'decision-scope').length, 1, 'one scope check, before the judge')
  assert.match(run.report, /raised again: the code in crates\/node\/src\/retry\.rs changed since abc1234/)
  assert.match(run.report, /## Contradicts project memory[^\n]*\n- Medium · `crates\/node\/src\/retry\.rs:31` · [^\n]* · goes against decision decision-cap: the cap was removed/)
  assert.equal(filedRecord(run).memoryContradictions.count, 1)
})

test('review: a sure match its unchanged scope sets aside asks no judge, as before', async () => {
  /** @type {string[]} */
  const prompts = []
  const run = await sureRun([DECISION.id], prompts)
  assert.equal(prompts.length, 0)
  assert.match(run.report, /## Rejected before/)
  assert.equal(filedRecord(run).memoryContradictions.count, 0)
})
