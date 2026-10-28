// `surfaceGate.lensesRan` must not hinge on slice completeness (realm @nick/craft #107).
//
// The analyzer excludes a gate-failed run with nothing dispatched as a fictional surface-gate saving
// unless some profile ran its lenses. `ranLenses` is deliberately strict — a lens counts only when it
// returned on EVERY slice — so deriving the run-level signal from it made a passing profile that
// lost one slice per lens read as "never reached its lenses", and its real saving vanished from the
// measurement. Driven through the whole engine, with slicing real, because the hole only exists
// where slicing does.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { aggregate } from './analyze-runs.mjs'

// Enough spread across directories that the code-intrinsic lenses are sliced (see
// review-lens-slicing.test.mjs, which owns the partition), plus a nix file for the red profile.
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
  'crates/k8s-model/src/lib.rs',
  'crates/k8s-model/src/security_group.rs',
  'crates/api-model/src/vm.rs',
  'Cargo.lock',
  'flake.nix',
]

/** @typedef {{ language: string, round: number, agents: number, returned: number }} LensRound */

/** @returns {Record<string, any>} */
function script() {
  /** @type {Record<string, number>} */
  const seen = {}
  /** @param {{ label?: string }} opts */
  const lensOf = opts => String(opts.label || '').split(':')[2]?.split(' ')[0] || ''
  return {
    detect: { baseRef: 'main', files: FILES, spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    // compat is dropped by the surface gate (no wire form); safety/errors are sliced; intent is a
    // whole-diff lens dispatched once.
    scout: {
      sizeBucket: 'small', lenses: ['safety', 'errors', 'intent', 'compat'], isLibrary: false, securitySensitive: false,
      intent: '', churn: [], notes: 'x', surfaces: { crossBoundarySymbol: false, wireForm: false, invariantType: false },
    },
    'gate:rust': { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    'gate:nix': { status: 'fail', provenance: 'nix flake check', failedChecks: ['nix flake check'], carriedChecks: [], seedFindings: [], notes: '' },
    // Every lens keeps only its FIRST dispatch: a sliced lens returns one slice and loses the rest,
    // a whole-diff lens (one dispatch) is answered once — so make that one die outright. No lens is
    // then complete, yet the profile plainly reached its lenses and got answers back.
    /** @param {{ opts: { label?: string } }} arg */
    lens: ({ opts }) => {
      const lens = lensOf(opts)
      seen[lens] = (seen[lens] || 0) + 1
      if (lens === 'intent' || /** @type {number} */ (seen[lens]) > 1) return null
      return { lens, findings: [] }
    },
    dedup: { groups: [] },
    synthesis: null,
    '*': null,
  }
}

test('a passing profile that lost a slice of every lens still counts as having run its lenses', async () => {
  const { calls } = await runEngine('review', { args: {}, script: script() })
  const rec = filedRecord({ calls })
  assert.equal(rec?.gate?.status, 'fail', 'premise: the nix gate makes the run red')
  /** @type {LensRound[]} */
  const lensRounds = rec.lensRounds || []
  assert.ok(lensRounds.some(r => r.language === 'rust' && r.returned > 0), 'premise: rust lens agents came back')
  const rust = lensRounds.filter(r => r.language === 'rust')
  assert.ok(rust.some(r => r.agents > r.returned), 'premise: slices really were lost (dispatched > returned)')
  // Without real slicing every lens goes out once, a lens that answers is complete, and the old
  // ranLenses-only signal would read true too — this test would pass while guarding nothing.
  const rustLenses = (/** @type {{ language: string, lenses?: string[] }[]} */ (rec.scout || [])).find(s => s.language === 'rust')?.lenses || []
  const r1 = rust.find(r => r.round === 1)
  assert.ok(r1 && r1.agents > rustLenses.length, `premise: lenses were sliced (${r1?.agents} agents for ${rustLenses.length} lenses)`)
  assert.ok(rec.surfaceGate.dropped.includes('compat'), 'premise: rust\'s surface gate dropped compat')
  assert.deepEqual(rec.surfaceGate.dispatched, [], 'premise: nothing gateable was dispatched')

  assert.equal(rec.surfaceGate.lensesRan, true, 'rust reached its lenses and got answers — a lost slice does not unmake that')
  const w = aggregate([rec]).workflows.find(x => x.name === 'review')
  assert.ok(w)
  assert.equal(w.sgGateFailedRuns, 0, 'so the analyzer does not discard the run as a fictional saving')
  assert.ok(/** @type {number} */ (w.sgSavedByLens['compat']) >= 1, 'and rust\'s compat drop is counted as saved')
})
