// WHICH expensive whole-repo lenses a run pays for, gated on the SURFACE the diff actually touches.
//
// `negative-space`, `compat` and `invariants` each read the entire repository, so each is among the
// costliest agents a review dispatches — and each has a defect class that cannot exist unless the
// diff touches a particular surface: a cross-boundary symbol, a serialized/wire form, an
// invariant-bearing type. The scout classifies those surfaces (`scout.surfaces`); the gate in
// `reviewProfile` drops a lens ONLY where the scout affirmatively said its surface is absent. The
// design is FAIL-OPEN: a missing `surfaces`, a missing key, or `true` all keep the lens, so
// uncertainty never silences a check. (realm @nick/craft #102.)
//
// These tests drive the whole engine in-process against a scripted fake agent, the same harness the
// lens-gating tests use — a source-text assertion could prove the const exists and never prove the
// gate runs, and a lens that silently did not run is exactly the defect this repo keeps hitting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

// Every lens the run actually dispatched an agent for.
const ranLenses = calls => calls.filter(c => c.key === 'lens').map(c => String(c.opts?.label || ''))
const ran = (calls, lens) => ranLenses(calls).some(l => l.includes(lens))

function script({ scout, files = ['src/lib.rs'] }) {
  return {
    detect: { baseRef: 'main', files, spec: '', branch: 'feat/x', head: 'abc1234' },
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

test('affirmed-absent surfaces drop the three whole-repo lenses while the sliceable ones still run', async () => {
  // A large, security-sensitive diff: the floors put negative-space (large/security), compat and
  // invariants (the security all-lenses floor) into the plan. The scout then reports every surface
  // absent, so the gate — the last word on the plan — must remove exactly those three.
  const { calls, report } = await runEngine('review', {
    args: {},
    script: script({
      scout: {
        sizeBucket: 'large', lenses: ['safety'], isLibrary: false, securitySensitive: true,
        intent: '', churn: [], notes: 'x',
        surfaces: { crossBoundarySymbol: false, wireForm: false, invariantType: false },
      },
    }),
  })
  assert.ok(ran(calls, 'safety'), 'a sliceable lens still runs')
  assert.ok(!ran(calls, 'negative-space'), 'no cross-boundary surface → negative-space is gated out')
  assert.ok(!ran(calls, 'compat'), 'no wire form → compat is gated out')
  assert.ok(!ran(calls, 'invariants'), 'no invariant-bearing type → invariants is gated out')
  // The drop is stated mechanically in the report, not left implicit.
  assert.match(report, /does not touch the surface these lenses need/, 'the mechanical not-run note is present')
  for (const lens of ['negative-space', 'compat', 'invariants']) {
    assert.match(report, new RegExp(lens), `the note names ${lens}`)
  }
})

test('FAIL-OPEN: a scout that omits surfaces keeps all three lenses', async () => {
  // Same large/security diff, but the scout says nothing about surfaces. Uncertainty must never
  // silence a check, so every gated lens the floors added still runs.
  const { calls } = await runEngine('review', {
    args: {},
    script: script({
      scout: {
        sizeBucket: 'large', lenses: ['safety'], isLibrary: false, securitySensitive: true,
        intent: '', churn: [], notes: 'x',
        // no `surfaces` field at all
      },
    }),
  })
  assert.ok(ran(calls, 'negative-space'), 'unknown surface keeps negative-space')
  assert.ok(ran(calls, 'compat'), 'unknown surface keeps compat')
  assert.ok(ran(calls, 'invariants'), 'unknown surface keeps invariants')
})

test('the completeness critic cannot re-buy a surface-gate-dropped lens out of band', async () => {
  // The gap the first three cases could not reach: they script `lens: { findings: [] }`, so the pool
  // is empty and reviewProfile returns BEFORE the completeness critic runs. This case drives the
  // engine THROUGH the critic — a lens finding makes the pool non-empty — on a large, security-
  // sensitive diff whose surfaces the scout reports absent. The security floor puts compat and
  // invariants into the plan; the surface gate drops them; and the critic then NAMES them. Ungated,
  // `candidates` (the lenses not in the plan) contains the dropped lenses, `admitted()` waves them
  // through, and they are re-dispatched — buying back exactly what the gate dropped, while the report
  // still says "not run". The surface gate must BIND the critic the same way it binds the plan.
  const FINDING = { severity: 'High', title: 't', file: 'src/lib.rs', line: 1, why: 'w', fix: 'f', source: 'safety', ruleId: 'SAF-001', whereChecked: '' }
  const s = script({
    scout: {
      sizeBucket: 'large', lenses: ['safety'], isLibrary: false, securitySensitive: true,
      intent: '', churn: [], notes: 'x',
      surfaces: { crossBoundarySymbol: false, wireForm: false, invariantType: false },
    },
  })
  s.lens = { lens: 'safety', findings: [FINDING] }
  s.critic = { missingLenses: ['compat', 'invariants'], notes: 'coverage thin' }
  const { calls, report } = await runEngine('review', { args: {}, script: s })

  // Premise guard: an assertion about what the critic did is worth nothing if the critic never ran.
  assert.ok(calls.some(c => /^critic:/.test(String(c.opts?.label || ''))), 'the completeness critic was dispatched')

  // (a) the named-but-dropped lenses are NOT re-dispatched — not in the main phase, not as a `(critic)`
  //     follow-up. A substring match is enough: no other lens label carries these names.
  for (const lens of ['compat', 'invariants']) {
    assert.ok(!ran(calls, lens), `${lens} was dropped by the surface gate and must not be re-bought by the critic`)
    assert.ok(!ranLenses(calls).some(l => l.includes(lens) && / \(critic\)/.test(l)),
      `${lens} must not reappear as a critic follow-up dispatch`)
  }

  // (b) they still reach the reader as an uncovered gap — the surface-gate section names them, and the
  //     critic's signal is carried, not swallowed.
  assert.match(report, /does not touch the surface these lenses need/, 'the mechanical not-run note is present')
  for (const lens of ['compat', 'invariants']) assert.match(report, new RegExp(lens), `the note names ${lens}`)
  assert.match(report, /completeness critic named[^\n]*compat/i, 'the critic naming compat reaches the reader')
  assert.match(report, /completeness critic named[^\n]*invariants/i, 'the critic naming invariants reaches the reader')

  // (c) the report cannot contradict what happened: a lens the surface-gate section reports as not run
  //     must genuinely not have been dispatched.
  const dispatched = new Set(ranLenses(calls).map(l => l.split(':')[2]?.split(/\s+/)[0]))
  for (const lens of ['compat', 'invariants']) {
    assert.ok(new RegExp(`NOT dispatched[^\\n]*${lens}`).test(report), `${lens} is reported as not dispatched`)
    assert.ok(!dispatched.has(lens), `and ${lens} truly was not dispatched — the section does not lie`)
  }
})

test('a changed *-contracts crate forces the wire surface on — compat runs though the scout said false', async () => {
  // The scout is wrong (or conservative-to-a-fault) and reports wireForm:false, but a file under a
  // `*-contracts` crate changed — a CERTAIN cross-boundary signal. The path-based upgrade forces
  // crossBoundarySymbol and wireForm true, so compat runs anyway; only ever ADDING a lens back, it
  // leaves invariantType untouched, so invariants — whose surface the scout still denies — stays out.
  const { calls } = await runEngine('review', {
    args: {},
    script: script({
      files: ['crates/foo-contracts/src/lib.rs'],
      scout: {
        sizeBucket: 'large', lenses: ['safety', 'invariants'], isLibrary: false, securitySensitive: false,
        intent: '', churn: [], notes: 'x',
        surfaces: { crossBoundarySymbol: false, wireForm: false, invariantType: false },
      },
    }),
  })
  assert.ok(ran(calls, 'compat'), 'the contract path forces wireForm on, so compat is not gated out')
  assert.ok(ran(calls, 'negative-space'), 'the contract path forces crossBoundarySymbol on too')
  assert.ok(!ran(calls, 'invariants'), 'the upgrade never touches invariantType, so the invariants gate still holds')
})
