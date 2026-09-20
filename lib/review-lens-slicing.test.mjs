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
import { runEngine } from './engine-harness.mjs'

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
