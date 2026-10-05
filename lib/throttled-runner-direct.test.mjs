// Direct tests of lib/throttled-runner.mjs at the edges throttled-runner.test.mjs leaves open: the
// batch size of the first round against the retry rounds, the budget floor at equality, and the
// not-run label and severity unjudgedNotRun derives.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { makeThrottledRunner, unjudgedNotRun } from './throttled-runner.mjs'

/** @param {{ remaining?: number, failFirst?: boolean }} [opts] */
function runner({ remaining = Infinity, failFirst = false } = {}) {
  /** @type {number[]} */
  const batches = []
  /** @type {Set<string>} */
  const failedOnce = new Set()
  const run = makeThrottledRunner({
    agent: async (_prompt, opts) => {
      if (!failFirst || opts.label.startsWith('retry') || failedOnce.has(opts.label)) return { ok: true }
      failedOnce.add(opts.label)
      return null
    },
    parallel: async fns => { batches.push(fns.length); return Promise.all(fns.map(f => f())) },
    log: () => {},
    markNotRun: () => {},
    batch: 2,
    retryBatch: 1,
    maxRetryRounds: 1,
    budget: { total: 1000, remaining: () => remaining },
    budgetFloor: 500,
  })
  /** @param {string} label */
  const job = label => ({ prompt: 'p', label, onResult: () => {} })
  return { run, batches, job }
}

test('the first round runs in batches of `batch`, the retry rounds in batches of `retryBatch`', async () => {
  const r = runner({ failFirst: true })
  const left = await r.run([r.job('a'), r.job('b')], 'Verify', 'Verify')
  assert.deepEqual(left, [])
  assert.deepEqual(r.batches, [2, 1, 1])
})

test('a budget exactly at the floor still runs', async () => {
  const r = runner({ remaining: 500 })
  const left = await r.run([r.job('a')], 'Verify', 'Verify')
  assert.deepEqual([left, r.batches], [[], [1]])
})

test('unjudgedNotRun: the label is a slug of the tag, "checks" when there is none', () => {
  assert.equal(unjudgedNotRun('Verify  Pass!', 1)[0]?.label, 'verify-pass-checks-unjudged')
  assert.equal(unjudgedNotRun('', 1)[0]?.label, 'checks-checks-unjudged')
})

test('unjudgedNotRun: with no declared total, a gap is never a whole-pass loss', () => {
  assert.equal(unjudgedNotRun('Verify', 2)[0]?.incomplete, false)
})
