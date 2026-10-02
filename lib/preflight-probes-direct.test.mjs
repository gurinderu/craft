// Direct tests of lib/preflight-probes.mjs: every declared budget holds at its max and breaks one
// past it, a forbidden source is clean only when unused, and the declaration block renders each
// budget in its own row.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { auditPreflightProbes, probeDeclarationBlock, probeCallCount, PROBE_BUDGETS } from './preflight-probes.mjs'

/** @param {string} source @param {number} calls */
const audit = (source, calls) => auditPreflightProbes({ probes: [{ source, calls }] })

test('every source is clean at its budget and a violation one call past it', () => {
  for (const [id, { max }] of Object.entries(PROBE_BUDGETS)) {
    assert.deepEqual(audit(id, max), [], `${id} at ${max}`)
    assert.equal(audit(id, max + 1).length, 1, `${id} at ${max + 1}`)
  }
})

test('the budgets are the declared ones', () => {
  const maxes = Object.fromEntries(Object.entries(PROBE_BUDGETS).map(([id, b]) => [id, b.max]))
  assert.deepEqual(maxes, {
    'ci-check-runs': 1, 'ci-commit-status': 1, 'ci-pr-checks': 0, 'ci-pr-by-commit': 0, 'workflow-file': 2,
    'tool-inventory': 2, 'runner-verify': 2, 'blocker-probe': 4, 'repo-identity': 2, 'runner-discover': 2,
  })
})

test('a forbidden source declared with zero calls is not a violation; a padded id is still the id', () => {
  assert.deepEqual(audit('ci-pr-checks', 0), [])
  assert.deepEqual(audit(' ci-check-runs ', 1), [])
})

test('a zero call count is a count', () => {
  assert.equal(probeCallCount('x', 0), 0)
})

test('the declaration block gives each source its own row, forbidden ones marked', () => {
  const block = probeDeclarationBlock()
  assert.match(block, /\n {3}- `ci-check-runs`: at most 1 \([^)]*\)\n {3}- `ci-commit-status`: at most 1/)
  assert.match(block, /\n {3}- `ci-pr-checks`: FORBIDDEN \(/)
})
