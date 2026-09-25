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
import { runEngine, filedRecord } from './engine-harness.mjs'

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

// ---- the surface gate is on the run record, not only in the report -------------------------------
//
// Mirrors lib/review-optional-lenses.test.mjs's record test: the report prose is not enough. The
// store, analyze-runs, and any comparison between two runs read the RECORD, so a cheap surface-gated
// run must be distinguishable there from one that never planned those whole-repo lenses — otherwise
// #102's saving cannot be measured. (realm @nick/craft #102.)

test('the run record carries the surface gate, so a gated run cannot read later as a full one', async () => {
  // The all-surfaces-absent diff of the first case: the floors plan the three whole-repo lenses and
  // the gate drops all three. The record must name them so a cheap run does not read as a full one.
  const gated = await runEngine('review', {
    args: {},
    script: script({
      scout: {
        sizeBucket: 'large', lenses: ['safety'], isLibrary: false, securitySensitive: true,
        intent: '', churn: [], notes: 'x',
        surfaces: { crossBoundarySymbol: false, wireForm: false, invariantType: false },
      },
    }),
  })
  const recGated = filedRecord(gated)
  assert.ok(recGated?.surfaceGate, 'a record with a surfaceGate field was filed')
  assert.deepEqual([...(recGated.surfaceGate.dropped ?? [])].sort(), ['compat', 'invariants', 'negative-space'],
    'the record names exactly the lenses the gate dropped')

  // Fail-open: the scout says nothing about surfaces, so nothing is dropped — the run paid for the
  // lenses and the record's dropped list is empty, distinguishing it from the gated run above.
  const open = await runEngine('review', {
    args: {},
    script: script({
      scout: {
        sizeBucket: 'large', lenses: ['safety'], isLibrary: false, securitySensitive: true,
        intent: '', churn: [], notes: 'x',
        // no `surfaces` field at all
      },
    }),
  })
  const recOpen = filedRecord(open)
  assert.ok(recOpen, 'a record was filed for the fail-open run')
  assert.deepEqual([...(recOpen.surfaceGate?.dropped ?? [])], [], 'a fail-open run drops nothing')
})

test('the record names the gateable lenses that actually ran, not just the ones dropped', async () => {
  // realm @nick/craft #102 follow-up: `surfaceGate.dispatched` is the analyze-runs SHARE's other
  // half. Same large/security diff as the all-absent case above, but the scout affirms only
  // crossBoundarySymbol absent — wireForm and invariantType are affirmed PRESENT, so the gate drops
  // negative-space and keeps compat/invariants, which then run and are recorded as dispatched.
  const run = await runEngine('review', {
    args: {},
    script: script({
      scout: {
        sizeBucket: 'large', lenses: ['safety'], isLibrary: false, securitySensitive: true,
        intent: '', churn: [], notes: 'x',
        surfaces: { crossBoundarySymbol: false, wireForm: true, invariantType: true },
      },
    }),
  })
  const rec = filedRecord(run)
  assert.ok(rec?.surfaceGate, 'a record with a surfaceGate field was filed')
  // Falsifier: a `dispatched` field derived from `dimensions` (or left unset) would not name these
  // two lenses reliably — this is exactly the gap #102 flagged the old `dimensions`-based approach
  // for. Reading it off the dispatch-point Set instead makes this assertion hold.
  assert.deepEqual([...(rec.surfaceGate.dispatched ?? [])].sort(), ['compat', 'invariants'],
    'compat and invariants ran (their surfaces were affirmed present) and are recorded as dispatched')
  assert.deepEqual([...(rec.surfaceGate.dropped ?? [])], ['negative-space'],
    'negative-space alone was dropped (its surface was affirmed absent)')
})

test('the critic\'s naming of a surface-gate-dropped lens is on the run record too', async () => {
  // The critic-binding scenario, read off the record: a lens the completeness critic named but the
  // gate kept dropped rides on surfaceGate.namedByCritic, mirroring optionalPass.namedByCritic.
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
  const run = await runEngine('review', { args: {}, script: s })
  const rec = filedRecord(run)
  assert.ok(rec?.surfaceGate, 'the run reached synthesis and filed a surfaceGate record')
  assert.deepEqual([...(rec.surfaceGate.namedByCritic ?? [])].sort(), ['compat', 'invariants'],
    'the lenses the critic named but the gate kept dropped are on the record')
  assert.deepEqual([...(rec.surfaceGate.dropped ?? [])].sort(), ['compat', 'invariants', 'negative-space'],
    'and the dropped set still names all three gated lenses')
})

// ---- cross-profile accounting: dropped in one active profile, dispatched in another -------------
//
// The gate above is scoped to ONE `reviewProfile` call — a PER-PROFILE decision reading THAT
// profile's own scout — but `surfaceGateDropped` is a single top-level set shared across every
// active profile, and the floor that force-adds `negative-space` (large/security-sensitive) does
// not check profile membership, so it is planned in both. On a mixed rust+nix diff the rust scout
// can affirm the surface absent while the nix scout says nothing (fail-open): negative-space is then
// dropped in rust and dispatched in nix. `surfaceGateDropped` alone would still call it saved —
// exactly the snapshot-is-a-lie failure `optionalTally()` fixed for the optional pass — so
// `surfaceGateTally()` (record AND report) must subtract what dispatched in ANY active profile
// before either one calls a lens saved. (realm @nick/craft #102.)
function mixedScript({ rustScout, nixScout, files }) {
  return {
    detect: { baseRef: 'main', files, spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    // Exact-label keys, not the `scout` prefix `script()` uses above: `keyFor` in the harness tries
    // an exact match before falling back to the `label.split(':')[0]` prefix, so `scout:rust` and
    // `scout:nix` answer independently — which is the whole point here, since the two scouts must
    // disagree about the surface.
    'scout:rust': rustScout,
    'scout:nix': nixScout,
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: { lens: 'x', findings: [] },
    dedup: { groups: [] },
    synthesis: null,
    '*': null,
  }
}

// `ran()` above only answers "dispatched somewhere" — this needs to tell WHICH profile dispatched
// it, because that is exactly the fact the tally has to get right.
const ranInProfile = (calls, profileId, lens) =>
  ranLenses(calls).some(l => l.startsWith(`lens:${profileId}:${lens}`))

test('mixed rust+nix diff: a lens the gate drops in rust but dispatches in nix is not counted as saved', async () => {
  const s = mixedScript({
    files: ['src/lib.rs', 'flake.nix'],
    rustScout: {
      sizeBucket: 'large', lenses: ['safety'], isLibrary: false, securitySensitive: true,
      intent: '', churn: [], notes: 'x',
      // Affirmatively absent in rust: drops negative-space, compat and invariants there (the
      // security floor puts all three in rust's plan; the gate then drops all three).
      surfaces: { crossBoundarySymbol: false, wireForm: false, invariantType: false },
    },
    nixScout: {
      sizeBucket: 'large', lenses: ['purity'], isLibrary: false, securitySensitive: true,
      intent: '', churn: [], notes: 'x',
      // No `surfaces` at all: FAIL-OPEN keeps negative-space in the nix plan, so it dispatches.
      // (compat/invariants are not in the nix profile's lens set at all, so the nix scout cannot
      // buy them back regardless — they stay rust-only for this diff.)
    },
  })
  const { calls, report } = await runEngine('review', { args: {}, script: s })

  // Premise guard: both profiles actually activated and ran, or nothing below tests what it claims.
  assert.ok(ranInProfile(calls, 'rust', 'safety'), 'the rust profile ran')
  assert.ok(ranInProfile(calls, 'nix', 'purity'), 'the nix profile ran')

  // (a) negative-space is genuinely dispatched — in nix, where the gate fail-opened — and genuinely
  //     not dispatched in rust, where its scout affirmed the surface absent.
  assert.ok(ranInProfile(calls, 'nix', 'negative-space'), 'negative-space dispatched in nix (fail-open)')
  assert.ok(!ranInProfile(calls, 'rust', 'negative-space'), 'negative-space was dropped in rust (surface affirmed absent)')

  // (b) because it ran somewhere, negative-space must NOT read as saved/not-run anywhere a reader
  //     looks — neither the run record nor the report's "Not run" section — even though rust's own
  //     gate dropped it.
  const rec = filedRecord({ calls })
  assert.ok(rec?.surfaceGate, 'a record with a surfaceGate field was filed')
  const dropped = [...(rec.surfaceGate.dropped ?? [])]
  assert.ok(!dropped.includes('negative-space'),
    'negative-space ran in nix, so the record must not count it as dropped')
  const notRunSection = report.match(/## Not run — the diff does not touch the surface these lenses need[\s\S]*/)?.[0] || ''
  assert.ok(!/negative-space/.test(notRunSection),
    'negative-space ran in nix, so the report must not list it as not-run')

  // (c) a lens dropped in every profile that could have run it — compat/invariants apply only to
  //     rust, and rust's own scout affirmed both surfaces absent — still reads as genuinely dropped:
  //     the subtraction above must not empty the set of lenses that really never ran anywhere.
  assert.deepEqual(dropped.sort(), ['compat', 'invariants'],
    'compat and invariants, dropped in the only profile that could ever have run them, still read as dropped')
  assert.match(notRunSection, /compat/, 'compat still appears in the Not-run section')
  assert.match(notRunSection, /invariants/, 'invariants still appears in the Not-run section')
})
