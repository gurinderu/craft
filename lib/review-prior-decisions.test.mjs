// Prior decisions through the real review engine (lib/engine-harness.mjs): what the report, the
// ledger and the verdict make of a finding the project already rejected. The rules themselves are
// pinned directly in prior-decisions.test.mjs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }

/** @param {string} severity @param {Record<string, unknown>} [over] */
const finding = (severity, over = {}) => ({
  severity, title: 'unwrap in parser may panic', file: 'src/parse.rs', line: 12, why: 'panics on bad input', fix: 'return an error',
  blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: 'parse', whereChecked: '', ...over,
})

const DECISION = {
  id: 'decision-46833ecec3', title: 'unwrap in parser may panic', scope: 'src/parse.rs',
  reason: 'input is validated upstream', who: 'alice', when: '2026-10-01', link: 'https://x/pr/1#c2', commit: 'abc1234',
}

/** @param {{ findings: any[], scope?: any }} o */
const scriptFor = ({ findings, scope = { unchanged: [DECISION.id], reason: '' } }) => ({
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
  synthesis: null,
  '*': null,
})

/** @param {any} run */
const ledgerOf = run => /** @type {any[]} */ ((filedRecord(run) || {}).ledger || [])

test('prior decisions: an unchanged-scope Medium is set aside, marked, out of the verdict, persisted as rejected', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ findings: [finding('Medium')] }) })
  assert.match(run.report, /## Rejected before \(set aside — not in the verdict\)/)
  assert.match(run.report, /REJECTED BEFORE: input is validated upstream — alice, 2026-10-01, https:\/\/x\/pr\/1#c2 \(decision decision-46833ecec3\)/)
  assert.match(run.report, /✅ Approve/, 'the set-aside Medium does not hold the verdict at Warning')
  const row = ledgerOf(run).find(e => e.file === 'src/parse.rs')
  assert.equal(row?.disposition, 'rejected', 'a re-review carries it like any other dismissal')
  const check = run.calls.find(c => c.label === 'decision-scope')
  assert.match(String(check?.prompt), /git diff --quiet 'abc1234' -- 'src\/parse\.rs'; echo 'decision-46833ecec3' \$\?/)
})

test('prior decisions: a High is raised again normally, with the decision named', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ findings: [finding('High')] }) })
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.match(run.report, /⛔ Block/)
  assert.match(run.report, /raised again: a Critical\/High finding is never set aside/)
  assert.ok(!run.calls.some(c => c.label === 'decision-scope'), 'nothing to check when no finding can be set aside')
})

test('prior decisions: a changed scope raises the finding again', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ findings: [finding('Medium')], scope: { unchanged: [], reason: '' } }) })
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.match(run.report, /⚠️ Warning/)
  assert.match(run.report, /changed since abc1234/)
})

test('prior decisions: a dead scope-check agent sets nothing aside', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ findings: [finding('Medium')], scope: null }) })
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.ok(run.logs.some((/** @type {string} */ l) => /scope-check agent died or answered unreadably/.test(l)))
})

test('prior decisions: a finding outside the decision\'s scope is not set aside', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ findings: [finding('Medium', { file: 'src/other.rs' })], scope: { unchanged: [DECISION.id], reason: '' } }) })
  assert.doesNotMatch(run.report, /## Rejected before/, 'a finding outside the scope is not answered by the decision')
})

test('prior decisions: absent argument → the same report and ledger as an invocation that never heard of it', async () => {
  const base = await runEngine('review', { args: {}, script: scriptFor({ findings: [finding('Medium')] }) })
  for (const priorDecisions of [undefined, null, '', []]) {
    const run = await runEngine('review', { args: { priorDecisions }, script: scriptFor({ findings: [finding('Medium')] }) })
    assert.equal(run.report, base.report, `report differs for ${JSON.stringify(priorDecisions)}`)
    assert.deepEqual(ledgerOf(run), ledgerOf(base))
    assert.ok(!run.calls.some(c => c.label === 'decision-scope'))
  }
  assert.doesNotMatch(base.report, /Prior decisions not applied|Rejected before/)
})

test('prior decisions: malformed argument → nothing applied, the report says so, otherwise today\'s report', async () => {
  const base = await runEngine('review', { args: {}, script: scriptFor({ findings: [finding('Medium')] }) })
  for (const [priorDecisions, why] of /** @type {Array<[unknown, RegExp]>} */ ([['{nope', /not JSON/], [{ a: 1 }, /not a list/], [[{ id: 'x' }], /lacks an id, a title or a reason/]])) {
    const run = await runEngine('review', { args: { priorDecisions }, script: scriptFor({ findings: [finding('Medium')] }) })
    const at = run.report.indexOf('\n\n## Prior decisions not applied\n')
    assert.ok(at >= 0, `the report names the refusal for ${JSON.stringify(priorDecisions)}`)
    assert.match(run.report.slice(at), why)
    assert.equal(run.report.slice(0, at), base.report, 'everything else is today\'s report')
    assert.deepEqual(ledgerOf(run), ledgerOf(base))
    assert.ok(!run.calls.some(c => c.label === 'decision-scope'))
  }
})

test('prior decisions: a JSON-string argument (how a launcher passes it) applies like the list', async () => {
  const script = scriptFor({ findings: [finding('Low')] })
  const run = await runEngine('review', { args: { priorDecisions: JSON.stringify([DECISION]) }, script })
  assert.match(run.report, /## Rejected before/)
  assert.match(run.report, /REJECTED BEFORE: input is validated upstream/)
})

test('prior decisions: every engine that launches review hands priorDecisions through unchanged', async () => {
  for (const engine of ['rust-review', 'nix-review', 'rust-audit']) {
    const given = await runEngine(engine, { args: { priorDecisions: [DECISION] }, script: { '*': null } })
    const nested = given.calls.filter(c => c.label === 'workflow')
    assert.ok(nested.length >= 1, `${engine} dispatches a nested review`)
    for (const c of nested) assert.deepEqual(/** @type {any[]} */ (c.argv)[1].priorDecisions, [DECISION], `${engine} forwards priorDecisions`)
    const without = await runEngine(engine, { args: {}, script: { '*': null } })
    for (const c of without.calls.filter(x => x.label === 'workflow')) assert.ok(!('priorDecisions' in /** @type {any[]} */ (c.argv)[1]), `${engine} invents none`)
  }
})
