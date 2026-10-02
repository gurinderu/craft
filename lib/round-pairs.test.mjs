// The "re-review gets cheaper" measurement (realm @nick/craft #97): a pair of consecutive review rounds
// is compared only when nothing but memory differs between them — same head (a frozen diff), same
// engine, and a real cost on both. Anything else is labelled with what confounds it, never averaged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roundPairs, renderRoundPairs, excludedRounds } from './round-pairs.mjs'

const cost = (total, cacheRead = total * 10, agents = 10) => ({ output: total / 10, input: 0, cacheRead, cacheWrite: 0, total, agents })
const rec = (round, over = {}) => withDefaults(round, over)
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
  const [p] = roundPairs([rec(1), rec(2)])
  assert.equal(p.status, 'clean')
  assert.deepEqual([p.from.round, p.to.round], [1, 2])
  assert.equal(p.delta.costTotal, 1000 - 2000)
  assert.equal(p.delta.costRatio, 0.5)
})

test('a pair whose diff moved between rounds is not a memory measurement', () => {
  const [p] = roundPairs([rec(1), rec(2, { head: 'bbb' })])
  assert.equal(p.status, 'diff-moved')
  assert.equal(p.delta, null, 'no numbers for a confounded pair')
})

test('a pair across two engines is not one either', () => {
  const [p] = roundPairs([rec(1), rec(2, { engineRevision: 5 })])
  assert.equal(p.status, 'engine-changed')
  assert.equal(p.delta, null)
})

test('a pair without a real cost on both sides says to enrich it', () => {
  const [p] = roundPairs([rec(1, { cost: undefined }), rec(2)])
  assert.equal(p.from.costTotal, null)
  assert.equal(p.status, 'cost-missing')
  assert.match(renderRoundPairs([p]), /enrich-cost/)
})

// Every way two rounds can differ for a reason other than memory, each named and given no numbers.
for (const [status, over1, over2] of [
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
]) {
  // Undefined made visible, so two rows that remove different fields do not share a name.
  const shown = JSON.stringify([over1, over2], (k, v) => (v === undefined ? '<missing>' : v))
  test(`a pair is ${status} when ${shown} — named, no numbers`, () => {
    const [p] = roundPairs([rec(1, over1), rec(2, over2)])
    assert.equal(p.status, status)
    assert.equal(p.delta, null)
  })
}

test('a nested per-crate run is not a round, even when it is the newest round 1', () => {
  // Between round 1 and round 2, so the time rule alone would pick it; a different head shows if it did.
  const pairs = roundPairs([rec(1), rec(2), { ...rec(1), nested: true, head: 'crate-slice', ts: '2026-10-01T12-00-00Z' }])
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].status, 'clean', 'paired with the top-level round 1, not the nested slice')
})

test('round n+1 pairs with the newest round n BEFORE it, not one made after it', () => {
  const later = { ...rec(1), ts: '2026-10-09T00-00-00Z', head: 'zzz' }   // a fresh chain started after round 2
  const [p] = roundPairs([rec(1), rec(2), later])
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
  const [p] = roundPairs([rec(1, { engineRevision: 9, workflowEngineRevision: 4 }), rec(2, { engineRevision: 4 })])
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
    assert.notEqual(pairs[0].status, 'clean', JSON.stringify(over))
    assert.doesNotThrow(() => renderRoundPairs(pairs))
  }
})

test('a check that throws is named malformed and keeps its error, not blamed on the record silently', () => {
  const bad = rec(2)
  Object.defineProperty(bad, 'reReview', { get() { throw new Error('boom') } })
  const [p] = roundPairs([rec(1), bad])
  assert.equal(p.status, 'malformed')
  assert.match(renderRoundPairs([p]), /boom/)
})


test('a present cost component that is not a number makes the pair malformed-cost, never a clean zero', () => {
  const base = { schemaVersion: 1, kind: 'workflow', name: 'review', project: '/p', branch: 'b', head: 'h' }
  const rec = (round, ts, cost) => ({ ...base, round, ts, cost: { total: 10, source: `s${round}`, ...cost } })
  const [p] = roundPairs([rec(1, '2026-10-01T00-00-00Z', { output: 7 }), rec(2, '2026-10-01T00-10-00Z', { output: { x: 1 } })])
  assert.notEqual(p.status, 'clean')
  assert.equal(p.delta, null)
})

test('a cost component (or skipped) that is present but not a finite non-negative number makes the pair cost-malformed', () => {
  const withCost = (round, part) => rec(round, { cost: { ...cost(1000 * (3 - round)), source: `wf-r${round}`, ...part } })
  for (const bad of ['7', '', [], true, -1, Number.NaN, { x: 1 }]) {
    for (const k of ['output', 'skipped']) {
      const [p] = roundPairs([rec(1), withCost(2, { [k]: bad })])
      assert.equal(p.status, 'cost-malformed', `${k}=${JSON.stringify(bad)}`)
    }
  }
  const [ok] = roundPairs([rec(1), withCost(2, { output: 0, skipped: 0 })])
  assert.equal(ok.status, 'clean')
})
