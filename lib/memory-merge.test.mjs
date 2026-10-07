// A launcher's priorDecisions ADD to the engine's own recall; they never replace it. Before, a passed
// list (an empty one included) skipped the recall, so a launcher that built two decisions by hand from
// PR-thread replies kept every decision of the project's memory out of the review, and the report did
// not say memory was never asked. Only an engine that already recalled for this run skips the recall
// of the reviews it launches, by an internal flag.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, engineSource } from './engine-harness.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }

/** @param {string} title @param {string} file */
const finding = (title, file) => ({
  severity: 'Medium', title, file, line: 12, why: 'w', fix: 'f', blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: 's', whereChecked: '',
})
// Two decisions a launcher built by hand from PR-thread replies (the pr-rejections shape).
const P0 = { id: 'thread-1', title: 'unwrap in parser may panic', scope: 'src/parse.rs', reason: 'validated upstream', who: 'alice', when: '2026-10-01', link: 'https://x/pr/1#c1', commit: 'abc1234' }
const P1 = { id: 'thread-2', title: 'clone in loop is wasteful', scope: 'src/loop.rs', reason: 'loop runs twice', who: 'bob', when: '2026-10-02', link: 'https://x/pr/1#c2', commit: 'abc1234' }
const PASSED = [P0, P1]
// The owner's active decision in the project's memory backend.
const RECALLED = { id: 'decision-9', kind: 'decision', title: 'magic number in config', body: 'documented in the spec', scope: 'src/config.rs', status: 'active', date: '2026-09-01', author: 'owner', commit: 'abc1234', links: [] }
const FINDINGS = [finding(P0.title, 'src/parse.rs'), finding(P1.title, 'src/loop.rs'), finding(RECALLED.title, 'src/config.rs')]

/** @param {unknown} recall @param {any[]} [findings] */
const reviewScript = (recall, findings = FINDINGS) => ({
  detect: { baseRef: 'main', files: ['src/parse.rs', 'src/loop.rs', 'src/config.rs'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? findings : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  'decision-scope': (/** @type {{ prompt: string }} */ { prompt }) => ({ unchanged: [...prompt.matchAll(/echo '([^']+)' \$\?/g)].map(m => m[1]), reason: '' }),
  'memory-recall': recall,
  synthesis: null,
  '*': null,
})

const MEMORY = '\n\n## Memory\n'
/** @param {string} report */
const memoryLineOf = report => (report.includes(MEMORY) ? (report.slice(report.indexOf(MEMORY) + MEMORY.length).split('\n')[0] ?? '') : '')
/** @param {string} report */
const rejectedBefore = report => [...report.matchAll(/REJECTED BEFORE: ([^—]+) —/g)].map(m => String(m[1]).trim()).sort()
/** @param {any} run */
const recalls = run => run.calls.filter((/** @type {{ label: string }} */ c) => c.label === 'memory-recall').length

test('review: two hand-built decisions passed and one recalled → the recall still runs and all three are applied; the line names both parts', async () => {
  const run = await runEngine('review', { args: { priorDecisions: PASSED }, script: reviewScript({ backend: 'repo', why: 'w', decisions: [RECALLED] }) })
  assert.equal(recalls(run), 1, 'a passed list does not skip the recall')
  assert.deepEqual(rejectedBefore(run.report), ['documented in the spec', 'loop runs twice', 'validated upstream'])
  assert.equal(memoryLineOf(run.report), '- memory: recalled 1 decision(s) from repo (w); plus 2 passed by the launcher (2 new)')
})

test('review: a passed record whose id the recall also returned → the recalled record wins (the store\'s current state)', async () => {
  const stale = { ...P0, id: RECALLED.id, title: RECALLED.title, scope: RECALLED.scope, reason: 'an old reason from a thread' }
  const run = await runEngine('review', { args: { priorDecisions: [stale] }, script: reviewScript({ backend: 'repo', why: 'w', decisions: [RECALLED] }) })
  assert.deepEqual(rejectedBefore(run.report), ['documented in the spec'])
  assert.doesNotMatch(run.report, /an old reason from a thread|repeats an id/)
  assert.equal(memoryLineOf(run.report), '- memory: recalled 1 decision(s) from repo (w); plus 1 passed by the launcher (0 new)')
})

test('review: a launcher-passed [] no longer skips the recall — it merges nothing', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [] }, script: reviewScript({ backend: 'repo', why: 'w', decisions: [RECALLED] }) })
  assert.equal(recalls(run), 1)
  assert.deepEqual(rejectedBefore(run.report), ['documented in the spec'])
  assert.equal(memoryLineOf(run.report), '- memory: recalled 1 decision(s) from repo (w)')
})

test('review: a dead recall with one passed record → the passed one is applied and the line says none — why; plus 1 passed', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [P0] }, script: reviewScript(null) })
  assert.equal(recalls(run), 1)
  assert.deepEqual(rejectedBefore(run.report), ['validated upstream'])
  assert.match(memoryLineOf(run.report), /^- memory: none — the recall agent died or returned no decision list.*; plus 1 passed by the launcher$/)
})

test('review: launched by an engine that already recalled (_recalled) → no recall of its own; the line says the launching audit recalled', async () => {
  const applied = await runEngine('review', { args: { priorDecisions: [RECALLED], _recalled: true }, script: reviewScript({ backend: 'x', why: 'y', decisions: [] }) })
  assert.equal(recalls(applied), 0)
  assert.deepEqual(rejectedBefore(applied.report), ['documented in the spec'])
  assert.equal(memoryLineOf(applied.report), '- memory: recalled by the launching audit — applied 1 decision(s)')
  const none = await runEngine('review', { args: { priorDecisions: [], _recalled: true, _memory: 'the recall agent died' }, script: reviewScript({ backend: 'x', why: 'y', decisions: [RECALLED] }) })
  assert.equal(recalls(none), 0)
  assert.equal(memoryLineOf(none.report), '- memory: recalled by the launching audit — none (the recall agent died)')
})

const AUDIT_SCOUT = { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'a' }, { name: 'b', path: 'b' }], changedCrates: [{ name: 'a', path: 'a' }, { name: 'b', path: 'b' }], edges: [], repoRoot: '/r', notes: 'n' }
const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }

test('rust-audit (realm #218): a malformed recalled record does not shadow a valid passed one with its id; junk is not counted new', async () => {
  const run = await runEngine('rust-audit', { args: { priorDecisions: [P0, { id: 'junk' }] }, script: {
    scout: AUDIT_SCOUT, workflow: () => '## Verdict\n✅ Approve', synthesis: 'the audit body', 'memory-recall': { backend: 'repo', why: 'w', decisions: [{ id: P0.id }] }, '*': green,
  } })
  const a = /** @type {any} */ (/** @type {any[]} */ (run.calls.find(c => c.label === 'workflow')?.argv ?? [])[1])
  assert.deepEqual(a.priorDecisions, [{ id: P0.id }, P0, { id: 'junk' }])
  assert.deepEqual(a._memoryParts, { recalled: 1, passed: 2 })
  assert.match(run.report, /## Memory\n- memory: returned 1 decision\(s\) from repo \(w\); plus 1 passed by the launcher \(1 new\);/, 'K is the accepted count, as in review')
})

test('rust-audit: one recall, merged with the passed list, forwarded with the internal flag so nested reviews do not recall again', async () => {
  const clash = { ...P1, id: RECALLED.id }
  const run = await runEngine('rust-audit', { args: { priorDecisions: [P0, clash] }, script: {
    scout: AUDIT_SCOUT, workflow: () => '## Verdict\n✅ Approve', synthesis: 'the audit body', 'memory-recall': { backend: 'repo', why: 'w', decisions: [RECALLED] }, '*': green,
  } })
  assert.equal(recalls(run), 1, 'a passed list does not skip the audit\'s recall')
  const nested = run.calls.filter(c => c.label === 'workflow')
  assert.ok(nested.length >= 2)
  for (const c of nested) {
    const a = /** @type {any[]} */ (c.argv)[1]
    assert.deepEqual(a.priorDecisions, [RECALLED, P0], 'merged by id, the recalled record kept on a clash')
    assert.equal(a._recalled, true, 'the nested review skips its own recall')
  }
  assert.match(run.report, /## Memory\n- memory: returned 1 decision\(s\) from repo \(w\); plus 2 passed by the launcher \(1 new\); each nested review reports how many it applied\n/)
})

const ADV_DECISION = { id: 'decision-1', title: 'float arithmetic on amounts', scope: 'src', reason: 'amounts are display-only here', who: 'bob', when: '2026-09-30', link: 'https://x/pr/7#c1', commit: 'def5678' }
const advScript = (/** @type {unknown} */ recall) => ({
  scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/pay.rs'], notes: 'x' },
  'index-warmup': { indexed: false, notes: 'x' },
  review: { findings: [{ title: ADV_DECISION.title, file: 'src/pay.rs', line: 4, severity: 'medium', description: 'd', fix: 'f', whereChecked: '' }] },
  'coverage-critic': { findings: [] },
  'decision-scope': { unchanged: [ADV_DECISION.id], reason: '' },
  'log-run': { ok: true },
  'memory-recall': recall,
  '*': (/** @type {{ opts: { label?: string } }} */ { opts }) => (/^verify/.test(String(opts.label)) ? { refuted: false, premiseSupported: true, reasoning: 'ok', severity: 'medium' } : null),
})

test('adversarial-review: a passed record and the recall merge; below the budget floor the recall is skipped, named, and the passed record still counts', async () => {
  const merged = await runEngine('adversarial-review', { args: { priorDecisions: [ADV_DECISION] }, script: advScript({ backend: 'repo', why: 'w', decisions: [RECALLED] }) })
  assert.equal(recalls(merged), 1)
  assert.deepEqual(merged.reportValue.memory, { source: 'recalled', count: 1, why: 'repo (w)', passed: 1, added: 1 })
  assert.equal(merged.reportValue.rejectedBefore.length, 1, 'the passed decision is applied')
  const m = engineSource('adversarial-review').match(/BUDGET_FLOOR\s*=\s*([\d_]+)/)
  const FLOOR = Number(String(m?.[1]).replace(/_/g, ''))
  const floor = await runEngine('adversarial-review', { args: { priorDecisions: [ADV_DECISION] }, script: advScript({ backend: 'repo', why: 'w', decisions: [RECALLED] }), budgetTotal: FLOOR })
  assert.equal(recalls(floor), 0)
  assert.match(floor.reportValue.memory.why, /recall did not run — budget below the floor/)
  assert.equal(floor.reportValue.memory.passed, 1)
})

// One cap across the merged set (realm @nick/craft, node #218): recalled and passed records merge raw by
// id, then are read once, so a run never applies more than PRIOR_DECISIONS_MAX (100) — in review, in
// adversarial-review, and in the reviews rust-audit launches. Titles share no word, so a finding
// matches its own decision only.
/** @param {number} k */
const recalledAt = k => ({ id: `r-${k}`, kind: 'decision', title: `r${k}x r${k}y r${k}z`, body: `reason r-${k}`, scope: 'src', status: 'active', date: '2026-09-01', author: 'owner', commit: 'abc1234', links: [] })
/** @param {number} k */
const passedAt = k => ({ id: `p-${k}`, title: `p${k}x p${k}y p${k}z`, scope: 'src', reason: `reason p-${k}`, who: 'alice', when: '2026-10-01', link: 'https://x/pr/1#c1', commit: 'abc1234' })
const R80 = Array.from({ length: 80 }, (_, k) => recalledAt(k))
const P80 = Array.from({ length: 80 }, (_, k) => passedAt(k))
const CUT = Array.from({ length: 60 }, (_, k) => `passed decision #${20 + k} (p-${20 + k})`).join(', ')
// The last applied (passed #19, the 100th) and the first cut (passed #20, the 101st), beside a recalled one.
const EDGE_TITLES = ['r0x r0y r0z', 'p19x p19y p19z', 'p20x p20y p20z']
const EDGE = EDGE_TITLES.map(t => finding(t, 'src/parse.rs'))
const CAP_LINE = `60 decision(s) past the cap of 100 were not applied — findings they would answer are raised normally: ${CUT}`
const scopeUnchanged = (/** @type {{ prompt: string }} */ { prompt }) => ({ unchanged: [...prompt.matchAll(/echo '([^']+)' \$\?/g)].map(m => m[1]), reason: '' })

test('review (realm #218): 80 recalled + 80 passed distinct → 100 applied, the 60 past the cap refused by name and part', async () => {
  const run = await runEngine('review', { args: { priorDecisions: P80 }, script: reviewScript({ backend: 'repo', why: 'w', decisions: R80 }, EDGE) })
  assert.deepEqual(rejectedBefore(run.report), ['reason p-19', 'reason r-0'])
  assert.ok(run.report.includes(`## Prior decisions not applied\n- ⚠️ ${CAP_LINE}\n`), 'one refusal naming each cut record')
  assert.equal(memoryLineOf(run.report), '- memory: recalled 80 decision(s) from repo (w); plus 80 passed by the launcher (20 new)', 'the cap applied 20 of the passed')
})

test('adversarial-review (realm #218): the same one cap across the merged set', async () => {
  const run = await runEngine('adversarial-review', { args: { priorDecisions: P80 }, script: {
    ...advScript({ backend: 'repo', why: 'w', decisions: R80 }),
    review: { findings: EDGE_TITLES.map(title => ({ title, file: 'src/pay.rs', line: 4, severity: 'medium', description: 'd', fix: 'f', whereChecked: '' })) },
    'decision-scope': scopeUnchanged,
  } })
  const v = run.reportValue
  assert.deepEqual(v.rejectedBefore.map((/** @type {{ title: string }} */ f) => f.title).sort(), ['p19x p19y p19z', 'r0x r0y r0z'])
  assert.deepEqual(v.priorDecisionsNotApplied, [CAP_LINE])
  assert.deepEqual(v.memory, { source: 'recalled', count: 80, why: 'repo (w)', passed: 80, added: 20 })
})

test('rust-audit (realm #218): the merged list and how it splits reach each nested review, which applies 100 under the same cap and names both parts', async () => {
  const audit = await runEngine('rust-audit', { args: { priorDecisions: P80 }, script: {
    scout: AUDIT_SCOUT, workflow: () => '## Verdict\n✅ Approve', synthesis: 'the audit body', 'memory-recall': { backend: 'repo', why: 'w', decisions: R80 }, '*': green,
  } })
  const nested = audit.calls.filter(c => c.label === 'workflow')
  assert.ok(nested.length >= 2)
  for (const c of nested) assert.deepEqual(/** @type {any[]} */ (c.argv)[1]._memoryParts, { recalled: 80, passed: 80 }, 'the split of the forwarded list, which each nested review reads')
  assert.match(audit.report, /## Memory\n- memory: returned 80 decision\(s\) from repo \(w\); plus 80 passed by the launcher \(20 new\);/, 'the audit counts new under the same cap')
  /** @type {any} */
  const a = /** @type {any[]} */ (nested[0]?.argv ?? [])[1]
  assert.equal(a.priorDecisions.length, 160)
  const run = await runEngine('review', { args: { priorDecisions: a.priorDecisions, _recalled: a._recalled, _memoryParts: a._memoryParts }, script: reviewScript({ backend: 'x', why: 'y', decisions: [] }, EDGE) })
  assert.equal(recalls(run), 0)
  assert.deepEqual(rejectedBefore(run.report), ['reason p-19', 'reason r-0'])
  assert.ok(run.report.includes(`## Prior decisions not applied\n- ⚠️ ${CAP_LINE}\n`))
  assert.equal(memoryLineOf(run.report), '- memory: recalled by the launching audit — applied 100 decision(s) — 80 recalled, 20 of the 80 passed by its launcher')
})

test('review under an audit: _memoryParts names both parts; off-shape or not adding up → one total, as before', async () => {
  const args = { priorDecisions: [RECALLED, P0], _recalled: true }
  const two = await runEngine('review', { args: { ...args, _memoryParts: { recalled: 1, passed: 1 } }, script: reviewScript({ backend: 'x', why: 'y', decisions: [] }) })
  assert.equal(memoryLineOf(two.report), '- memory: recalled by the launching audit — applied 2 decision(s) — 1 recalled, 1 of the 1 passed by its launcher')
  for (const parts of [{ recalled: 1, passed: 2 }, { recalled: -1, passed: 3 }, 'x', null]) {
    const run = await runEngine('review', { args: { ...args, _memoryParts: parts }, script: reviewScript({ backend: 'x', why: 'y', decisions: [] }) })
    assert.equal(memoryLineOf(run.report), '- memory: recalled by the launching audit — applied 2 decision(s)', JSON.stringify(parts))
  }
})
