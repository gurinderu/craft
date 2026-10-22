// The `tests` lens (the coverage adversary) is enforced in code on a change to production source,
// the way `intent` is: the scout's rule picks it only on changed tests, so a code change with no
// test beside it -- the case where a missing test matters most -- could run without it.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

/** @param {import('./engine-harness.mjs').Call[]} calls */
const ranLenses = calls => calls.filter(c => c.key === 'lens').map(c => String(c.opts?.label || ''))
/** @param {import('./engine-harness.mjs').Call[]} calls @param {string} lens */
const ran = (calls, lens) => ranLenses(calls).some(l => new RegExp(`\\b${lens}\\b`).test(l))

/** @param {string[]} files @param {string[]} lenses */
function script(files, lenses) {
  return {
    detect: { baseRef: 'main', files, spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses, isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: { lens: 'x', findings: [] },
    dedup: { groups: [] },
    synthesis: null,
    '*': null,
  }
}

test('a code change with no test touched dispatches the tests lens though the scout did not pick it', async () => {
  const { calls } = await runEngine('review', { args: {}, script: script(['src/lib.rs', 'README.md'], ['safety']) })
  assert.ok(ran(calls, 'safety'), 'the scouted lens runs')
  assert.ok(ran(calls, 'intent'), 'intent is enforced as before')
  assert.ok(ran(calls, 'tests'), 'and tests is enforced on a production change')
})

test('a test-only diff leaves the tests lens to the scout', async () => {
  const without = await runEngine('review', { args: {}, script: script(['tests/it.rs', 'src/foo_test.rs'], ['safety']) })
  assert.ok(!ran(without.calls, 'tests'), 'not forced when no production source changed')
  const picked = await runEngine('review', { args: {}, script: script(['tests/it.rs'], ['tests']) })
  assert.ok(ran(picked.calls, 'tests'), 'the scout rule on changed tests still picks it')
})

test('a manifest-and-docs diff does not force the tests lens', async () => {
  const { calls } = await runEngine('review', { args: {}, script: script(['Cargo.toml', 'README.md'], ['safety']) })
  assert.ok(!ran(calls, 'tests'))
})
