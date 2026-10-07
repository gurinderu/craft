// Deferred findings (realm @nick/craft, node #204) across the edges a cold review found, through the real
// review engine (lib/engine-harness.mjs): a launcher-passed question without `kind`, a `deferred` prior
// carried between rounds like a `rejected` one, and an open question that records no deferral.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { fingerprint } from './run-record.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const TITLE = 'unwrap in parser may panic'

/** @param {string} severity */
const finding = severity => ({
  severity, title: TITLE, file: 'src/parse.rs', line: 12, why: 'panics on bad input', fix: 'return an error',
  blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: 'parse', whereChecked: '',
})

// A question record as a launching session passes it when it leaves `kind` out.
const BARE_QUESTION = {
  id: 'question-1a2b3c4d5e', title: TITLE, scope: 'src/parse.rs', status: 'active',
  body: 'decide once the parser is replaced in the v2 rewrite', date: '2026-10-02', author: 'alice', commit: 'abc1234', deferred: true,
  links: ['https://x/pr/3#c9'],
}

/** A prior ledger row deferred in round 1. @param {string} severity */
const deferredRow = severity => {
  const base = {
    file: 'src/parse.rs', line: 12, symbol: 'parse', severity, tier: 'confirmed', disposition: 'deferred', source: 'safety', ruleId: 'ERR-001', title: TITLE,
    why: 'panics on bad input · KNOWN AND DEFERRED: decide once the parser is replaced — alice, 2026-10-02, https://x/pr/3#c9 (question question-1a2b3c4d5e)',
  }
  return { fp: fingerprint(base), ...base }
}

/** @param {{ findings: any[], prior?: any[], carry?: any, scope?: any, adjudicate?: any, recall?: any }} o */
const scriptFor = ({ findings, prior, carry = { changed: false, reason: 'unchanged' }, scope = { unchanged: [BARE_QUESTION.id], missing: [], reason: '' }, adjudicate = { status: 'still-open', note: '', attack: '', currentLine: 12 }, recall = null }) => ({
  detect: { baseRef: 'main', files: ['src/parse.rs'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': prior
    ? { found: true, round: 1, head: 'abc0000', ledgerCount: prior.length, priorFindings: prior.length, reason: '', ledger: prior, sameFpBasis: true }
    : { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? findings : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  adjudicate,
  redteam: { defeated: false, attack: '' },
  carry,
  'decision-scope': scope,
  'memory-recall': recall,
  synthesis: null,
  '*': null,
})

/** @param {any} run */
const liveRows = run => /** @type {any[]} */ ((filedRecord(run) || {}).ledger || []).filter(e => e.file === 'src/parse.rs' && e.disposition !== 'closed')

test('a launcher-passed question without `kind` is read as a question by its `question-` id: Known and deferred, ledger deferred', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [BARE_QUESTION] }, script: scriptFor({ findings: [finding('Medium')] }) })
  assert.match(run.report, /## Known and deferred \(open question — not in the verdict\)/)
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.deepEqual(liveRows(run).map(e => e.disposition), ['deferred'])
})

test('a question kind spelled in another casing is still a question', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [{ ...BARE_QUESTION, id: 'q-1', kind: 'Question' }] }, script: scriptFor({ findings: [finding('Medium')], scope: { unchanged: ['q-1'], missing: [], reason: '' } }) })
  assert.match(run.report, /## Known and deferred/)
  assert.deepEqual(liveRows(run).map(e => e.disposition), ['deferred'])
})

for (const [label, args] of /** @type {const} */ ([['priorDecisions: []', { priorDecisions: [] }], ['a dead recall', {}]])) {
  test(`round 2: a deferred prior is carried like a rejected one with ${label} — Known and deferred, out of the verdict, still deferred`, async () => {
    const run = await runEngine('review', { args, script: scriptFor({ findings: [finding('Medium')], prior: [deferredRow('Medium')] }) })
    assert.equal(run.calls.filter(c => /^adjudicate/.test(String(c.label))).length, 0, 'a deferred prior is settled, not re-adjudicated')
    assert.match(run.report, /## Known and deferred \(open question — not in the verdict\)\n- Medium[^\n]*KNOWN AND DEFERRED/)
    assert.match(run.report, /✅ Approve/)
    assert.deepEqual(liveRows(run).map(e => e.disposition), ['deferred'])
  })
}

/** @param {any} run */
const adjudications = run => run.calls.filter((/** @type {{ label: unknown }} */ c) => /^adjudicate/.test(String(c.label))).length
/** @param {any} run */
const tombstones = run => /** @type {any[]} */ ((filedRecord(run) || {}).ledger || []).filter(e => e.file === 'src/parse.rs' && e.disposition === 'closed')

test('round 2: a deferred prior whose code changed goes to the adjudicator — fixed, it is resolved with a tombstone, not reported open', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [] }, script: scriptFor({ findings: [], prior: [deferredRow('Medium')], carry: { changed: true, reason: 'touched' }, adjudicate: { status: 'resolved', note: 'fixed', attack: '', currentLine: 12, invariant: 'no panic on bad input' } }) })
  assert.equal(adjudications(run), 1, 'a changed deferred prior is adjudicated, not reopened unseen')
  assert.doesNotMatch(run.report, /## Known and deferred/)
  assert.doesNotMatch(run.report, /reopened: dismissed as deferred/)
  assert.match(run.report, /✅ Approve/)
  assert.deepEqual(liveRows(run), [])
  assert.match(String(tombstones(run)[0]?.why), /^resolved in round 2/)
})

test('round 2: a deferred prior whose code changed and whose defect is still present stays open and counts', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [] }, script: scriptFor({ findings: [], prior: [deferredRow('Medium')], carry: { changed: true, reason: 'touched' } }) })
  assert.equal(adjudications(run), 1)
  assert.doesNotMatch(run.report, /## Known and deferred/)
  assert.match(run.report, /⚠️ Warning/)
  assert.deepEqual(liveRows(run).map(e => e.disposition), ['open'])
})

test('round 2: a rejected prior whose code changed is still reopened without the adjudicator (unchanged behaviour)', async () => {
  const rejected = { ...deferredRow('Medium'), disposition: 'rejected', why: 'panics on bad input · REJECTED BEFORE: validated upstream' }
  const run = await runEngine('review', { args: { priorDecisions: [] }, script: scriptFor({ findings: [], prior: [rejected], carry: { changed: true, reason: 'touched' } }) })
  assert.equal(adjudications(run), 0)
  assert.match(run.report, /reopened: dismissed as rejected, but the code around it changed/)
})

const ANSWERED_DECISION = {
  id: 'decision-9a8b7c6d5e', kind: 'decision', title: 'unrelated cache sizing is fine', scope: 'src/cache.rs', status: 'active',
  body: 'bounded elsewhere', date: '2026-10-03', author: 'bob', commit: 'abc1234', links: [],
}
const recallOf = (/** @type {any[]} */ decisions, /** @type {any[]} */ questions) => ({ backend: 'repo', why: 'files in the repo', decisions, questions, stale: [] })

// Only an explicit link releases a carried deferral; a question's absence from the records never does
// (realm @nick/craft, node #204): a recall need not return questions, and another backend may hold the deferral.
for (const [label, args, recall] of /** @type {const} */ ([
  ['the launcher passed records without the question', { priorDecisions: [ANSWERED_DECISION] }, null],
  ['the engine\'s recall returned records without the question', {}, recallOf([ANSWERED_DECISION], [])],
  ['the engine\'s recall returned nothing at all', {}, recallOf([], [])],
  ['the recall returned the question no longer marked deferred', {}, recallOf([], [{ ...BARE_QUESTION, deferred: false }])],
])) {
  test(`round 2: a carried deferred prior stays carried when ${label}`, async () => {
    const run = await runEngine('review', { args, script: scriptFor({ findings: [], prior: [deferredRow('Medium')], recall }) })
    assert.equal(adjudications(run), 0, 'absence is no release — still carried as deferred')
    assert.match(run.report, /## Known and deferred/)
    assert.deepEqual(liveRows(run).map(e => e.disposition), ['deferred'])
  })
}

for (const [label, args, recall] of /** @type {const} */ ([
  ['a recalled decision supersedes the question', {}, recallOf([{ ...ANSWERED_DECISION, links: [`supersedes: ${BARE_QUESTION.id}`] }], [BARE_QUESTION])],
  ['a recalled decision answers the question', {}, recallOf([{ ...ANSWERED_DECISION, links: [`answers: ${BARE_QUESTION.id}`] }], [])],
  ['a passed decision answers the question', { priorDecisions: [{ ...ANSWERED_DECISION, links: [`answers: ${BARE_QUESTION.id}`] }] }, null],
])) {
  test(`round 2: a carried deferred prior is released to the adjudicator when ${label}`, async () => {
    const run = await runEngine('review', { args, script: scriptFor({ findings: [], prior: [deferredRow('Medium')], recall }) })
    assert.equal(adjudications(run), 1, 'no longer carried as deferred — adjudicated like an ordinary prior')
    assert.doesNotMatch(run.report, /## Known and deferred/)
    assert.match(run.report, /⚠️ Warning/)
  })
}

test('round 2: a carried deferred prior whose question the recall still returns stays carried', async () => {
  const run = await runEngine('review', { args: {}, script: scriptFor({ findings: [], prior: [deferredRow('Medium')], recall: recallOf([], [BARE_QUESTION]) }) })
  assert.equal(adjudications(run), 0)
  assert.match(run.report, /## Known and deferred/)
  assert.deepEqual(liveRows(run).map(e => e.disposition), ['deferred'])
})

test('round 2: a High deferred prior is not settled — it goes to the adjudicator', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [] }, script: scriptFor({ findings: [], prior: [deferredRow('High')] }) })
  assert.ok(run.calls.some(c => /^adjudicate/.test(String(c.label))), 'a Critical/High deferred prior is re-adjudicated')
  assert.match(run.report, /⛔ Block/)
})

test('an open question without `deferred: true` records no deferral, even with a commit: the finding is raised normally, never labelled deferred', async () => {
  const open = { ...Object.fromEntries(Object.entries(BARE_QUESTION).filter(([k]) => k !== 'deferred')), kind: 'question' }
  const run = await runEngine('review', { args: { priorDecisions: [open] }, script: scriptFor({ findings: [finding('Medium')] }) })
  assert.doesNotMatch(run.report, /Known and deferred|Deferred before|KNOWN AND DEFERRED/)
  assert.match(run.report, /⚠️ Warning/)
  assert.deepEqual(liveRows(run).map(e => e.disposition), ['open'])
})
