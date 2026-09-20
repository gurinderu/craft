import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sliceDiff, sliceableLens, WHOLE_DIFF_LENSES } from './lens-scope.mjs'

// The real changed-file set of the measured baseline run (lightmare, admin security groups: 53
// files, 10220 insertions, 122 agents, 5.13 agent-hours, 17 Confirmed High). Asserting against a
// made-up tree would prove the partition works on trees shaped like the assertion; this is the
// shape that actually cost 73.6% of a run.
const BASELINE = [
  'Cargo.lock',
  'bin/crd-admission/src/validation/vm.rs',
  'bin/crd-api/src/api/admission.rs',
  'bin/crd-api/src/api/error.rs',
  'bin/crd-api/src/api/transform/vm.rs',
  'bin/crd-api/src/api/vm.rs',
  'bin/crd-controller/src/config/mod.rs',
  'bin/crd-controller/src/config/reconciliation.rs',
  'bin/crd-controller/src/config/security_groups.rs',
  'bin/crd-controller/src/controller/admin_security_group/capabilities.rs',
  'bin/crd-controller/src/controller/admin_security_group/context.rs',
  'bin/crd-controller/src/controller/admin_security_group/defaults.rs',
  'bin/crd-controller/src/controller/admin_security_group/delete.rs',
  'bin/crd-controller/src/controller/admin_security_group/dependencies.rs',
  'bin/crd-controller/src/controller/admin_security_group/mod.rs',
  'bin/crd-controller/src/controller/admin_security_group/provision.rs',
  'bin/crd-controller/src/controller/admin_security_group/tests.rs',
  'bin/crd-controller/src/controller/mod.rs',
  'bin/crd-controller/src/controller/security_group/capabilities.rs',
  'bin/crd-controller/src/controller/security_group/context.rs',
  'bin/crd-controller/src/controller/security_group/dependencies.rs',
  'bin/crd-controller/src/controller/security_group/error.rs',
  'bin/crd-controller/src/controller/security_group/mod.rs',
  'bin/crd-controller/src/controller/security_group/ovn.rs',
  'bin/crd-controller/src/controller/security_group/ovn/tests.rs',
  'bin/crd-controller/src/controller/security_group/provision.rs',
  'bin/crd-controller/src/controller/security_group/provision/tests.rs',
  'bin/crd-controller/src/controller/security_group/tests.rs',
  'bin/crd-controller/src/controller/vm/context.rs',
  'bin/crd-controller/src/controller/vm/delete.rs',
  'bin/crd-controller/src/controller/vm/dependencies.rs',
  'bin/crd-controller/src/controller/vm/error.rs',
  'bin/crd-controller/src/controller/vm/provision.rs',
  'bin/crd-controller/src/controller/vm/tests/delete.rs',
  'bin/crd-controller/src/controller/vm/tests/dependencies.rs',
  'bin/crd-controller/src/controller/vm/tests/helpers.rs',
  'bin/crd-controller/src/controller/vm/tests/provision.rs',
  'bin/crd-controller/src/controller/vm/tests/update.rs',
  'bin/crd-controller/src/main.rs',
  'bin/crd-controller/src/schema_check/mod.rs',
  'bin/crd-gen/src/main.rs',
  'charts/crd-operator/crds/cloudless.dev.yml',
  'charts/crd-operator/values.yaml',
  'crates/admission-contracts/src/lib.rs',
  'crates/api-contracts/src/vm.rs',
  'crates/api-contracts/src/security_group.rs',
  'crates/client/src/lib.rs',
  'crates/k8s-contracts/src/admin_security_group.rs',
  'crates/k8s-contracts/src/ipnet.rs',
  'crates/k8s-contracts/src/lib.rs',
  'crates/k8s-contracts/src/security_group.rs',
  'crates/kube-kubeovn/src/lib.rs',
]

const owned = f => !/\.(lock|ya?ml|toml|json)$/.test(f)

test('lens-scope: the baseline diff is cut so no slice carries most of it', () => {
  const slices = sliceDiff(BASELINE)
  assert.ok(slices.length > 1, 'a 53-file diff across many modules must slice')
  const biggest = Math.max(...slices.map(s => s.files.filter(owned).length))
  const total = BASELINE.filter(owned).length
  // THE WHOLE POINT, stated as the number it has to beat. Before slicing every lens pulled all 51
  // owned files and re-read them for up to 99 turns. A partition whose largest slice still holds
  // most of the diff is decorative — an earlier revision produced exactly that (36 of 51 in one
  // slice) and looked like it worked.
  assert.ok(biggest <= Math.ceil(total / 3), `largest slice ${biggest} of ${total} must be at most a third`)
})

test('lens-scope: every changed file lands in exactly one slice, and none is invented', () => {
  const slices = sliceDiff(BASELINE)
  const seen = slices.flatMap(s => s.files.filter(owned))
  // A LOST FILE IS AN UNREVIEWED FILE, and it would be invisible: the run would report a clean
  // verdict over code no lens ever opened, which is this repo's defect class exactly.
  assert.deepEqual([...seen].sort(), BASELINE.filter(owned).sort(), 'the union of slices must be the diff')
  assert.equal(seen.length, new Set(seen).size, 'no owned file may appear in two slices')
  for (const f of seen) assert.ok(BASELINE.includes(f), `${f} was not in the diff`)
})

test('lens-scope: a manifest reaches every slice, because it is what the code is checked against', () => {
  const slices = sliceDiff(BASELINE)
  for (const s of slices) {
    assert.ok(s.files.includes('charts/crd-operator/crds/cloudless.dev.yml'), `${s.key} cannot see the CRD manifest`)
    assert.ok(s.files.includes('Cargo.lock'), `${s.key} cannot see the lockfile`)
  }
  // One of the baseline run's Confirmed High findings was precisely "the shipped CRD manifest has no
  // such property, so the apiserver prunes the field" — a defect only visible by holding the code
  // and the manifest together. A partition that separated them would have deleted that finding.
})

test('lens-scope: a module is not torn away from its own submodule', () => {
  const slices = sliceDiff(BASELINE)
  const where = f => slices.findIndex(s => s.files.includes(f))
  // Cohesion is the mechanism, not a nicety: an earlier revision swept leftovers into one bag and
  // put `security_group/ovn.rs` in a drawer with four unrelated crates, away from the module whose
  // behaviour it implements — so the slice that had to judge the change was the one slice that
  // could not see what the change must agree with.
  assert.equal(
    where('bin/crd-controller/src/controller/security_group/ovn.rs'),
    where('bin/crd-controller/src/controller/security_group/provision.rs'),
    'a module and its submodule must be judged together',
  )
})

test('lens-scope: a small or single-module diff is not sliced at all', () => {
  assert.deepEqual(sliceDiff(['a/b/x.rs', 'a/b/y.rs']), [], 'below the threshold, slicing buys nothing')
  const oneModule = Array.from({ length: 20 }, (_unused, i) => `bin/one/src/f${i}.rs`)
  // Everything under one directory: there is nothing to separate, and pretending otherwise would
  // split a module from itself for the sake of a number.
  assert.deepEqual(sliceDiff(oneModule).map(s => s.key), [], 'a single cohesive module stays whole')
})

test('lens-scope: nonsense input is an unsliced diff, never a crash', () => {
  for (const junk of [null, undefined, 'x', 42, [], [null, '', undefined]]) {
    assert.deepEqual(sliceDiff(junk), [], `sliceDiff(${JSON.stringify(junk)})`)
  }
})

test('lens-scope: slice keys are unique, because the transcript is read by them', () => {
  const slices = sliceDiff(BASELINE)
  const keys = slices.map(s => s.key)
  assert.equal(keys.length, new Set(keys).size, 'two slices with one name are indistinguishable in the log')
  for (const k of keys) assert.ok(k && k.trim(), 'a slice must be nameable')
})

test('lens-scope: the whole-diff lenses are exactly the ones whose question is about the whole', () => {
  // Not a list to grow casually: each of these asks something a slice cannot answer. `negative-space`
  // looks for what is MISSING, and absence is only visible against the whole change; `intent` checks
  // claims stated about the change entire; `compat` judges a wire shape against every producer and
  // consumer in the diff. Everything else judges code by what the code in front of it does.
  assert.deepEqual([...WHOLE_DIFF_LENSES].sort(), ['compat', 'intent', 'negative-space'])
  for (const l of WHOLE_DIFF_LENSES) assert.equal(sliceableLens(l), false, `${l} must not be sliced`)
  for (const l of ['safety', 'errors', 'concurrency', 'reconciler', 'maintainability', 'tests', 'invariants', 'failure-windows']) {
    assert.equal(sliceableLens(l), true, `${l} is code-intrinsic and must slice`)
  }
})

test('lens-scope: the slice count honours its ceiling', () => {
  for (const maxSlices of [2, 3, 4, 6, 8]) {
    const slices = sliceDiff(BASELINE, { maxSlices })
    assert.ok(slices.length <= maxSlices, `${slices.length} slices exceeds the ceiling of ${maxSlices}`)
    // And the union is still whole at every width — a merge that drops a file is the same
    // unreviewed-code defect as a split that does.
    const seen = slices.flatMap(s => s.files.filter(owned))
    assert.deepEqual([...seen].sort(), BASELINE.filter(owned).sort(), `union broken at maxSlices=${maxSlices}`)
  }
})
