// Deferred findings as open questions (realm @nick/craft, node #204), through the real review and
// adversarial-review engines (lib/engine-harness.mjs): a finding an active `question` record answers
// is listed under "Known and deferred", kept out of the verdict and persisted as `deferred`; it is
// raised again on Critical/High, on a changed scope, or when the question's commit is unknown — the
// same machinery as a set-aside decision, which keeps behaving as before.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }

/** @param {string} severity @param {Record<string, unknown>} [over] */
const finding = (severity, over = {}) => ({
  severity, title: 'unwrap in parser may panic', file: 'src/parse.rs', line: 12, why: 'panics on bad input', fix: 'return an error',
  blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: 'parse', whereChecked: '', ...over,
})

// A question record in the memory skill's shape, as record-question writes it for a deferred finding.
const QUESTION = {
  id: 'question-1a2b3c4d5e', kind: 'question', title: 'unwrap in parser may panic', scope: 'src/parse.rs', status: 'active',
  body: 'decide once the parser is replaced in the v2 rewrite', date: '2026-10-02', author: 'alice', commit: 'abc1234',
  links: ['https://x/pr/3#c9'],
}

/** @param {{ findings: any[], scope?: any, recall?: unknown }} o */
const scriptFor = ({ findings, scope = { unchanged: [QUESTION.id], missing: [], reason: '' }, recall = null }) => ({
  detect: { baseRef: 'main', files: ['src/parse.rs'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? findings : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  'decision-scope': scope,
  'memory-recall': recall,
  synthesis: null,
  '*': null,
})

/** @param {any} run */
const ledgerOf = run => /** @type {any[]} */ ((filedRecord(run) || {}).ledger || [])

test('deferred question: an unchanged-scope Medium is listed under Known and deferred, out of the verdict, persisted as deferred', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [QUESTION] }, script: scriptFor({ findings: [finding('Medium')] }) })
  assert.match(run.report, /## Known and deferred \(open question — not in the verdict\)/)
  assert.match(run.report, /KNOWN AND DEFERRED: decide once the parser is replaced in the v2 rewrite — alice, 2026-10-02, https:\/\/x\/pr\/3#c9 \(question question-1a2b3c4d5e\)/)
  assert.doesNotMatch(run.report, /## Rejected before/, 'a deferred question is not a rejection')
  assert.doesNotMatch(run.report, /## Prior decisions not applied/, 'a question record is accepted, not refused')
  assert.match(run.report, /✅ Approve/)
  const row = ledgerOf(run).find(e => e.file === 'src/parse.rs')
  assert.equal(row?.disposition, 'deferred')
  const check = run.calls.find(c => c.label === 'decision-scope')
  assert.match(String(check?.prompt), /git diff --quiet 'abc1234' -- 'src\/parse\.rs'; echo 'question-1a2b3c4d5e' \$\?/)
})

test('deferred question: a Critical is raised again normally, the question named', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [QUESTION] }, script: scriptFor({ findings: [finding('Critical')] }) })
  assert.doesNotMatch(run.report, /## Known and deferred/)
  assert.match(run.report, /⛔ Block/)
  assert.match(run.report, /Deferred before \(question question-1a2b3c4d5e, alice, 2026-10-02\) — raised again: a Critical\/High finding is never set aside/)
})

test('deferred question: a scope changed since the question\'s commit raises the finding again', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [QUESTION] }, script: scriptFor({ findings: [finding('Medium')], scope: { unchanged: [], missing: [], reason: '' } }) })
  assert.doesNotMatch(run.report, /## Known and deferred/)
  assert.match(run.report, /⚠️ Warning/)
  assert.match(run.report, /changed since abc1234/)
  assert.equal(ledgerOf(run).find(e => e.file === 'src/parse.rs')?.disposition, 'open')
})

test('deferred question: a commit the repo does not know raises the finding and names the question', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [QUESTION] }, script: scriptFor({ findings: [finding('Medium')], scope: { unchanged: [], missing: [QUESTION.id], reason: '' } }) })
  assert.doesNotMatch(run.report, /## Known and deferred/)
  assert.match(run.report, /## Prior decisions not applied\n- ⚠️ question question-1a2b3c4d5e: commit abc1234 not found in this repo — raised normally/)
})

test('deferred question: a decision and a question side by side — each in its own section; a lesson is still refused by name', async () => {
  const decision = { ...QUESTION, id: 'decision-46833ecec3', kind: 'decision', title: 'parse rejects empty input', body: 'empty input is an error by contract' }
  const lesson = { ...QUESTION, id: 'lesson-1', kind: 'lesson' }
  const run = await runEngine('review', {
    args: { priorDecisions: [QUESTION, decision, lesson] },
    script: scriptFor({ findings: [finding('Medium'), finding('Low', { title: 'parse rejects empty input', line: 30, symbol: 'parse_empty' })], scope: { unchanged: [QUESTION.id, decision.id], missing: [], reason: '' } }),
  })
  assert.match(run.report, /## Rejected before \(set aside — not in the verdict\)\n- Low[^\n]*REJECTED BEFORE: empty input is an error by contract/)
  assert.match(run.report, /## Known and deferred \(open question — not in the verdict\)\n- Medium[^\n]*KNOWN AND DEFERRED/)
  assert.match(run.report, /decision #2 \(lesson-1\) is a "lesson" record, not a decision or a question/)
  const rows = ledgerOf(run)
  assert.deepEqual(rows.map(e => e.disposition).sort(), ['deferred', 'rejected'])
})

test('deferred question: a deferral recorded before as a decision still works as a decision', async () => {
  const old = { ...QUESTION, id: 'decision-0ld0ld0ld0', kind: 'decision', body: 'deferred: out of scope for this PR' }
  const run = await runEngine('review', { args: { priorDecisions: [old] }, script: scriptFor({ findings: [finding('Medium')], scope: { unchanged: [old.id], missing: [], reason: '' } }) })
  assert.match(run.report, /## Rejected before[\s\S]*REJECTED BEFORE: deferred: out of scope for this PR — alice, 2026-10-02, https:\/\/x\/pr\/3#c9 \(decision decision-0ld0ld0ld0\)/)
  assert.doesNotMatch(run.report, /## Known and deferred/)
  assert.equal(ledgerOf(run).find(e => e.file === 'src/parse.rs')?.disposition, 'rejected')
})

test('deferred question: the engine\'s own recall asks for active questions and applies them; the memory line counts them apart', async () => {
  const run = await runEngine('review', { args: {}, script: scriptFor({ findings: [finding('Medium')], recall: { backend: 'repo', why: 'w', decisions: [], questions: [QUESTION] } }) })
  const prompt = String(run.calls.find(c => c.label === 'memory-recall')?.prompt)
  assert.match(prompt, /kind question/)
  assert.match(run.report, /## Known and deferred[\s\S]*KNOWN AND DEFERRED/)
  assert.match(run.report, /- memory: recalled 0 decision\(s\) and 1 open question\(s\) from repo \(w\)/)
})

test('deferred question: a question recalled without a kind field is still read as a question', async () => {
  const bare = Object.fromEntries(Object.entries(QUESTION).filter(([k]) => k !== 'kind'))
  const run = await runEngine('review', { args: {}, script: scriptFor({ findings: [finding('Medium')], recall: { backend: 'repo', why: 'w', decisions: [], questions: [bare] } }) })
  assert.match(run.report, /## Known and deferred/)
})

const ADV_Q = { ...QUESTION, scope: 'src' }
/** @param {string} severity */
const advScript = severity => ({
  scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/parse.rs'], notes: 'x' },
  'index-warmup': { indexed: false, notes: 'x' },
  review: { findings: [{ title: 'unwrap in parser may panic', file: 'src/parse.rs', line: 4, severity, description: 'd', fix: 'f', whereChecked: '' }] },
  'coverage-critic': { findings: [] },
  'decision-scope': { unchanged: [ADV_Q.id], missing: [], reason: '' },
  'log-run': { ok: true },
  '*': (/** @type {{ opts: { label?: string } }} */ { opts }) => (/^verify/.test(String(opts.label)) ? { refuted: false, premiseSupported: true, reasoning: 'ok', severity } : null),
})

test('adversarial-review deferred question: returned under knownDeferred, not rejectedBefore, out of the verdict', async () => {
  const v = (await runEngine('adversarial-review', { args: { priorDecisions: [ADV_Q] }, script: advScript('medium') })).reportValue
  assert.equal(v.verdict, 'Approve')
  assert.equal(v.rejectedBefore, undefined)
  assert.equal(v.knownDeferred.length, 1)
  assert.match(v.knownDeferred[0].description, /KNOWN AND DEFERRED: decide once the parser is replaced/)
  const high = (await runEngine('adversarial-review', { args: { priorDecisions: [ADV_Q] }, script: advScript('high') })).reportValue
  assert.equal(high.verdict, 'Block')
  assert.equal(high.knownDeferred, undefined)
})
