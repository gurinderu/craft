// The #402 measurement replayed through unitBatchPlan (realm @nick/craft, #402, #355): the four-crate change
// whose old plan put every unit in one batch under a whole-diff ceiling, with the weak lenses sectioned into
// one agent. Under the fitted model the old plan read 7 agents, 7515125 tokens, its heaviest 2263315 under a
// ceiling of 2480840 (intent over the whole diff) — the record's own numbers, which the fixture reproduces.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { unitBatchPlan } from './review-unit-batches.mjs'

// The #402 measurement's change (realm @nick/craft, #402): a four-crate Rust PR as its run record gives it —
// one batch of the four crates, 52 Rust files and 2741 changed lines, 500 signature lines of dependencies
// outside them; per crate (its contract rows, which also count crd-api's one non-Rust file, a 199-line
// snapshot): crd-api 39 / 2563, api-contracts 5 / 128, client 7 / 245, linstor-client 2 / 4. crd-api's files
// spread over the module directories the record's budget:500 batches name; the lenses of that run, six sliced
// and five whole-diff.
const CRD = ['src/api', 'src/api/capacity', 'src/api/capacity/compute', 'src/api/capacity/tests', 'src/api/capacity/tests/compute_attribution',
  'src/api/capacity/tests/storage_attribution', 'src/api/cluster', 'src/api/node', 'src/api/node/live_tests', 'src/api/node/metadata',
  'src/api/node/pod_owner', 'src/api/node/pods', 'src/api/node/storage', 'src/api/node/storage/ownership',
  'src/api/node/storage/ownership/tests', 'src/api/node/storage/replicas', 'src/api/transform']

/** @type {Array<[string, number]>} file, changed lines */
const crdApi = CRD.flatMap((dir, i) => Array.from({ length: i < 4 ? 3 : 2 }, (_v, k) => /** @type {[string, number]} */ ([`bin/crd-api/${dir}/m${k}.rs`, 45])))
// pod_owner carries the change's one large file; the rest of crd-api's 2364 Rust lines spread evenly.
crdApi[crdApi.findIndex(([f]) => f.includes('/pod_owner/'))] = ['bin/crd-api/src/api/node/pod_owner/m0.rs', 820]
crdApi[0] = ['bin/crd-api/src/api/m0.rs', 2364 - crdApi.slice(1).reduce((n, [, l]) => n + l, 0)]

/** @param {string} root @param {string[]} dirs @param {number[]} lines @returns {Array<[string, number]>} */
const crate = (root, dirs, lines) => lines.map((l, i) => [`${root}/${dirs[i % dirs.length]}/f${i}.rs`, l])
/** @type {Array<[string, number]>} */
const CHANGES = [
  ...crdApi,
  ['bin/crd-api/src/api/snapshot_tests/snapshots/openapi.snap', 199],
  ...crate('crates/api-contracts', ['src'], [40, 30, 25, 20, 13]),
  ...crate('crates/client', ['src', 'src/cluster', 'src/node', 'src/node/tests'], [60, 50, 40, 35, 25, 20, 15]),
  ...crate('crates/linstor-client', ['src'], [3, 1]),
]
const FILES = [...CHANGES.map(([f]) => f), 'Cargo.lock', 'bin/crd-api/Cargo.toml']
const NUMSTAT = new Map(CHANGES)
const ROOTS = ['bin/crd-api', 'crates/api-contracts', 'crates/client', 'crates/linstor-client', 'crates/k8s-contracts', 'crates/k8s-utils']
const PACKAGES = [
  { root: 'bin/crd-api', name: 'crd-api', codeLines: 21000, sigLines: 400, deps: ['client', 'linstor-client', 'k8s-utils'] },
  { root: 'crates/api-contracts', name: 'api-contracts', codeLines: 4200, sigLines: 393, deps: ['k8s-contracts'] },
  { root: 'crates/client', name: 'client', codeLines: 5900, sigLines: 176, deps: ['api-contracts'] },
  { root: 'crates/linstor-client', name: 'linstor-client', codeLines: 1622, sigLines: 59, deps: [] },
  { root: 'crates/k8s-contracts', name: 'k8s-contracts', codeLines: 3000, sigLines: 300, deps: [] },
  { root: 'crates/k8s-utils', name: 'k8s-utils', codeLines: 900, sigLines: 200, deps: [] },
]
const SLICED = ['reconciler', 'tests', 'safety', 'errors', 'concurrency', 'maintainability']
const LENSES = [...SLICED, 'intent', 'negative-space', 'compat', 'invariants', 'failure-windows']

const TOUCHED = ['bin/crd-api', 'crates/api-contracts', 'crates/client', 'crates/linstor-client']
const owns = (/** @type {string} */ f) => f.endsWith('.rs')
const plan = () => unitBatchPlan({ lenses: LENSES, changedFiles: FILES, roots: ROOTS, packages: PACKAGES, numstat: NUMSTAT, owns, batched: true, batchBudget: 0, costModel: undefined })

test('#402 shape: the fixture is the record\'s change — 52 Rust files, 2741 changed lines, the old one-batch volume', () => {
  const rust = CHANGES.filter(([f]) => owns(f))
  assert.deepEqual([rust.length, rust.reduce((n, [, l]) => n + l, 0)], [52, 2741])
  const e = plan().costEstimate
  // The comparison plan, one agent per unit slice and lens, is the record's own: 94 agents.
  assert.equal(e.perUnit.agents, 94)
  assert.equal(e.candidates.find(c => c.name === 'budget:4500')?.batches.length, 1, 'the widest budget is still the record\'s one batch')
})

test('#402 shape: more than one batch, none heavier than a normal-review slice agent', () => {
  const e = plan().costEstimate
  const chosen = e.candidates.find(c => c.name === e.chosen)
  assert.ok(chosen && chosen.batches.length > 1, `${e.chosen}: more than one batch`)
  assert.equal(e.ceiling?.source, 'normal-review slice lens agent')
  assert.ok(Number(e.ceiling?.tokens) < 2480840, 'below the old whole-diff ceiling')
  assert.ok(e.batched.heaviest <= Number(e.ceiling?.tokens), 'no batch agent above the ceiling')
  assert.ok(chosen.fits)
  const one = e.candidates.find(c => c.name === 'budget:4500')
  assert.ok(one && !one.fits, 'the one batch of every unit no longer fits')
})

test('#402 shape: the largest budget under the ceiling is taken — as many lens agents as normal review slices', () => {
  const e = plan().costEstimate
  // budget:1500's heaviest batch (23 files) is just over the ceiling; budget:1000 fits with 6 batches, where the
  // grid without it fell to budget:500's 21 batches and 130 agents.
  assert.equal(e.chosen, 'budget:1000')
  assert.equal(e.candidates.find(c => c.name === 'budget:1500')?.fits, false)
  // 6 batches × 6 lenses + 4 contracts; normal review: 6 slices × 6 sliced lenses.
  assert.deepEqual([e.batched.agents, e.batched.total], [40, 19156974])
  assert.ok(e.batched.total < Number(e.candidates.find(c => c.name === 'budget:500')?.total) / 2)
})

test('#402 shape: one agent per lens per batch, and a contract agent per touched unit', () => {
  const { costEstimate: e, unitBatches } = plan()
  const batches = unitBatches ?? []
  for (const b of batches) {
    const lenses = e.batched.perAgent.filter(a => a.batch === b.key && a.lenses[0] !== 'contract').map(a => a.lenses)
    assert.deepEqual(lenses.map(ls => ls.length), SLICED.map(() => 1), `${b.key}: one lens per agent`)
    assert.deepEqual(lenses.map(ls => ls[0]).sort(), [...SLICED].sort(), `${b.key}: every sliced lens`)
  }
  assert.deepEqual(e.batched.perAgent.filter(a => a.lenses[0] === 'contract').map(a => a.batch), TOUCHED.map(u => `unit:${u}`))
  assert.equal(e.batched.agents, batches.length * SLICED.length + TOUCHED.length)
})
