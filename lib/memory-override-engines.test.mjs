// The fresh-word override through the engines (realm @nick/craft, node #229): a passed copy newer than
// the store's inactive copy and than the active record superseding it is applied by adversarial-review
// and forwarded by rust-audit's own merge, the successor's link to it dropped; one not newer than the
// successor is held back, named by it. And a carried deferral is released through the review engine
// when a recalled record answers the question by the store's own id (realm @nick/craft, node #226).
import crypto from 'node:crypto'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { fingerprint } from './run-record.mjs'

/** @param {string} kind @param {string} title @param {string} scope */
const skillId = (kind, title, scope) => `${kind}-${crypto.createHash('sha256').update(`${kind}\n${title}\n${scope}`).digest('hex').slice(0, 10)}`

const TITLE = 'float arithmetic on amounts'
const A = { kind: 'decision', title: TITLE, body: 'the fresh word', scope: 'src', date: '2026-10-05', author: 'bob', commit: 'def5678', links: ['https://x/pr/7#c1'] }
const A_ID = skillId('decision', TITLE, 'src')
const B = { id: 'decision-bbbbbbbbbb', kind: 'decision', title: 'amounts use fixed point now', body: 'the successor', scope: 'src', status: 'active', author: 'alice', commit: 'def5678', links: [`supersedes: ${A_ID}`] }
/** @param {string} bDate */
const recall = bDate => ({ backend: 'mcp', why: 'w', decisions: [{ ...B, date: bDate }], inactive: [{ id: A_ID, kind: 'decision', title: TITLE, scope: 'src', status: 'superseded', date: '2026-10-01' }] })

const adversarial = (/** @type {unknown} */ memory) => ({
  scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/pay.rs'], notes: 'x' },
  'index-warmup': { indexed: false, notes: 'x' },
  review: { findings: [{ title: TITLE, file: 'src/pay.rs', line: 4, severity: 'medium', description: 'd', fix: 'f', whereChecked: '' }] },
  'coverage-critic': { findings: [] },
  'decision-scope': (/** @type {{ prompt: string }} */ { prompt }) => ({ unchanged: [...prompt.matchAll(/echo '([^']+)' \$\?/g)].map(m => m[1]), reason: '' }),
  'memory-recall': memory,
  'log-run': { ok: true },
  '*': (/** @type {{ opts: { label?: string } }} */ { opts }) => (/^verify/.test(String(opts.label)) ? { refuted: false, premiseSupported: true, reasoning: 'ok', severity: 'medium' } : null),
})

test('adversarial-review: a passed copy newer than the inactive copy and the successor is applied, the override named', async () => {
  const v = (await runEngine('adversarial-review', { args: { priorDecisions: [A] }, script: adversarial(recall('2026-10-03')) })).reportValue
  assert.equal(v.priorDecisionsNotApplied, undefined)
  assert.equal(v.rejectedBefore.length, 1)
  assert.match(v.rejectedBefore[0].description, new RegExp(`the fresh word[^\\n]*\\(decision ${A_ID}\\)`))
  assert.match(v.memory.why, new RegExp(`passed decision #0 \\(${A_ID}\\) applied over a superseded record of 2026-10-01 and ${B.id} \\(active, 2026-10-03\\): newer`))
})

test('adversarial-review: a passed copy not newer than the successor is held back, named by it, never on the memory line', async () => {
  const v = (await runEngine('adversarial-review', { args: { priorDecisions: [A] }, script: adversarial(recall('2026-10-06')) })).reportValue
  assert.ok(!v.rejectedBefore?.length)
  assert.match(String(v.priorDecisionsNotApplied), new RegExp(`passed decision #0 \\(${A_ID}\\) not applied: held by ${B.id} \\(active, 2026-10-06\\)`))
  assert.doesNotMatch(v.memory.why, /applied over/)
})

const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
/** @param {unknown} memory */
const audit = memory => runEngine('rust-audit', { args: { priorDecisions: [A] }, script: {
  scout: { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'a' }], changedCrates: [{ name: 'a', path: 'a' }], edges: [], repoRoot: '/r', notes: 'n' },
  workflow: () => '## Verdict\n✅ Approve', synthesis: 'the audit body', 'memory-recall': memory, '*': green,
} })

test('rust-audit: its own merge forwards the newer passed copy and the successor without its link to it', async () => {
  const run = await audit(recall('2026-10-03'))
  const nested = run.calls.filter(c => c.label === 'workflow')
  assert.ok(nested.length >= 1)
  for (const c of nested) {
    const list = /** @type {any[]} */ (/** @type {any[]} */ (c.argv)[1].priorDecisions)
    assert.deepEqual(list.map(d => d.id), [B.id, A_ID])
    assert.deepEqual(list[0].links, [])
    assert.deepEqual(/** @type {any[]} */ (c.argv)[1]._memoryParts, { recalled: 1, passed: 1 })
  }
  assert.equal(run.report.match(/applied over a superseded record of 2026-10-01 and decision-bbbbbbbbbb \(active, 2026-10-03\): newer/g)?.length, 1)
})

test('rust-audit: a passed copy not newer than the successor is not forwarded, named by it once', async () => {
  const run = await audit(recall('2026-10-06'))
  for (const c of run.calls.filter(x => x.label === 'workflow')) assert.deepEqual(/** @type {any[]} */ (/** @type {any[]} */ (c.argv)[1].priorDecisions).map(d => d.id), [B.id])
  assert.equal(run.report.match(new RegExp(`passed decision #0 \\(${A_ID}\\) not applied: held by ${B.id} \\(active, 2026-10-06\\)`, 'g'))?.length, 1)
  assert.doesNotMatch(run.report, /applied over/)
})

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const Q_TITLE = 'unwrap in parser may panic'
const Q_ID = skillId('question', Q_TITLE, 'src/parse.rs')
const QUESTION = { id: 'node-5', kind: 'question', title: Q_TITLE, scope: 'src/parse.rs', status: 'active', body: 'decide later', date: '2026-10-02', author: 'alice', commit: 'abc1234', deferred: true, links: [] }
const ANSWER = { id: 'node-9', kind: 'decision', title: 'parser input is trusted', scope: 'src/parse.rs', status: 'active', body: 'answered', date: '2026-10-04', author: 'alice', commit: 'abc1234', links: ['answers: node-5'] }
const row = (() => {
  const base = {
    file: 'src/parse.rs', line: 12, symbol: 'parse', severity: 'Medium', tier: 'confirmed', disposition: 'deferred', source: 'safety', ruleId: 'ERR-001', title: Q_TITLE,
    why: `panics · KNOWN AND DEFERRED: decide later — alice, 2026-10-02, no link (question ${Q_ID})`,
    deferral: { id: Q_ID, reason: 'decide later', who: 'alice', when: '2026-10-02', link: '', commit: 'abc1234' },
  }
  return { fp: fingerprint(base), ...base }
})()
const review = (/** @type {unknown[]} */ decisions) => runEngine('review', { args: {}, script: {
  detect: { baseRef: 'main', files: ['src/parse.rs'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: true, round: 1, head: 'abc0000', ledgerCount: 1, priorFindings: 1, reason: '', ledger: [row], sameFpBasis: true },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: { lens: 'safety', findings: [] },
  dedup: { groups: [] },
  verify: () => UPHELD,
  adjudicate: { status: 'still-open', note: '', attack: '', currentLine: 12 },
  redteam: { defeated: false, attack: '' },
  carry: { changed: false, reason: 'unchanged' },
  'decision-scope': { unchanged: [Q_ID], missing: [], reason: '' },
  'memory-recall': { backend: 'mcp', why: 'w', decisions, questions: [QUESTION] },
  synthesis: null,
  '*': null,
} })
/** @param {any} run */
const adjudications = run => run.calls.filter((/** @type {{ label: unknown }} */ c) => /^adjudicate/.test(String(c.label))).length

test('review: a recalled decision answering the question by the store\'s own id releases the carried deferral', async () => {
  const released = await review([ANSWER])
  assert.equal(adjudications(released), 1, 'released — adjudicated like an ordinary prior')
  assert.doesNotMatch(released.report, /## Known and deferred/)
  const kept = await review([{ ...ANSWER, links: [] }])
  assert.equal(adjudications(kept), 0, 'no link, no release')
  assert.match(kept.report, /## Known and deferred/)
})
