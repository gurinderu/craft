// The "re-review gets cheaper" measurement (realm @nick/craft #97): a pair of consecutive review rounds
// is compared only when nothing but memory differs between them — same head (a frozen diff), same
// engine, and a real cost on both. Anything else is labelled with what confounds it, never averaged.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { roundPairs, renderRoundPairs, excludedRounds } from './round-pairs.mjs'

/** @typedef {import('./round-pairs.mjs').Pair} Pair */
/** @typedef {import('./round-pairs.mjs').Delta} Delta */

// The first pair of a run, asserted to exist — a test that gets no pair fails here, not on a later read.
/** @param {any[]} records @returns {Pair} */
const pairOf = (records) => {
  const [p] = roundPairs(records)
  assert.ok(p)
  return p
}

// As enrich-cost writes it: `total` is the sum of the four token parts.
/** @param {number} total @param {number} [agents] */
const cost = (total, agents = 10) => ({ output: total / 10, input: 0, cacheRead: total * 9 / 10, cacheWrite: 0, total, agents })
/** @param {number} round @param {Record<string, any>} [over] @returns {any} */
const rec = (round, over = {}) => withDefaults(round, over)
/** @param {number} round @param {Record<string, any>} over @returns {any} */
const withDefaults = (round, over) => ({
  schemaVersion: 1, kind: 'workflow', name: 'review', runtime: 'claude-code', craftVersion: '0.22.0', engineRevision: 4,
  project: '/p', branch: 'feat/x', head: 'aaa', round, ts: `2026-10-0${round}T00-00-00Z`,
  lensRounds: [{ round: 1, agents: 20, returned: 20, newFindings: 5 }], verification: { candidates: 10 }, findings: { total: 7 },
  dirty: false, lensScope: 'full', notRun: [], gate: { status: 'pass' }, verdict: 'Warning',
  languages: ['rust'], scout: [{ language: 'rust', lenses: ['safety', 'errors'] }], optionalPass: { requested: [] }, strict: false,
  reReview: round > 1
    ? { chained: true, fpComparable: true, basisMismatch: false, tombstonesDropped: 0, ledgerDegraded: false, journalSourced: false, priorRound: round - 1, priorHead: 'aaa' }
    : { chained: false },
  base: 'main', path: '', criticFollowups: [], intentDigest: '7', specDigest: 's', filesDigest: 'f',
  cost: { ...cost(1000 * (3 - round)), source: `wf-r${round}` }, ...over,
})

test('a frozen-diff pair on one engine with real cost on both is clean, with its deltas', () => {
  const p = pairOf([rec(1), rec(2)])
  assert.equal(p.status, 'clean')
  assert.deepEqual([p.from.round, p.to.round], [1, 2])
  assert.equal(/** @type {Delta} */ (p.delta).costTotal, 1000 - 2000)
  assert.equal(/** @type {Delta} */ (p.delta).costRatio, 0.5)
})

test('a pair whose diff moved between rounds is not a memory measurement', () => {
  const p = pairOf([rec(1), rec(2, { head: 'bbb' })])
  assert.equal(p.status, 'diff-moved')
  assert.equal(p.delta, null, 'no numbers for a confounded pair')
})

test('a pair across two engines is not one either', () => {
  const p = pairOf([rec(1), rec(2, { engineRevision: 5 })])
  assert.equal(p.status, 'engine-changed')
  assert.equal(p.delta, null)
})

test('a pair without a real cost on both sides says to enrich it', () => {
  const p = pairOf([rec(1, { cost: undefined }), rec(2)])
  assert.equal(p.from.costTotal, null)
  assert.equal(p.status, 'cost-missing')
  assert.match(renderRoundPairs([p]), /enrich-cost/)
})

// Every way two rounds can differ for a reason other than memory, each named and given no numbers.
for (const [status, over1, over2] of /** @type {[string, Record<string, any>, Record<string, any>][]} */ ([
  ['engine-unknown', { engineRevision: undefined }, { engineRevision: undefined }],
  ['dirty-tree', {}, { dirty: true }],
  ['incomplete', {}, { gate: { status: 'fail' } }],
  ['incomplete', {}, { notRun: ['rust lens safety'] }],
  ['incomplete', {}, { verification: null }],
  ['scope-not-full', {}, { lensScope: 'delta' }],
  ['scope-not-full', {}, { lensScope: undefined }],
  ['config-changed', {}, { optionalPass: { requested: ['performance'] } }],
  ['config-changed', {}, { strict: true }],
  ['memory-degraded', {}, { reReview: { ...withDefaults(2, {}).reReview, tombstonesDropped: 2 } }],
  ['prior-unconfirmed', {}, { reReview: undefined }],
  ['memory-degraded', {}, { reReview: { ...withDefaults(2, {}).reReview, ledgerDegraded: true } }],
  ['memory-degraded', {}, { reReview: { ...withDefaults(2, {}).reReview, journalSourced: true } }],
  ['prior-unconfirmed', {}, { reReview: { ...withDefaults(2, {}).reReview, priorHead: 'elsewhere' } }],
  ['diff-moved', {}, { path: 'crates/x' }],
  ['diff-moved', {}, { base: 'develop' }],
  ['config-changed', {}, { criticFollowups: ['rust:compat'] }],
  ['config-changed', {}, { intentDigest: 'ff' }],
  ['config-changed', {}, { scout: [{ language: 'rust', lenses: ['safety', 'errors'], model: 'sonnet' }] }],
  ['cost-partial', {}, { cost: { ...cost(1000), source: 'wf-x', skipped: 1 } }],
  ['cost-unbound', {}, { cost: { ...cost(1000), source: 'wf-r1' } }],
  ['cost-unbound', {}, { cost: cost(1000) }],
  ['incomplete', {}, { gate: { status: 'unknown' } }],
  ['incomplete', {}, { verdict: 'Block (PARTIAL COVERAGE)' }],
  ['diff-moved', {}, { filesDigest: 'g' }],
  ['diff-moved', {}, { filesDigest: undefined }],
  ['config-changed', {}, { specDigest: 'other' }],
  ['config-unknown', { specDigest: undefined }, { specDigest: undefined }],
  ['config-unknown', { intentDigest: undefined }, { intentDigest: undefined }],
  ['config-unknown', {}, { specDigest: undefined }],
  ['config-unknown', { intentDigest: null }, {}],
  ['config-changed', {}, { languages: ['rust', 'nix'] }],
  ['config-changed', {}, { scout: [{ language: 'rust', lenses: ['safety'] }] }],
  ['config-changed', {}, { scout: [{ language: 'rust', lenses: ['safety', 'errors'], maxRounds: 3 }] }],
  ['config-changed', {}, { scout: [{ language: 'rust', lenses: ['safety', 'errors'], verifyVotes: 3 }] }],
  ['config-changed', {}, { scout: [{ language: 'rust', lenses: ['safety', 'errors'], size: 'large' }] }],
  ['config-changed', {}, { scout: [{ language: 'rust', lenses: ['safety', 'errors'], securitySensitive: true }] }],
  ['config-changed', {}, { scout: [{ language: 'rust', lenses: ['safety', 'errors'], isLibrary: true }] }],
  ['engine-changed', {}, { craftVersion: '0.23.0' }],
  // Each check holds on the EARLIER side too, and on the later side where the rows above use the earlier.
  ['engine-unknown', { engineRevision: undefined }, {}],
  ['dirty-tree', { dirty: true }, {}],
  ['scope-not-full', { lensScope: 'delta' }, {}],
  ['cost-missing', {}, { cost: undefined }],
  ['cost-empty', { cost: { total: 0, output: 0, input: 0, cacheRead: 0, cacheWrite: 0, agents: 3, source: 'wf-r1' } }, {}],
  ['incomplete', {}, { gate: undefined }],
  ['diff-moved', { base: undefined }, { base: undefined }],
  ['prior-unconfirmed', {}, { reReview: { ...withDefaults(2, {}).reReview, priorRound: 5 } }],
  ['memory-degraded', {}, { reReview: { ...withDefaults(2, {}).reReview, chained: false } }],
  ['memory-degraded', {}, { reReview: { ...withDefaults(2, {}).reReview, fpComparable: false } }],
  ['memory-degraded', {}, { reReview: { ...withDefaults(2, {}).reReview, basisMismatch: true } }],
  // List fields compare element by element, not as one concatenated string.
  ['config-changed', { languages: ['ru', 'st'] }, { languages: ['rust'] }],
  ['config-changed', { scout: [{ language: 'rust', model: 'x' }] }, { scout: [{ language: 'rus', lenses: ['t'], model: 'x' }] }],
])) {
  // Undefined made visible, so two rows that remove different fields do not share a name.
  const shown = JSON.stringify([over1, over2], (_k, v) => (v === undefined ? '<missing>' : v))
  test(`a pair is ${status} when ${shown} — named, no numbers`, () => {
    const p = pairOf([rec(1, over1), rec(2, over2)])
    assert.equal(p.status, status)
    assert.equal(p.delta, null)
  })
}

test('a nested per-crate run is not a round, even when it is the newest round 1', () => {
  // Between round 1 and round 2, so the time rule alone would pick it; a different head shows if it did.
  const pairs = roundPairs([rec(1), rec(2), { ...rec(1), nested: true, head: 'crate-slice', ts: '2026-10-01T12-00-00Z' }])
  assert.equal(pairs.length, 1)
  assert.equal(/** @type {Pair} */ (pairs[0]).status, 'clean', 'paired with the top-level round 1, not the nested slice')
})

test('round n+1 pairs with the newest round n BEFORE it, not one made after it', () => {
  const later = { ...rec(1), ts: '2026-10-09T00-00-00Z', head: 'zzz' }   // a fresh chain started after round 2
  const p = pairOf([rec(1), rec(2), later])
  assert.equal(p.status, 'clean', 'the round 1 it remembered, not the later restart')
})

test('only consecutive rounds of one project and branch pair up; partials and other workflows never do', () => {
  const pairs = roundPairs([
    rec(1), rec(3),                                   // a gap: no pair
    rec(1, { branch: 'other' }), rec(2, { project: '/q' }), // different branch / project
    rec(2, { partial: true }),                        // a run that did not finish
    { ...rec(2), name: 'adversarial-review' },        // another workflow
  ])
  assert.deepEqual(pairs, [])
})

test('the engine identity is the engine\'s own revision when it stamped one', () => {
  const p = pairOf([rec(1, { engineRevision: 9, workflowEngineRevision: 4 }), rec(2, { engineRevision: 4 })])
  assert.equal(p.status, 'clean', 'one engine (r4) even though the loggers differed')
})

test('the report states clean pairs with numbers and confounded pairs with the reason only', () => {
  const out = renderRoundPairs(roundPairs([rec(1), rec(2), rec(1, { branch: 'b' }), rec(2, { branch: 'b', head: 'z' })]))
  assert.match(out, /feat\/x[^\n]*round 1 → 2[^\n]*tokens ×0\.5[^\n]*output [-+]\d+, input [-+]\d+, cache read [-+]\d+, cache write [-+]\d+/)
  assert.match(out, /\bb\b[^\n]*did not review the same diff/)
  assert.equal(renderRoundPairs([]).includes('No consecutive review rounds'), true)
})

// Through the CLI a reader actually runs, on a real store directory.
test('analyze-runs --round-pairs reports the pairs of a store', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-pairs-'))
  try {
    fs.writeFileSync(path.join(store, 'a.json'), JSON.stringify(rec(1)))
    fs.writeFileSync(path.join(store, 'b.json'), JSON.stringify(rec(2)))
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'analyze-runs.mjs')
    fs.writeFileSync(path.join(store, 'c.json'), '{ torn')
    const out = execFileSync('node', [script, '--round-pairs', '--engine', 'latest', store], { encoding: 'utf8' })
    assert.match(out, /round 1 → 2[^\n]*×0\.5/)
    assert.match(out, /Unreadable records — 1/, 'a lost record is said, not silently missing from the pairs')
    assert.match(out, /ignored with --round-pairs/, 'an ignored flag is said')
  } finally {
    fs.rmSync(store, { recursive: true, force: true })
  }
})

test('records that are not rounds are counted, not silently absent', () => {
  const recs = [rec(1), rec(2), { ...rec(3), partial: true }, { ...rec(1), nested: true }]
  recs.push({ ...rec(2), branch: '' }, { ...rec(2), schemaVersion: undefined })
  const out = renderRoundPairs(roundPairs(recs), excludedRounds(recs))
  assert.match(out, /4 review record\(s\) are not rounds/)
  for (const why of ['did not finish', 'nested per-crate run', 'no branch', 'pre-telemetry']) assert.match(out, new RegExp(why))
})

test('a record of the wrong shape does not crash the report — it is judged or named, never clean', () => {
  for (const over of [{ languages: 5, scout: [null] }, { lensRounds: 'x', notRun: 7 }, { reReview: 5 }]) {
    const pairs = roundPairs([rec(1), rec(2, over)])
    assert.equal(pairs.length, 1)
    assert.notEqual(/** @type {Pair} */ (pairs[0]).status, 'clean', JSON.stringify(over))
    assert.doesNotThrow(() => renderRoundPairs(pairs))
  }
})

test('a check that throws is named malformed and keeps its error, not blamed on the record silently', () => {
  const bad = rec(2)
  Object.defineProperty(bad, 'reReview', { get() { throw new Error('boom') } })
  const p = pairOf([rec(1), bad])
  assert.equal(p.status, 'malformed')
  assert.match(renderRoundPairs([p]), /boom/)
})



test('a cost component (or skipped) that is present but not a finite non-negative number makes the pair cost-malformed', () => {
  /** @param {number} round @param {Record<string, any>} part */
  const withCost = (round, part) => rec(round, { cost: { ...cost(1000 * (3 - round)), source: `wf-r${round}`, ...part } })
  for (const bad of ['7', '', [], true, -1, Number.NaN, { x: 1 }]) {
    for (const k of ['output', 'skipped']) {
      const p = pairOf([rec(1), withCost(2, { [k]: bad })])
      assert.equal(p.status, 'cost-malformed', `${k}=${JSON.stringify(bad)}`)
    }
  }
  const ok = pairOf([rec(1), withCost(2, { skipped: 0 })])
  assert.equal(ok.status, 'clean')
})

test('a present count (candidates, findings, lens dispatches) that is not a non-negative number makes the pair counts-malformed', () => {
  for (const over of [{ verification: { candidates: 'corrupt' } }, { findings: { total: 'x' } }, { lensRounds: [{ agents: 'junk' }] }]) {
    const p = pairOf([rec(1), rec(2, over)])
    assert.equal(p.status, 'counts-malformed', JSON.stringify(over))
  }
})

test('a non-object cost is cost-malformed, an empty one cost-empty, and a malformed cost prints no cost numbers', () => {
  for (const bad of ['garbage', 5, [1]]) {
    const p = pairOf([rec(1), rec(2, { cost: bad })])
    assert.equal(p.status, 'cost-malformed', JSON.stringify(bad))
    assert.equal(p.to.costTotal, null)
  }
  const e = pairOf([rec(1), rec(2, { cost: { total: 0, output: 0, input: 0, cacheRead: 0, cacheWrite: 0, agents: 3, source: 'x' } })])
  assert.equal(e.status, 'cost-empty')
})

test('rounds whose costs carry no total are compared on the sum of their parts', () => {
  /** @param {number} round @param {Record<string, any>} parts */
  const noTotal = (round, parts) => rec(round, { cost: { ...parts, agents: 10, source: `wf-r${round}` } })
  const p = pairOf([noTotal(1, { output: 200, input: 0, cacheRead: 1800, cacheWrite: 0 }), noTotal(2, { output: 100, input: 0, cacheRead: 900, cacheWrite: 0, total: null })])
  assert.equal(p.status, 'clean')
  assert.equal(/** @type {Delta} */ (p.delta).costTotal, 1000 - 2000)
  assert.equal(/** @type {Delta} */ (p.delta).costRatio, 0.5)
})

test('excludedRounds names each reason in its precedence order, a missing round included', () => {
  const recs = [
    { ...rec(1), partial: true, nested: true },          // did not finish wins over nested
    { ...rec(1), nested: true, schemaVersion: undefined }, // nested wins over pre-telemetry
    { ...rec(1), schemaVersion: undefined, round: 0 },     // pre-telemetry wins over no round
    { ...rec(1), round: 0 }, { ...rec(1), round: 1.5 },
    { ...rec(1), branch: '' },
    { ...rec(1), name: 'rust-audit', partial: true },      // not a review record: not counted
    rec(1),                                                // a round: not counted
  ]
  assert.deepEqual(excludedRounds(recs), {
    'did not finish': 1, 'nested per-crate run': 1, 'pre-telemetry': 1, 'no round': 2, 'no branch (e.g. a detached HEAD)': 1,
  })
})

test('a side without a usable cost carries null cost fields; a clean pair with unparseable times says so', () => {
  const p = pairOf([rec(1, { cost: undefined }), rec(2)])
  assert.equal(p.status, 'cost-missing')
  assert.deepEqual([p.from.costTotal, p.from.cacheRead, p.from.input, p.from.output, p.from.cacheWrite, p.from.agents], [null, null, null, null, null, null])
  assert.equal(p.to.costTotal, 1000)
  assert.deepEqual([p.to.cacheRead, p.to.input, p.to.output, p.to.cacheWrite, p.to.agents], [900, 0, 100, 0, 10])
  assert.equal(p.delta, null)
  const clean = pairOf([rec(1, { ts: '2026-10-01Tx' }), rec(2, { ts: '2026-10-02Tx' })])
  assert.equal(clean.status, 'clean')
  assert.match(renderRoundPairs([clean]), /time apart unknown/)
})

// What does NOT confound a pair: equal configuration spelled differently, and fields every reader
// tolerates when absent. Each of these is still a memory measurement.
for (const [why, a, b] of /** @type {[string, Record<string, any>, Record<string, any>][]} */ ([
  ['languages listed in another order', { languages: ['nix', 'rust'] }, { languages: ['rust', 'nix'] }],
  ['languages absent on one side and empty on the other', { languages: undefined }, { languages: [] }],
  ['scout entries in another order, one of them null', { scout: [null, { language: 'rust' }, { language: 'nix' }] }, { scout: [{ language: 'nix' }, null, { language: 'rust' }] }],
  ['no optional pass recorded on either side', { optionalPass: undefined }, { optionalPass: undefined }],
  ['strict absent on one side and false on the other', { strict: undefined }, { strict: false }],
  ['the same sub-path reviewed both times', { path: 'crates/x' }, { path: 'crates/x' }],
  ['a legacy findingsTotal in place of findings', { findings: undefined, findingsTotal: 7 }, { findings: undefined, findingsTotal: 7 }],
  ['a lens round that is null or carries no agent count', { lensRounds: [null, { agents: 3 }, {}] }, { lensRounds: [null, { agents: 3 }, {}] }],
  ['a verification that records no candidate count', { verification: {} }, { verification: {} }],
])) {
  test(`a pair stays clean with ${why}`, () => {
    assert.equal(pairOf([rec(1, a), rec(2, b)]).status, 'clean')
  })
}

test('a clean pair reports every per-kind delta, the lens dispatches summed across lens rounds, and the minutes apart', () => {
  const a = rec(1, {
    ts: '2026-10-01T00-00-00Z', lensRounds: [{ agents: 20 }, {}, { agents: 5 }], verification: { candidates: 10 }, findings: { total: 7 },
    cost: { output: 100, input: 50, cacheRead: 800, cacheWrite: 50, total: 1000, agents: 10, source: 'wf-r1' },
  })
  const b = rec(2, {
    ts: '2026-10-01T01-30-00Z', lensRounds: [{ agents: 4 }], verification: { candidates: 3 }, findings: { total: 2 },
    cost: { output: 60, input: 20, cacheRead: 400, cacheWrite: 20, total: 500, agents: 4, source: 'wf-r2' },
  })
  const p = pairOf([a, b])
  assert.equal(p.status, 'clean')
  assert.deepEqual([p.from.input, p.from.cacheWrite, p.from.lensAgents, p.from.candidates, p.from.findings, p.from.head], [50, 50, 25, 10, 7, 'aaa'])
  assert.deepEqual(p.delta, {
    costTotal: -500, costRatio: 0.5, cacheRead: -400, cacheWrite: -30, input: -30, output: -40,
    agents: -6, lensAgents: -21, candidates: -7, findings: -5, minutesApart: 90,
  })
  assert.match(renderRoundPairs([p]), /\(90 min apart — a prompt cache still warm from round 1/)
})

test('a side with no head, candidates or findings reads them as empty and zero', () => {
  const p = pairOf([rec(1, { head: undefined, verification: {}, findings: {} }), rec(2)])
  assert.equal(p.status, 'prior-unconfirmed')
  assert.deepEqual([p.from.head, p.from.candidates, p.from.findings], ['', 0, 0])
  const legacy = pairOf([rec(1, { findings: undefined, findingsTotal: 4 }), rec(2)])
  assert.equal(legacy.from.findings, 4)
})

test('a partial cost is still shown on its side — it is a lower bound, named, not erased', () => {
  const p = pairOf([rec(1), rec(2, { cost: { ...cost(1000), source: 'wf-x', skipped: 1 } })])
  assert.equal(p.status, 'cost-partial')
  assert.equal(p.to.costTotal, 1000)
})

test('each round pairs with its own predecessor, the newest one before it, and pairs come out in time order', () => {
  const oldR1 = rec(1, { ts: '2026-10-01T00-00-00Z', head: 'old' })
  const newR1 = rec(1, { ts: '2026-10-01T06-00-00Z' })
  const r2 = rec(2, { ts: '2026-10-02T00-00-00Z' })
  const r3 = rec(3, { ts: '2026-10-03T00-00-00Z' })
  const other = rec(2, { branch: 'b', ts: '2026-10-01T12-00-00Z' })
  const pairs = roundPairs([r3, r2, other, oldR1, newR1, rec(1, { branch: 'b' })])
  assert.deepEqual(pairs.map(p => [p.branch, p.from.round, p.to.round, p.from.head]), [
    ['b', 1, 2, 'aaa'], ['feat/x', 1, 2, 'aaa'], ['feat/x', 2, 3, 'aaa'],
  ])
})

test('a round n made at the same instant as round n+1 is not its predecessor', () => {
  assert.deepEqual(roundPairs([rec(1, { ts: '2026-10-02T00-00-00Z' }), rec(2, { ts: '2026-10-02T00-00-00Z' })]), [])
  assert.deepEqual(roundPairs(null), [])
})

test('a pair a check threw on keeps the error message itself', () => {
  const bad = rec(2)
  Object.defineProperty(bad, 'reReview', { get() { throw new Error('boom') } })
  const p = pairOf([rec(1), bad])
  assert.equal(p.error, 'boom')
  assert.match(renderRoundPairs([p]), /cannot be judged \(boom\)$/)
})

test('only workflow records with a string branch are rounds', () => {
  assert.deepEqual(roundPairs([rec(1, { kind: 'agent' }), rec(2, { kind: 'agent' })]), [])
  assert.deepEqual(roundPairs([rec(1, { branch: 5 }), rec(2, { branch: 5 })]), [])
})

test('excludedRounds counts only review workflow records and skips holes in the list', () => {
  assert.deepEqual(excludedRounds([null, { ...rec(1), kind: 'agent', partial: true }, { ...rec(1), partial: true }]), { 'did not finish': 1 })
})

test('the report: one line per pair under its header, the exclusion total summed, and no stray suffix', () => {
  const pairs = roundPairs([rec(1), rec(2), rec(1, { branch: 'b' }), rec(2, { branch: 'b', head: 'z' })])
  const out = renderRoundPairs(pairs, { 'did not finish': 2, 'no round': 1 })
  const lines = out.split('\n')
  assert.equal(lines.length, 5)
  assert.equal(lines[2], '_3 review record(s) are not rounds and pair with nothing: 2 did not finish, 1 no round._')
  assert.match(out, /did not review the same diff \(head, base, path or changed-file set differ, or are missing\) — the drop includes the change, not only memory$/m)
  assert.equal(renderRoundPairs([]), '## Round pairs\nNo consecutive review rounds of one branch in this store.')
})
