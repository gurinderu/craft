import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sliceDiff, sliceableLens, WHOLE_DIFF_LENSES, pathspecLiteral, MAX_SHARED_PER_SLICE } from './lens-scope.mjs'

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
  'bin/crd-gen/Cargo.toml',
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
  assert.deepEqual([...WHOLE_DIFF_LENSES].sort(), ['compat', 'failure-windows', 'intent', 'invariants', 'negative-space'])
  for (const l of WHOLE_DIFF_LENSES) assert.equal(sliceableLens(l), false, `${l} must not be sliced`)
  for (const l of ['safety', 'errors', 'concurrency', 'reconciler', 'maintainability', 'tests']) {
    assert.equal(sliceableLens(l), true, `${l} is code-intrinsic and must slice`)
  }
  // `invariants` and `failure-windows` are the two that were nearly sliced, and the reason is worth
  // pinning rather than remembering: both briefs are MIRROR WALKS — a site against its mirror, an
  // interleaving between two components — and in a real tree the two halves are ordinary source
  // files in different modules. Slicing them deletes, in silence, the one defect class a partition
  // is actually able to lose: a guard present on one side whose mirror is missing on the other.
  for (const l of ['invariants', 'failure-windows']) {
    assert.equal(sliceableLens(l), false, `${l} walks a relation between files and must see the whole diff`)
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

// THE PREDICATE THE ENGINE ACTUALLY PASSES. Every test above uses the default `owns`, which no
// caller uses — so they could all pass while the real configuration behaved differently, and it did:
// the rust profile's `detect` matches `Cargo.toml`, so under the first revision the profile's own
// manifest was "owned", landed in ONE slice, and vanished from every other slice's pathspec, while
// a degenerate manifest-only slice burned an agent per lens per round reviewing no code.
const RUST_OWNS = f => /\.rs$/.test(f) || /(^|\/)Cargo\.toml$/.test(f)

test('lens-scope: under the engine\'s own predicate, manifests still reach every slice', () => {
  const slices = sliceDiff(BASELINE, { owns: RUST_OWNS })
  assert.ok(slices.length > 1)
  for (const s of slices) {
    assert.ok(s.files.includes('Cargo.lock'), `${s.key} cannot see the lockfile`)
    assert.ok(s.files.includes('bin/crd-gen/Cargo.toml'), `${s.key} cannot see the manifest the profile also claims`)
    // And no slice may consist of nothing but shared files: that is an agent per lens per round
    // spent reviewing no code at all.
    assert.ok(s.files.some(f => f.endsWith('.rs')), `${s.key} holds no source at all`)
  }
})

test('lens-scope: under the engine\'s own predicate, the source partition is still whole', () => {
  const slices = sliceDiff(BASELINE, { owns: RUST_OWNS })
  const src = BASELINE.filter(f => f.endsWith('.rs'))
  const seen = slices.flatMap(s => s.files.filter(f => f.endsWith('.rs')))
  assert.deepEqual([...seen].sort(), [...src].sort(), 'every source file must reach exactly one slice')
  assert.equal(seen.length, new Set(seen).size, 'and no source file may be reviewed twice')
})

test('lens-scope: a path is handed to git as a literal, not as a pattern', () => {
  // Each of these is silent when it goes wrong: git returns a smaller diff and no error, so the
  // lens reviews less than it believes and reports a clean result over what it never saw.
  assert.equal(pathspecLiteral('src/f[1].rs'), ':(literal)src/f[1].rs', 'brackets are wildmatch, not literal characters')
  assert.equal(pathspecLiteral(':weird.rs'), ':(literal):weird.rs', 'a leading colon is pathspec magic')
  assert.equal(pathspecLiteral('src/a*b.rs'), ':(literal)src/a*b.rs')
  // `git diff --name-only` C-quotes a name with a space or non-ASCII, and that literal came back
  // through the model agent that reports changed files.
  assert.equal(pathspecLiteral('"dir/a b.rs"'), ':(literal)dir/a b.rs', 'git C-quoting must be undone before handing the name back')
  assert.equal(pathspecLiteral('"dir/a\\"b.rs"'), ':(literal)dir/a"b.rs')
  // An absent name yields no pathspec at all; the dedicated test below pins that.
  // A name that merely BEGINS with a quote is not C-quoting and must survive untouched.
  assert.equal(pathspecLiteral('"odd.rs'), ':(literal)"odd.rs')
})

test('lens-scope: git octal escapes are decoded back into the real name', () => {
  // `core.quotePath` is on by default, so a non-ASCII name comes back as OCTAL BYTES, one escape
  // per UTF-8 byte. Handling only `\\` and `\"` left the literal twelve characters
  // `caf\\303\\251.rs`, which matches no file — the name was silently absent from its slice.
  assert.equal(pathspecLiteral('"caf\\303\\251.rs"'), ':(literal)café.rs')
  assert.equal(pathspecLiteral('"\\320\\277\\321\\203\\321\\202\\321\\214.rs"'), ':(literal)путь.rs')
  assert.equal(pathspecLiteral('"tab\\there.rs"'), ':(literal)tab\there.rs')
  assert.equal(pathspecLiteral('"nl\\nhere.rs"'), ':(literal)nl\nhere.rs')
  // An escape git does not emit keeps BOTH characters. Swallowing the backslash produced a valid
  // name for other code, which is worse than producing none: the lens then reviews a file nobody
  // asked about and reports on it as though it were in the diff.
  assert.equal(pathspecLiteral('"odd\\zhere.rs"'), ':(literal)odd\\zhere.rs')
})

test('lens-scope: the shared set riding in every slice is bounded', () => {
  // Unbounded, this works against the cost the partition exists to cut: a tree whose changed
  // manifests outnumber its source files would have every slice pull all of them, paid ×slices
  // ×rounds — and a rust lens previously never pulled YAML at all.
  const many = [
    ...Array.from({ length: 20 }, (_unused, i) => `bin/a${i % 4}/src/f${i}.rs`),
    ...Array.from({ length: 30 }, (_unused, i) => `charts/deep/nest/v${i}.yaml`),
    'Cargo.lock',
  ]
  const slices = sliceDiff(many)
  assert.ok(slices.length > 1)
  for (const s of slices) {
    const shared = s.files.filter(f => !f.endsWith('.rs'))
    assert.ok(shared.length <= MAX_SHARED_PER_SLICE, `${s.key} carries ${shared.length} shared files`)
    // Shallowest first, so the root manifest — the one a slice most often checks its code against —
    // is the one that survives the cap.
    assert.ok(shared.includes('Cargo.lock'), `${s.key} lost the root manifest to the cap`)
  }
})

test('lens-scope: a quoted name with RAW utf-8 survives byte-exactly', () => {
  // `core.quotePath=false` is a common setting, and git still quotes a name holding a space — so the
  // body is a mix of escapes and literal text. Reading it as CHARACTERS truncated `中` (U+4E2D) to
  // 0x2D, `-`: not a missing file but a DIFFERENT one, so the diff silently described other code.
  assert.equal(pathspecLiteral('"a b café.rs"'), ':(literal)a b café.rs')
  assert.equal(pathspecLiteral('"a b 中.rs"'), ':(literal)a b 中.rs')
  // And the two quoting modes must agree on the same file.
  assert.equal(pathspecLiteral('"caf\\303\\251.rs"'), pathspecLiteral('"café.rs"'))
})

test('lens-scope: a malformed escape keeps its backslash instead of becoming another file', () => {
  // Each of these used to yield a valid name for OTHER code, which is worse than yielding none: the
  // lens reviews a file nobody asked about and reports on it as if it were in the diff.
  assert.equal(pathspecLiteral('"a\\30.rs"'), ':(literal)a\\30.rs', 'a two-digit tail is not an octal escape')
  assert.equal(pathspecLiteral('"dir\\"'), ':(literal)dir\\', 'a trailing backslash must not consume past the end')
  assert.ok(!pathspecLiteral('"dir\\"').includes('\u0000'), 'and must never put a NUL in the path')
  assert.equal(pathspecLiteral('"odd\\zhere.rs"'), ':(literal)odd\\zhere.rs')
})

test('lens-scope: nothing ever produces an EMPTY pathspec', () => {
  // `fatal: empty string is not a valid pathspec` fails the whole slice's diff, not one file — so
  // one malformed entry from the file list would take a slice's entire review with it.
  assert.notEqual(pathspecLiteral('""'), ':(literal)', 'a pair of quotes decodes to nothing and must fall back')
  // An absent name yields no pathspec at all, and the call site drops it — emitting `:(literal)`
  // would fail the whole slice's diff rather than skip one file.
  for (const empty of ['', null, undefined]) assert.equal(pathspecLiteral(empty), '', `pathspecLiteral(${JSON.stringify(empty)})`)
})

test('lens-scope: the shared cap never drops a file the profile owns out of the review', () => {
  const RUST = f => /\.rs$/.test(f) || /(^|\/)Cargo\.toml$/.test(f)
  const files = [
    ...Array.from({ length: 20 }, (_unused, i) => `bin/a${i % 4}/src/f${i}.rs`),
    ...Array.from({ length: 8 }, (_unused, i) => `top${i}.yml`),
    'bin/crd-gen/Cargo.toml',
  ]
  const slices = sliceDiff(files, { owns: RUST })
  const seen = new Set(slices.flatMap(s => s.files))
  // The cap decides how many files ride in EVERY slice, never whether a file is reviewed at all.
  // Evicted and forgotten, it was the PARTITION losing code — worse than anything a mangled file
  // list can do, because it happens on every run of that shape.
  assert.ok(seen.has('bin/crd-gen/Cargo.toml'), 'an owned file evicted by the cap must rejoin the partition')
  const holders = slices.filter(s => s.files.includes('bin/crd-gen/Cargo.toml'))
  assert.equal(holders.length, 1, 'and land in exactly one slice, not in all of them')
})

test('lens-scope: an astral character survives a raw-utf-8 quoted name', () => {
  // Indexing a string hands back a LONE SURROGATE outside the BMP, and encoding half a pair yields
  // U+FFFD twice — so an emoji became `\uFFFD\uFFFD` and the name matched nothing. The same silent
  // narrowing as the code-point bug the round before, one plane up: the BMP cases were fixed and
  // the astral ones still broke, which is why this is pinned rather than assumed.
  assert.equal(pathspecLiteral('"a b😀.rs"'), ':(literal)a b😀.rs')
  assert.equal(pathspecLiteral('"x 𝄞.rs"'), ':(literal)x 𝄞.rs')
  // And the escaped spelling of the same character must decode to the identical name.
  assert.equal(pathspecLiteral('"\\360\\237\\230\\200.rs"'), pathspecLiteral('"😀 .rs"').replace(' ', ''))
})
