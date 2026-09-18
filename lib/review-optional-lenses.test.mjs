// WHICH lenses the composition change actually removed from the bill, executed rather than read.
//
// Two decisions are pinned here, and both are about a lens that DID NOT RUN — the one class this
// repo keeps rendering as a clean result.
//
// 1. `ownership` is RETIRED. Three independent runs of the budget-deterministic engine produced not
//    one High finding from it against hundreds of suspicions verification would not confirm. A
//    retired lens must be unreachable on EVERY path, and the paths are not one: the scout's own
//    picks, the blanket fills, the security-sensitive floor, the dead-scout fallback. A roster entry
//    left behind anywhere turns into a silent nothing.
// 2. `performance`, `api-idioms` and `api-boundary` are an OPTIONAL pass: off by default, bought by
//    an explicit `optional=` request. The saving is the point, so the default must not dispatch
//    them — and the absence must be VISIBLE, in the report and on the run record, or a cheap run
//    reads later as a full one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const OPTIONAL = ['performance', 'api-idioms', 'api-boundary']

const ranLenses = calls => calls.filter(c => c.key === 'lens').map(c => String(c.opts?.label || ''))
// Matched on the label's lens FIELD — `lens:<profile>:<lens> <round-suffix>` — rather than with
// `includes`: `api-boundary` and `api-idioms` share a prefix, and a substring test would let one of
// them answer for the other.
const lensOf = label => String(label).split(':')[2]?.split(/\s+/)[0]
const ran = (calls, lens) => ranLenses(calls).some(l => lensOf(l) === lens)

function script({ scout }) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout,
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: { lens: 'x', findings: [] },
    dedup: { groups: [] },
    synthesis: null,
    '*': null,
  }
}
const scouted = (lenses, extra = {}) => script({
  scout: { sizeBucket: 'small', lenses, isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x', ...extra },
})

// ---- 1. the retired lens ----------------------------------------------------------------------

test('a scout that asks for ownership by name does not get it', async () => {
  const { calls } = await runEngine('review', { args: {}, script: scouted(['safety', 'ownership']) })
  assert.ok(ran(calls, 'safety'), 'the run did happen')
  assert.ok(!ran(calls, 'ownership'), 'ownership is retired — naming it must not resurrect it')
})

test('the security floor — the widest blanket fill there is — does not dispatch ownership', async () => {
  const { calls } = await runEngine('review', {
    args: {},
    script: scouted(['safety'], { securitySensitive: true }),
  })
  assert.ok(ranLenses(calls).length > 5, 'the floor did widen the roster')
  assert.ok(!ran(calls, 'ownership'))
})

test('the dead-scout conservative fallback does not dispatch ownership either', async () => {
  const { calls } = await runEngine('review', { args: {}, script: script({ scout: null }) })
  assert.ok(ranLenses(calls).length > 5, 'the fallback still runs a wide roster')
  assert.ok(!ran(calls, 'ownership'))
})

test('strict mode plus the optional pass still leaves ownership retired', async () => {
  const { calls } = await runEngine('review', {
    args: { strict: true, optional: true },
    script: scouted(['safety'], { securitySensitive: true }),
  })
  assert.ok(ran(calls, 'maintainability'), 'strict buys maintainability')
  assert.ok(!ran(calls, 'ownership'), 'and nothing anywhere buys ownership')
})

test('no prompt the engine sends still briefs a lens called ownership', async () => {
  const { calls } = await runEngine('review', { args: {}, script: script({ scout: null }) })
  // The roster is recited to the scout and each lens is briefed from `lensBrief`; a stale entry in
  // either would spend a lens on a rubric the engine no longer dispatches.
  assert.ok(!calls.some(c => /ownership & lifetimes/.test(c.prompt)),
    'the retired lens brief is gone, not merely unreferenced')
})

test('the verdict does not go empty where the retired lens used to carry it', async () => {
  // Ownership produced Low/Info almost exclusively, so its removal can only reduce a Low/Info set —
  // and a run whose findings are all gone must still render an honest Approve with a gate line,
  // never an empty or absent verdict.
  const { report } = await runEngine('review', { args: {}, script: scouted(['safety']) })
  assert.match(report, /## Verdict/, 'a verdict section is always rendered')
  assert.match(report, /Approve/, 'and a findingless run says Approve rather than nothing')
})

// ---- 2. the optional pass ---------------------------------------------------------------------

test('by default the three optional lenses are not dispatched, even when the scout picks them', async () => {
  const { calls } = await runEngine('review', {
    args: {},
    script: scouted(['safety', ...OPTIONAL]),
  })
  assert.ok(ran(calls, 'safety'), 'the non-optional pick still runs')
  for (const l of OPTIONAL) assert.ok(!ran(calls, l), `${l} must not run by default`)
})

test('the security floor does not silently switch the optional pass on', async () => {
  const { calls } = await runEngine('review', { args: {}, script: scouted(['safety'], { securitySensitive: true }) })
  for (const l of OPTIONAL) assert.ok(!ran(calls, l), `${l} is not bought by a floor`)
})

test('strict mode does not silently switch it on either', async () => {
  const { calls } = await runEngine('review', { args: { strict: true }, script: scouted(['safety']) })
  assert.ok(ran(calls, 'maintainability'))
  for (const l of OPTIONAL) assert.ok(!ran(calls, l), `${l} is not bought by strict`)
})

test('optional=true dispatches all three', async () => {
  const { calls } = await runEngine('review', { args: { optional: true }, script: scouted(['safety']) })
  for (const l of OPTIONAL) assert.ok(ran(calls, l), `${l} runs when the optional pass was requested`)
})

test('a named subset buys exactly that subset', async () => {
  const { calls } = await runEngine('review', {
    args: { optional: 'performance,api-boundary' },
    script: scouted(['safety']),
  })
  assert.ok(ran(calls, 'performance'))
  assert.ok(ran(calls, 'api-boundary'))
  assert.ok(!ran(calls, 'api-idioms'), 'and nothing more')
})

test('an explicit request survives the security floor and strict mode', async () => {
  const { calls } = await runEngine('review', {
    args: { optional: true, strict: true },
    script: scouted(['safety'], { securitySensitive: true }),
  })
  for (const l of OPTIONAL) assert.ok(ran(calls, l), `${l} is honoured on a floored, strict run`)
})

test('an unrecognised optional name is refused out loud, not dropped', async () => {
  const { logs, calls } = await runEngine('review', { args: { optional: 'perf' }, script: scouted(['safety']) })
  assert.ok(logs.some(l => /not an optional lens/.test(l)), 'the typo is named')
  for (const l of OPTIONAL) assert.ok(!ran(calls, l), 'and it buys nothing')
})

// ---- 3. the absence must be visible -----------------------------------------------------------

test('a default run states in its report which lenses it did not look at', async () => {
  const { report } = await runEngine('review', { args: {}, script: scouted(['safety']) })
  assert.match(report, /Not looked at/, 'the report carries a section for it')
  for (const l of OPTIONAL) assert.ok(report.includes(l), `${l} is named as skipped`)
  assert.match(report, /optional=true/, 'and the reader is told how to buy it')
})

test('the skipped set reaches the report even when the synthesis agent dies', async () => {
  // The section is appended mechanically by `out()` for exactly this reason: a model that dies or
  // simply does not obey must not be able to delete the statement of what was not covered.
  const s = scouted(['safety'])
  s.lens = { lens: 'safety', findings: [{ severity: 'High', title: 't', file: 'src/lib.rs', line: 1, why: 'w', fix: 'f', source: 'safety', ruleId: 'SAF-001', whereChecked: '' }] }
  s.synthesis = null
  const { report } = await runEngine('review', { args: {}, script: s })
  assert.match(report, /Not looked at/)
})

test('a run that DID buy the optional pass says nothing about a skipped set', async () => {
  const { report } = await runEngine('review', { args: { optional: true }, script: scouted(['safety']) })
  assert.ok(!/Not looked at/.test(report), 'the marker is absent when nothing was skipped — a marker on every run is one people stop reading')
})

test('the run record carries the optional pass, so a cheap run cannot read later as a full one', async () => {
  const skipped = await runEngine('review', { args: {}, script: scouted(['safety']) })
  const recA = filedRecord(skipped)
  assert.ok(recA, 'a record was filed')
  assert.deepEqual([...(recA.optionalPass?.skipped ?? [])].sort(), [...OPTIONAL].sort())
  assert.deepEqual(recA.optionalPass?.ran, [])
  assert.deepEqual(recA.optionalPass?.requested, [])

  const bought = await runEngine('review', { args: { optional: true }, script: scouted(['safety']) })
  const recB = filedRecord(bought)
  assert.deepEqual([...(recB.optionalPass?.ran ?? [])].sort(), [...OPTIONAL].sort())
  assert.deepEqual(recB.optionalPass?.skipped, [])
})

test('the retired lens is absent from the record\'s planned roster', async () => {
  const run = await runEngine('review', { args: {}, script: script({ scout: null }) })
  const rec = filedRecord(run)
  const planned = (rec?.scout ?? []).flatMap(x => x.lenses ?? [])
  assert.ok(planned.length, 'the record does carry the plan')
  assert.ok(!planned.includes('ownership'), 'ownership is not planned')
  for (const l of OPTIONAL) assert.ok(!planned.includes(l), `${l} is not planned by default`)
})
