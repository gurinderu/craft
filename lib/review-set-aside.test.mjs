// Direct unit tests of lib/review-set-aside.mjs: the notes the verdict carries, the findings a recorded
// decision or a project rule sets aside, and the exit when nothing survived — with the review run's
// collaborators faked and the real decision and rule appliers behind them.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { setAsidePhase } from './review-set-aside.mjs'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { SCOPE_CHECK_SCHEMA } from './prior-decision-scope.mjs'
import { MATCH_JUDGE_SCHEMA } from './prior-decision-match.mjs'
import { RULE_JUDGE_SCHEMA } from './project-rule-judge.mjs'
import { uncoveredNotRunNote } from './review-coverage.mjs'

const DECISION = { id: 'decision-1', title: 'unwrap in parser may panic', scope: 'src/parse.rs', reason: 'validated upstream', who: 'alice', when: '2026-10-01', link: 'l', commit: 'abc1234' }
const RULE = { kind: 'rule', title: 'we do not support rollback', scope: 'crates/node', body: 'forward only', status: 'active', date: '2026-10-20', author: 'nick', commit: '', links: [] }
const parse = (/** @type {Record<string, unknown>} */ f) => ({ file: 'src/parse.rs', line: 3, title: 'unwrap in parser may panic', severity: 'Medium', why: 'w', source: 'a', ...f })
const roll = (/** @type {Record<string, unknown>} */ f) => ({ file: 'crates/node/src/db.rs', line: 12, title: 'migration has no down step', severity: 'Medium', why: 'w', source: 'compat', ...f })
const EMPTY = () => ({ stillOpen: [], regressed: [], resolved: [], carried: [], retired: [] })

/** @param {Record<string, any>} [s] @param {Record<string, any>} [r] */
async function phase(s = {}, r = {}) {
  /** @type {any[]} */ const records = []
  /** @type {any[]} */ const calls = []
  /** @type {string[]} */ const logs = []
  const pairs = (/** @type {string} */ prompt) => /** @type {Array<{ pair: number }>} */ (JSON.parse(String(prompt.match(/^\[\{"pair".*\]$/m)?.[0] ?? '[]')))
  const answer = r['answer'] ?? ((/** @type {string} */ prompt, /** @type {any} */ o) => (o.label === 'decision-scope'
    ? { unchanged: ['decision-1'], missing: [], reason: '' }
    : o.label === 'decision-match'
      ? { verdicts: pairs(prompt).map(p => ({ pair: p.pair, same: true, violates: false, why: 'same' })) }
      : { verdicts: pairs(prompt).map(p => ({ pair: p.pair, covered: true, why: 'out of scope' })) }))
  const reviewRun = /** @type {any} */ ({
    scopeNotRun: [], crateRuns: [], scopeSection: () => '\nSCOPE', REPO_DIRECTIVE: 'DIR\n', limitStop: { seen: () => false, note: () => 'LIMIT' },
    ragent: async (/** @type {string} */ prompt, /** @type {any} */ o) => { calls.push({ prompt, ...o }); return answer(prompt, o) },
    logRun: async (/** @type {any} */ x) => { records.push(x) }, out: (/** @type {string} */ text) => ({ text }),
    priorDecisionsIn: { decisions: parsePriorDecisions(r['records'] ?? []).decisions, refused: [] }, memory: { source: 'none' },
    sb: { log: (/** @type {string} */ l) => logs.push(l) }, ...r['run'],
  })
  const state = /** @type {any} */ ({
    tierLists: { confirmed: [], suspected: [], unverified: [] }, results: [], uncoveredGap: [], adjudicated: EMPTY(), priorTombstones: [],
    reviewRecord: (/** @type {any} */ x) => ({ ...x, wrapped: true }), thisRound: 2, mergedGateStatus: 'pass', active: [{ id: 'rust' }, { id: 'nix' }],
    mergedProvenance: 'prov', carriedSection: () => '', uncoveredFiles: [], ...s,
  })
  const res = /** @type {any} */ (await setAsidePhase(reviewRun, state))
  return { res, record: records[0], records, calls, logs, reviewRun }
}

test('nothing found on a clean run is a plain Approve with its record', async () => {
  const results = [{ dropped: 2, confirmed: [], suspected: [], notRun: [], criticNotes: '' }]
  const { res, record, calls } = await phase({ results })
  assert.equal(res.exit.text, '## Verdict\n✅ Approve — gate pass; no findings across rust+nix.\n\n## Gate\nprov\n\nSCOPE')
  assert.deepEqual(record, { wrapped: true, verdict: 'Approve', round: 2, findings: record.findings, dimensions: [], verification: { candidates: 2, confirmed: 0, refuteRate: 1 }, notRun: [] })
  assert.equal(record.findings.total, 0)
  assert.equal(calls.length, 0, 'no record given: no scope check, no rule judge')
})

test('nothing found on a run that failed somewhere is INCOMPLETE, scope and limit first', async () => {
  const results = [{ dropped: 0, confirmed: [], suspected: [], notRun: ['lens died'] }]
  const run = { scopeNotRun: ['scope dropped'], limitStop: { seen: () => true, note: () => 'LIMIT' } }
  const { res, record } = await phase({ results, uncoveredGap: ['a.py'], uncoveredFiles: ['a.py'] }, { run })
  assert.deepEqual(record.notRun, ['LIMIT', 'scope dropped', 'lens died'])
  assert.equal(record.verdict, 'INCOMPLETE')
  assert.deepEqual(record.verification, { candidates: 0, confirmed: 0, refuteRate: 0 })
  const text = res.exit.text
  assert.ok(text.includes(`no findings survived, but LIMIT; scope dropped; lens died; ${uncoveredNotRunNote(['a.py'])} — this verdict covers ONLY what ran.`), text)
  assert.ok(text.includes('; anything else in the list is a failure to fix and re-run.'))
  assert.ok(text.endsWith('\n\n## Not reviewed (no language profile)\n- a.py\nSCOPE'))
})

test('nothing found with only a coverage gap is a PARTIAL COVERAGE Approve', async () => {
  const { res, record } = await phase({ uncoveredGap: ['a.py'] })
  assert.equal(record.verdict, 'Approve (PARTIAL COVERAGE)')
  assert.match(res.exit.text, /^## Verdict\n⚠️ Approve \(PARTIAL COVERAGE\) — gate pass; no findings survived, but 1 changed file/)
  assert.ok(!res.exit.text.includes('anything else in the list'))
})

test('surviving findings return the notes the verdict carries', async () => {
  const thin = { votesDiscarded: 1 }
  const results = [
    { dropped: 1, confirmed: [{ ...thin }, {}], suspected: [{ ...thin }], refuted: [{ ...thin }], unverified: [{ ...thin }, {}], notRun: ['n1'], savedByFloor: ['s1'], criticNotes: '  look at x  ' },
    { dropped: 2, confirmed: [], suspected: [], notRun: [], criticNotes: 'coverage complete' },
    { dropped: 0, confirmed: [], suspected: [], notRun: ['n2'], criticNotes: '   ' },
  ]
  const c = parse({})
  const { res } = await phase({ results, tierLists: { confirmed: [c], suspected: [], unverified: [] }, uncoveredGap: ['a.py'] })
  assert.equal(res.exit, null)
  assert.deepEqual([res.dropped, res.thinned, res.notRun, res.savedByFloor, res.criticNotes], [3, 4, ['n1', 'n2'], ['s1'], 'look at x'])
  assert.deepEqual(res.coverageNotes, [uncoveredNotRunNote(['a.py'])])
  assert.deepEqual(res.incompleteNotes, ['n1', 'n2', uncoveredNotRunNote(['a.py'])])
  assert.deepEqual([res.confirmed, res.suspected, res.unverified, res.priorRejected, res.priorRejectedLive, res.ruleNotices], [[c], [], [], [], 0, []])
  assert.deepEqual(['question', 'rule', 'decision'].map(k => res.priorDisposition({ priorKind: k })), ['deferred', 'covered', 'rejected'])
})

test('any adjudicated track, a tombstone or an unverified finding keeps the run out of the empty exit', async () => {
  for (const k of ['stillOpen', 'regressed', 'resolved', 'carried', 'retired']) {
    const { res } = await phase({ adjudicated: { ...EMPTY(), [k]: [roll({ file: 'x.rs' })] } })
    assert.equal(res.exit, null, k)
  }
  for (const s of [{ priorTombstones: [{}] }, { tierLists: { confirmed: [], suspected: [], unverified: [{}] } }, { tierLists: { confirmed: [], suspected: [{}], unverified: [] } }]) {
    assert.equal((await phase(s)).res.exit, null)
  }
})

test('a recorded decision sets a Medium aside after one scope check, and the run does not read as empty', async () => {
  const { res, calls, logs } = await phase({ tierLists: { confirmed: [parse({})], suspected: [], unverified: [] } }, { records: [DECISION] })
  assert.equal(res.exit, null)
  assert.deepEqual(calls.map(c => [c.label, c.phase, c.schema, c.model, c.effort]), [['decision-scope', 'Synthesize', SCOPE_CHECK_SCHEMA, 'sonnet', undefined], ['decision-match', 'Synthesize', MATCH_JUDGE_SCHEMA, 'sonnet', 'low']])
  assert.ok(calls[0].prompt.startsWith('DIR\n'))
  assert.deepEqual([res.confirmed, res.priorRejected.map((/** @type {any} */ f) => [f.file, f.priorTier, f.priorKind]), res.priorRejectedLive], [[], [['src/parse.rs', 'confirmed', 'decision']], 0])
  assert.ok(logs.some(l => l.startsWith('priorDecisions: 1 decision(s) given, 1 finding(s) set aside')), logs.join('\n'))
})

test('a decision reaching a still-open prior counts it as live and gives it a tier', async () => {
  const { res } = await phase({ adjudicated: { ...EMPTY(), stillOpen: [parse({})] } }, { records: [DECISION] })
  assert.deepEqual([res.priorRejected.map((/** @type {any} */ f) => f.priorTier), res.priorRejectedLive], [['confirmed'], 1])
})

test('a decision whose commit the repo lacks is refused by name and leaves the finding in', async () => {
  const answer = (/** @type {string} */ _p, /** @type {any} */ o) => (o.label === 'decision-scope' ? { unchanged: [], missing: ['decision-1'], reason: '' } : { verdicts: [] })
  const { res, reviewRun } = await phase({ tierLists: { confirmed: [parse({})], suspected: [], unverified: [] } }, { records: [DECISION], answer })
  assert.equal(res.confirmed.length, 1)
  assert.ok(reviewRun.priorDecisionsIn.refused.some((/** @type {string} */ x) => x.startsWith('decision decision-1: ')), reviewRun.priorDecisionsIn.refused.join('\n'))
})

test('a project rule covers a finding through one judge, and the memory counts it', async () => {
  const { res, calls, logs, reviewRun } = await phase({ tierLists: { confirmed: [], suspected: [roll({ tier: 'suspected' })], unverified: [] }, adjudicated: { ...EMPTY(), regressed: [roll({ line: 30 })] } }, { records: [RULE] })
  assert.deepEqual(calls.map(c => [c.label, c.phase, c.schema, c.model, c.effort]), [['rule-match', 'Synthesize', RULE_JUDGE_SCHEMA, 'sonnet', 'low']])
  assert.deepEqual(res.priorRejected.map((/** @type {any} */ f) => [f.priorKind, f.priorTier]), [['rule', 'suspected'], ['rule', 'confirmed']])
  assert.deepEqual([res.suspected, res.priorRejectedLive, reviewRun.memory], [[], 1, { source: 'none', covered: 2 }])
  assert.ok(logs.some(l => l.startsWith('project rules: ')))
  assert.deepEqual(res.ruleNotices, [])
})
