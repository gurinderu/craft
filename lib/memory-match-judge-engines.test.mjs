// Matching a remembered record to a finding the model reworded (realm @nick/craft, node #230), through
// the real review and adversarial-review engines (lib/engine-harness.mjs): a record anchored by file,
// line (±15) and lens answers a finding without a judge; a disputed pair goes to ONE cheap judge whose
// verdict and one-line why decide, and whose death raises the finding, named once; a record without
// line and lens keeps the title-overlap rule. An overriding passed record is tried before its successor.
import crypto from 'node:crypto'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const FILE = 'src/admin/groups.rs'

/** A finding of this round, reworded from the recorded title. @param {Record<string, unknown>} [over] */
const finding = (over = {}) => ({
  severity: 'Medium', title: 'Nothing stops an AdminSecurityGroup from being deleted while a VM references it', file: FILE, line: 43,
  why: 'a VM keeps a dangling group id', fix: 'refuse the delete while referenced', blastRadius: '', source: 'safety', ruleId: '', symbol: 'delete_group', whereChecked: '', ...over,
})

// The deferred question recorded in round N, carrying the finding's anchor.
const QUESTION = {
  id: 'question-aaaaaaaaaa', kind: 'question', title: 'Nothing guards deletion of a referenced AdminSecurityGroup', scope: FILE, status: 'active',
  body: 'decide with the VM lifecycle rework', date: '2026-10-02', author: 'alice', commit: 'abc1234', deferred: true, links: ['https://x/pr/731#c1'],
  line: 41, lens: 'safety',
}

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

/** @param {{ findings: any[], judge?: unknown }} o */
const reviewScript = ({ findings, judge = null }) => ({
  detect: { baseRef: 'main', files: [FILE], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety', 'errors'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  // Each lens reports its own findings once (the engine stamps `source` with the lens that ran).
  lens: lensOnce(findings),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  'decision-scope': (/** @type {{ prompt: string }} */ { prompt }) => ({ unchanged: [...prompt.matchAll(/echo '([^']+)' \$\?/g)].map(m => m[1]), missing: [], reason: '' }),
  'decision-match': judge,
  'memory-recall': null,
  synthesis: null,
  '*': null,
})

/** @param {unknown[]} records @param {any[]} findings @param {unknown} [judge] */
const review = (records, findings, judge = null) => runEngine('review', { args: { priorDecisions: records }, script: reviewScript({ findings, judge }) })
/** @param {any} run */
const judgeCalls = run => run.calls.filter((/** @type {{ label: unknown }} */ c) => c.label === 'decision-match')

test('review: a deferred question reworded next round on the same file, line ±3 and lens is Known and deferred without a judge', async () => {
  const run = await review([QUESTION], [finding()])
  assert.match(run.report, /## Known and deferred \(open question — not in the verdict\)\n- Medium[^\n]*KNOWN AND DEFERRED: decide with the VM lifecycle rework[^\n]*matched by file:line\+lens/)
  assert.equal(judgeCalls(run).length, 0, 'an anchored pair needs no judge')
  assert.match(run.report, /✅ Approve/)
})

test('review: reworded at a different line but the same lens — the judge is called and its `same: true` sets the finding aside with its why', async () => {
  const run = await review([QUESTION], [finding({ line: 120 })], { verdicts: [{ pair: 0, same: true, why: 'the same missing reference check on delete' }] })
  const calls = judgeCalls(run)
  assert.equal(calls.length, 1)
  assert.match(String(calls[0].prompt), /Nothing guards deletion of a referenced AdminSecurityGroup/)
  assert.match(String(calls[0].prompt), /Nothing stops an AdminSecurityGroup from being deleted/)
  assert.equal(calls[0].opts.effort, 'low')
  assert.match(run.report, /## Known and deferred[^\n]*\n- Medium[^\n]*matched by judge: the same missing reference check on delete/)
})

test('review: the judge saying `same: false` raises the finding normally', async () => {
  const run = await review([QUESTION], [finding({ line: 120 })], { verdicts: [{ pair: 0, same: false, why: 'a different code path' }] })
  assert.equal(judgeCalls(run).length, 1)
  assert.doesNotMatch(run.report, /## Known and deferred/)
  assert.match(run.report, /⚠️ Warning/)
})

test('review: two different findings near each other, different lens, low overlap — the judge decides', async () => {
  const other = finding({ title: 'Group listing loads every VM into memory', line: 45, source: 'errors' })
  const run = await review([QUESTION], [other], { verdicts: [{ pair: 0, same: false, why: 'a listing cost, not a delete guard' }] })
  const calls = judgeCalls(run)
  assert.equal(calls.length, 1)
  assert.match(String(calls[0].prompt), /Group listing loads every VM into memory/)
  assert.doesNotMatch(run.report, /## Known and deferred/)
})

test('review: a dead judge raises the disputed finding and says so once', async () => {
  const run = await review([QUESTION], [finding({ line: 120 }), finding({ line: 200, title: 'Deleting an AdminSecurityGroup ignores VM references' })], null)
  assert.equal(judgeCalls(run).length, 1, 'one judge per run')
  assert.doesNotMatch(run.report, /## Known and deferred/)
  assert.equal(run.report.match(/match judge died or answered unreadably/g)?.length, 1)
})

test('review: a record without line and lens keeps the old title-overlap rule — reworded is raised, near-verbatim is set aside, no judge', async () => {
  const bare = Object.fromEntries(Object.entries(QUESTION).filter(([k]) => k !== 'line' && k !== 'lens'))
  const reworded = await review([bare], [finding()])
  assert.equal(judgeCalls(reworded).length, 0)
  assert.doesNotMatch(reworded.report, /## Known and deferred/)
  const verbatim = await review([bare], [finding({ title: 'Nothing guards deletion of a referenced AdminSecurityGroup' })])
  assert.equal(judgeCalls(verbatim).length, 0)
  assert.match(verbatim.report, /## Known and deferred[^\n]*\n- Medium[^\n]*matched by title words/)
})

/** @param {string} kind @param {string} title @param {string} scope */
const skillId = (kind, title, scope) => `${kind}-${crypto.createHash('sha256').update(`${kind}\n${title}\n${scope}`).digest('hex').slice(0, 10)}`
const O_TITLE = 'float arithmetic on amounts'
const O_ID = skillId('decision', O_TITLE, 'src/pay.rs')
const FRESH = { kind: 'decision', title: O_TITLE, body: 'the fresh word', scope: 'src/pay.rs', date: '2026-10-05', author: 'bob', commit: 'def5678', links: [], line: 4, lens: 'correctness' }
const SUCCESSOR = { id: 'decision-bbbbbbbbbb', kind: 'decision', title: 'amounts use fixed point now', body: 'the successor', scope: 'src/pay.rs', status: 'active', date: '2026-10-03', author: 'alice', commit: 'def5678', links: [`supersedes: ${O_ID}`], line: 4, lens: 'correctness' }

/** @param {unknown} judge @param {Record<string, unknown>} [over] @param {unknown} [recall] */
const adversarial = (judge, over = {}, recall = null) => ({
  scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/pay.rs'], notes: 'x' },
  'index-warmup': { indexed: false, notes: 'x' },
  review: { findings: [{ title: 'amounts are summed as floats', file: 'src/pay.rs', line: 6, severity: 'medium', description: 'd', fix: 'f', whereChecked: '', ...over }] },
  'coverage-critic': { findings: [] },
  'decision-scope': (/** @type {{ prompt: string }} */ { prompt }) => ({ unchanged: [...prompt.matchAll(/echo '([^']+)' \$\?/g)].map(m => m[1]), missing: [], reason: '' }),
  'decision-match': judge,
  'memory-recall': recall,
  'log-run': { ok: true },
  '*': (/** @type {{ opts: { label?: string } }} */ { opts }) => (/^verify/.test(String(opts.label)) ? { refuted: false, premiseSupported: true, reasoning: 'ok', severity: 'medium' } : null),
})

test('adversarial-review: an anchored record sets the reworded finding aside without a judge; a disputed one is decided by the judge', async () => {
  const rec = { ...FRESH, id: O_ID }
  const anchored = await runEngine('adversarial-review', { args: { priorDecisions: [rec] }, script: adversarial(null) })
  assert.equal(anchored.calls.filter(c => c.label === 'decision-match').length, 0)
  assert.equal(anchored.reportValue.rejectedBefore?.length, 1)
  assert.equal(anchored.reportValue.rejectedBefore[0].priorMatch, 'matched by file:line+lens')
  const judged = await runEngine('adversarial-review', { args: { priorDecisions: [rec] }, script: adversarial({ verdicts: [{ pair: 0, same: true, why: 'the same float sum' }] }, { line: 90 }) })
  assert.equal(judged.calls.filter(c => c.label === 'decision-match').length, 1)
  assert.equal(judged.reportValue.rejectedBefore?.[0]?.priorMatch, 'matched by judge: the same float sum')
  const refused = await runEngine('adversarial-review', { args: { priorDecisions: [rec] }, script: adversarial({ verdicts: [{ pair: 0, same: false, why: 'other' }] }, { line: 90 }) })
  assert.equal(refused.reportValue.rejectedBefore, undefined)
})

test('adversarial-review: an overriding passed record and its successor both match — the overriding one is tried first, its mark wins', async () => {
  const recall = { backend: 'mcp', why: 'w', decisions: [SUCCESSOR], inactive: [{ id: O_ID, kind: 'decision', title: O_TITLE, scope: 'src/pay.rs', status: 'superseded', date: '2026-10-01' }] }
  const v = (await runEngine('adversarial-review', { args: { priorDecisions: [FRESH] }, script: adversarial(null, {}, recall) })).reportValue
  assert.equal(v.rejectedBefore?.length, 1)
  assert.match(v.rejectedBefore[0].description, new RegExp(`the fresh word[^\\n]*\\(decision ${O_ID}\\)`))
})

test('rust-audit: the forwarded overriding record names the successor it overrides, so a nested review tries it first', async () => {
  const recall = { backend: 'mcp', why: 'w', decisions: [SUCCESSOR], inactive: [{ id: O_ID, kind: 'decision', title: O_TITLE, scope: 'src/pay.rs', status: 'superseded', date: '2026-10-01' }] }
  const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
  const run = await runEngine('rust-audit', { args: { priorDecisions: [FRESH] }, script: {
    scout: { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'a' }], changedCrates: [{ name: 'a', path: 'a' }], edges: [], repoRoot: '/r', notes: 'n' },
    workflow: () => '## Verdict\n✅ Approve', synthesis: 'the audit body', 'memory-recall': recall, '*': green,
  } })
  const nested = run.calls.filter(c => c.label === 'workflow')
  assert.ok(nested.length >= 1)
  for (const c of nested) {
    const list = /** @type {any[]} */ (/** @type {any[]} */ (c.argv)[1].priorDecisions)
    assert.deepEqual(list.find(d => d.id === O_ID)?.overrides, [SUCCESSOR.id])
  }
})
