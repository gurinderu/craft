// What slicing does to the ENGINE's dispatch, executed rather than reasoned about.
//
// The module test proves the partition is sound. This proves the engine uses it — that a lens
// really is sent its own pathspec instead of the profile's globs, that the lenses whose question is
// about the whole diff are not sliced, and that nothing in the changed set falls between slices.
// The last one is the important one: a file no lens was sent is a file nobody reviewed, and the run
// would report a verdict over it without a word.
//
// CLOCK-FREE, like every cost test here: the observable is what was dispatched and with what
// prompt, never how long anything took.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const FILES = [
  'bin/crd-api/src/api/vm.rs',
  'bin/crd-api/src/api/error.rs',
  'bin/crd-api/src/api/admission.rs',
  'bin/crd-controller/src/controller/security_group/mod.rs',
  'bin/crd-controller/src/controller/security_group/ovn.rs',
  'bin/crd-controller/src/controller/security_group/provision.rs',
  'bin/crd-controller/src/controller/security_group/tests.rs',
  'bin/crd-controller/src/controller/vm/provision.rs',
  'bin/crd-controller/src/controller/vm/delete.rs',
  'bin/crd-controller/src/controller/vm/context.rs',
  'crates/k8s-contracts/src/lib.rs',
  'crates/k8s-contracts/src/security_group.rs',
  'crates/api-contracts/src/vm.rs',
  'Cargo.lock',
]

// `negative-space` is deliberately ABSENT: the rust profile admits it only under conditions this
// fixture does not meet, so naming it here would make the roster describe something the engine
// never dispatched — and the assertion about it would pass or fail for reasons unrelated to
// slicing. That it must not be sliced is asserted where it can be: lib/lens-scope.test.mjs.
const LENSES = ['safety', 'errors', 'intent', 'compat']
const WHOLE_DIFF_IN_FIXTURE = ['intent', 'compat']

function script() {
  return {
    detect: { baseRef: 'main', files: FILES, spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: LENSES, isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: ({ opts }) => ({ lens: String(opts.label || '').split(':')[2]?.split(' ')[0] || 'safety', findings: [] }),
    dedup: { groups: [] },
    synthesis: null,
    '*': null,
  }
}

const lensCalls = calls => calls.filter(c => /^lens:/.test(String(c.label)))
const forLens = (calls, lens) => lensCalls(calls).filter(c => String(c.label).split(':')[2]?.split(' ')[0] === lens)

test('review: a code-intrinsic lens is dispatched once per slice, a whole-diff lens exactly once', async () => {
  const { calls, logs } = await runEngine('review', { args: {}, script: script() })
  const round1 = c => / r1\b/.test(String(c.label))
  const safety = forLens(calls, 'safety').filter(round1)
  assert.ok(safety.length > 1, `safety must fan out over slices, saw ${safety.length}`)
  for (const lens of WHOLE_DIFF_IN_FIXTURE) {
    const n = forLens(calls, lens).filter(round1).length
    assert.equal(n, 1, `${lens} judges the diff as a whole and must be dispatched once, saw ${n}`)
  }
  assert.ok(logs.some(l => /sliced into/.test(l)), 'the engine must SAY it sliced — a partition made silently cannot be diagnosed from a transcript')
})

test('review: the union of the slices is the whole diff — no changed file goes unreviewed', async () => {
  const { calls } = await runEngine('review', { args: {}, script: script() })
  const safety = forLens(calls, 'safety').filter(c => / r1\b/.test(String(c.label)))
  const owned = FILES.filter(f => f.endsWith('.rs'))
  const mentioned = new Set()
  for (const c of safety) for (const f of owned) if (c.prompt.includes(f)) mentioned.add(f)
  // A file that reached no slice is code the run never opened while still issuing a verdict over
  // the diff that contains it. Nothing else in the engine would notice.
  assert.deepEqual([...mentioned].sort(), [...owned].sort(), 'every changed source file must reach some slice')
})

test('review: a sliced lens is sent its own files, not the profile-wide glob', async () => {
  const { calls } = await runEngine('review', { args: {}, script: script() })
  const safety = forLens(calls, 'safety').filter(c => / r1\b/.test(String(c.label)))
  for (const c of safety) {
    assert.ok(/YOUR SLICE/.test(c.prompt), 'a sliced dispatch must say so in its prompt')
    assert.ok(!/-- '\*\.rs'/.test(c.prompt), 'a sliced dispatch must NOT carry the whole-profile glob — that is the cost being removed')
  }
  // And the unsliced ones keep exactly the old shape, so the two paths cannot drift.
  const whole = forLens(calls, 'intent').filter(c => / r1\b/.test(String(c.label)))
  assert.equal(whole.length, 1)
  assert.ok(/-- '\*\.rs'/.test(whole[0].prompt), 'a whole-diff lens keeps the profile glob')
  assert.ok(!/YOUR SLICE/.test(whole[0].prompt), 'and is not told it holds a slice')
})

test('review: every slice is sent the manifest its code has to agree with', async () => {
  const { calls } = await runEngine('review', { args: {}, script: script() })
  const safety = forLens(calls, 'safety').filter(c => / r1\b/.test(String(c.label)))
  assert.ok(safety.length > 1)
  for (const c of safety) {
    // The engine used to hand the slicer only the files its own profile matches — `*.rs` for rust —
    // so the lockfile and the chart manifest were gone before any slice existed. The baseline run's
    // Confirmed High "the shipped CRD manifest has no such property, so the apiserver prunes the
    // field" is visible ONLY by holding code and manifest together; a partition that separates them
    // deletes that finding and reports the same clean verdict.
    assert.ok(c.prompt.includes('Cargo.lock'), 'a slice must be able to see the lockfile')
  }
})

test('review: slicing narrows what is JUDGED and says so, never what may be read', async () => {
  const { calls } = await runEngine('review', { args: {}, script: script() })
  const one = forLens(calls, 'safety').filter(c => / r1\b/.test(String(c.label)))[0]
  // The risk slicing introduces is a lens that treats its slice as the edge of the world and stops
  // checking premises that live outside it — which would trade cost for exactly the kind of
  // unverified claim the whole verification tier exists to prevent.
  assert.match(one.prompt, /never what you may READ/i)
  assert.match(one.prompt, /whereChecked/)
  assert.match(one.prompt, /CONTEXT EXPANSION \(required\)/)
})

test('review: a diff too small to slice dispatches exactly as before', async () => {
  const small = { ...script(), detect: { baseRef: 'main', files: ['a/b/x.rs', 'a/b/y.rs'], spec: '', branch: 'feat/x', head: 'abc1234' } }
  const { calls, logs } = await runEngine('review', { args: {}, script: small })
  for (const lens of LENSES) {
    const n = forLens(calls, lens).filter(c => / r1\b/.test(String(c.label))).length
    assert.equal(n, 1, `${lens} must be dispatched once on an unsliced diff, saw ${n}`)
  }
  assert.ok(!logs.some(l => /sliced into/.test(l)), 'and the engine must not claim a partition it did not make')
})

test('review: a lens that loses one slice of several is reported, not absorbed by its siblings', async () => {
  // THE DEFECT SLICING INTRODUCES IF COVERAGE IS COUNTED BY NAME. Before slicing a lens either ran
  // or did not, and a death forced INCOMPLETE. With six slices, five can die while one returns —
  // and "did safety run?" answers yes. The run would then issue an ordinary verdict over five
  // sixths of a diff no lens of that kind ever read, which is this repo's defect class exactly,
  // arriving through the mechanism meant to make reviews cheaper.
  let seenSafety = 0
  const script2 = {
    ...script(),
    lens: ({ opts }) => {
      const lens = String(opts.label || '').split(':')[2]?.split(' ')[0] || 'safety'
      // Every safety slice but the first dies; every other lens answers normally.
      if (lens === 'safety' && seenSafety++ > 0) return null
      return { lens, findings: [] }
    },
  }
  const { calls, logs } = await runEngine('review', { args: {}, script: script2 })
  const rec = filedRecord({ calls })
  const dead = (rec.notRun || []).filter(n => /lenses that never returned/.test(n))
  assert.ok(dead.length, `a lost slice must reach notRun: ${JSON.stringify(rec.notRun)}`)
  assert.match(dead[0], /safety :: /, 'and must name the SLICE, not just the lens — "safety ran" is true and useless here')
  assert.match(String(rec.verdict), /INCOMPLETE/, 'a run missing slices of a lens is not complete')
  assert.ok(logs.some(l => /lens dispatch\(es\) never returned/.test(l)), 'and the transcript must say so')
})

test('review: the round record counts the dispatches it made, not the lenses it planned', async () => {
  const { calls } = await runEngine('review', { args: {}, script: script() })
  const rec = filedRecord({ calls })
  const r1 = (rec.lensRounds || []).find(r => r.round === 1)
  assert.ok(r1, 'round 1 must be recorded')
  // `returned > agents` is the shape that made a lost slice invisible downstream: with `agents`
  // counting lenses and `returned` counting sliced results, every death accounting read inverted.
  assert.ok(r1.agents >= r1.returned, `agents ${r1.agents} must not undercount returned ${r1.returned}`)
  assert.ok(r1.agents > LENSES.length, `with slicing, round 1 dispatches more than ${LENSES.length} agents, saw ${r1.agents}`)
})

test('review: a lens answering with a mangled name does not corrupt the ledger or its findings', async () => {
  // THE FIELD THE ACCOUNTING REFUSES TO TRUST, tested rather than asserted in a comment. `lens` is
  // whatever the model put in its answer; the engine knows what it DISPATCHED. Trusting the answer
  // sent findings to `source: 'unknown'` while the dimension row read `ran: true` with zero
  // findings — the yield inversion, arriving one field over from the coverage it was fixed in.
  const CONFIRMS = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'stands' }
  const script2 = {
    ...script(),
    // Verification must actually run: the per-lens yield rows count CONFIRMED findings filtered by
    // `source`, so with a dead verifier every row reads zero and the attribution this test exists
    // for is unobservable. Found by restoring the defect and watching the test still pass.
    verify: CONFIRMS,
    'verify-batch': ({ prompt }) => ({
      verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...CONFIRMS })),
    }),
    lens: ({ opts }) => {
      const lens = String(opts.label || '').split(':')[2]?.split(' ')[0] || 'safety'
      const finding = {
        severity: 'High', title: `t-${lens}`, file: 'bin/crd-api/src/api/vm.rs', line: 10,
        why: 'w', fix: 'f', blastRadius: '', source: '', ruleId: '', whereChecked: '',
      }
      // The answer names a lens that was never dispatched — or none at all.
      return { lens: lens === 'safety' ? 'not-a-lens' : '', findings: [finding] }
    },
  }
  const { calls } = await runEngine('review', { args: {}, script: script2 })
  const rec = filedRecord({ calls })

  // 1. Coverage is whole: every dispatch answered, whatever it called itself.
  assert.ok(!(rec.notRun || []).some(n => /lenses that never returned/.test(n)), `no hole may be invented: ${JSON.stringify(rec.notRun)}`)
  // Deliberately NOT asserting the verdict is free of INCOMPLETE: this fixture's `Cargo.lock`
  // matches no language profile, so the run is legitimately incomplete for a reason that has
  // nothing to do with lenses. Asserting the broader thing would pass or fail on an unrelated fact.


  // 2. The findings are attributed to the lens the engine DISPATCHED, so the per-lens yield rows
  // mean what they say. `not-a-lens` must appear nowhere.
  const dims = rec.dimensions || []
  assert.ok(dims.length, 'dimension rows must exist')
  assert.ok(!dims.some(d => /not-a-lens|unknown/.test(String(d.dimension))), `a model-supplied name must not become a dimension: ${JSON.stringify(dims.map(d => d.dimension))}`)
  // Counted on the run's own findings tally as well as on the per-lens rows. The verifier in this
  // fixture is LIVE on purpose (see `verify` above): the rows count confirmed findings, so with a
  // dead verifier every row reads zero and the attribution under test is unobservable — which is
  // how an earlier revision of this test passed against the restored defect.
  assert.ok((rec.findings?.total || 0) > 0, `the findings must survive attribution: ${JSON.stringify(rec.findings)}`)
  // THE ASSERTION THAT ACTUALLY DEPENDS ON THE FIX: a confirmed finding is counted against the lens
  // that was dispatched. Trusting the model's field sends it to a source no row matches, and every
  // row reads zero while the findings plainly exist.
  const attributed = dims.reduce((n, d) => n + (d.confirmedCount || 0), 0)
  assert.ok(attributed > 0, `confirmed findings must reach a real lens's row, saw ${JSON.stringify(dims.map(d => [d.dimension, d.confirmedCount]))}`)
  // Every dimension row belongs to a lens the engine planned. A model-supplied name reaching this
  // table is the inversion: a row that claims to be a lens and is not one.
  for (const d of dims) {
    const lens = String(d.dimension).split(':')[1]
    assert.ok(LENSES.includes(lens), `dimension '${d.dimension}' is not a planned lens`)
  }
})

test('review: a git-quoted path still reaches a slice', async () => {
  // THE PATH DATA TAKES, not just the function at the end of it. A C-quoted name ends in `"`, so
  // the profile's `detect` sees no `.rs` suffix and the shared-suffix test sees no `.lock` — the
  // file belongs to no profile and enters NO slice, and the decoder downstream never sees it
  // because the name was filtered out long before. The unit test for the decoder passes either way.
  const quoted = '"bin/crd-api/src/api/caf\\303\\251.rs"'
  const withQuoted = { ...script(), detect: { baseRef: 'main', files: [...FILES, quoted], spec: '', branch: 'feat/x', head: 'abc1234' } }
  const { calls } = await runEngine('review', { args: {}, script: withQuoted })
  const round1 = c => / r1\b/.test(String(c.label))
  const safety = forLens(calls, 'safety').filter(round1)
  assert.ok(safety.length > 1, 'the diff must still slice')
  const mentioned = safety.some(c => c.prompt.includes('café.rs'))
  assert.ok(mentioned, 'the decoded name must reach some slice\'s pathspec')
  for (const c of safety) {
    assert.ok(!c.prompt.includes('\\303'), 'and the octal spelling must never be handed to git')
  }
})
