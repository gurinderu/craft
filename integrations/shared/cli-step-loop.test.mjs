// The step rounds any kind of run drives (integrations/shared/cli-step-loop.mjs): the kind's hooks called in order, and
// each way the loop ends.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { stepRounds } from './cli-step-loop.mjs'

/** @typedef {{ run: string, done: false, n: number }} Pending */
/** @typedef {{ run: string, done: true, verdict: string }} Done */

/**
 * A kind whose submits read `reads` in turn, logging each hook it is called through.
 * @param {Array<{ step: Pending | Done } | { error: string }>} reads @param {string[]} calls
 * @returns {import('./cli-step-loop.mjs').Rounds<Pending, Done, string>}
 */
const kind = (reads, calls) => ({
  maxRounds: 2,
  dispatch: async (step, round) => {
    calls.push(`dispatch ${step.n} r${round}`)
  },
  submit: async (_, round) => {
    calls.push(`submit r${round}`)
    return reads.shift() ?? { error: 'none left' }
  },
  heard: step => {
    calls.push(`heard ${step.done ? 'done' : step.n}`)
  },
  lost: async read => `lost: ${read.error}`,
  gaveUp: step => `gave up at ${step.n}`,
  finished: step => `finished: ${step.verdict}`,
})

test('rounds run until the binary is done, each step read heard', async () => {
  const calls = /** @type {string[]} */ ([])
  const ended = await stepRounds({ run: 'r', done: false, n: 1 }, kind([{ step: { run: 'r', done: true, verdict: 'Approve' } }], calls))
  assert.equal(ended, 'finished: Approve')
  assert.deepEqual(calls, ['dispatch 1 r1', 'submit r1', 'heard done'])
})

test('a first step already done dispatches nothing', async () => {
  const calls = /** @type {string[]} */ ([])
  assert.equal(await stepRounds({ run: 'r', done: true, verdict: 'Block' }, kind([], calls)), 'finished: Block')
  assert.deepEqual(calls, [])
})

test('a step that could not be read ends the run as the kind says, unheard', async () => {
  const calls = /** @type {string[]} */ ([])
  assert.equal(await stepRounds({ run: 'r', done: false, n: 1 }, kind([{ error: 'garbled' }], calls)), 'lost: garbled')
  assert.deepEqual(calls, ['dispatch 1 r1', 'submit r1'])
})

test('past maxRounds the driver gives up on the step it holds', async () => {
  const calls = /** @type {string[]} */ ([])
  const more = /** @param {number} n */ n => ({ step: /** @type {Pending} */ ({ run: 'r', done: false, n }) })
  assert.equal(await stepRounds({ run: 'r', done: false, n: 1 }, kind([more(2), more(3)], calls)), 'gave up at 3')
  assert.deepEqual(calls, ['dispatch 1 r1', 'submit r1', 'heard 2', 'dispatch 2 r2', 'submit r2', 'heard 3'])
})
