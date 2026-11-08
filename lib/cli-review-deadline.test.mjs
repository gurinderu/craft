// A cli-review task agent that never answers is cut at its kind's deadline, as the review engine cuts it
// (lib/cli-review-deadline.mjs, lib/review-deadlines.mjs): the wait is abandoned, it counts as dead — never re-run on
// the default type — and the run goes on to its submit, which tells the binary what came back. The deadlines are the
// engine's own (90 min for a lens, 30 for a verifier), so the host's timers are faked and moved on a minute at a time.
import { test, vi } from 'vitest'
import { setImmediate as realTurn } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { deadlined, taskDeadlineMs } from './cli-review-deadline.mjs'
import { runEngine } from './engine-harness.mjs'

const RUN = '/tmp/craft-run-deadline'
/** @param {string} id @param {string} kind @param {string} [agentType] */
const task = (id, kind, agentType) => ({
  id, label: `${id}:x`, model: 'sonnet', kind, ...(agentType ? { agentType } : {}),
  promptFile: `${RUN}/tasks/${id}.md`, schemaFile: `${RUN}/tasks/${id}.schema.json`, answerFile: `${RUN}/answers/${id}.json`,
})
/** @param {unknown} value */
const ran = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })

/**
 * `run()` with the host's timers faked, moved on a minute at a time until it settles.
 * @template T @param {() => Promise<T>} run @returns {Promise<T>}
 */
async function onFakeTimers(run) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let settled = false
    const p = run().finally(() => { settled = true })
    // The engine is built and its files read on the real clock first: each faked minute waits for real I/O to turn.
    for (let minute = 0; minute < 5000 && !settled; minute++) {
      await vi.advanceTimersByTimeAsync(60_000)
      await realTurn()
    }
    return await p
  } finally {
    vi.useRealTimers()
  }
}

test('a task agent that never answers is abandoned at its kind\'s deadline, never re-run, and the run goes on', async () => {
  const hang = () => new Promise(() => {})
  const run = await onFakeTimers(() => runEngine('cli-review', {
    args: { repo: '/work/repo', craftBin: '/opt/craft' },
    script: {
      'step:start': ran({ run: RUN, done: false, tasks: [task('lens', 'lens', 'rust-reviewer'), task('verify', 'verify'), task('scout', 'scout')] }),
      lens: hang, verify: hang, scout: 'done',
      'step:submit:1': ran({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'INCOMPLETE' }),
      checkpoint: { runDir: '/store/.partial/run-A', error: '' },
      'log-run': { ok: true, output: ['wrote /store/r.json'] },
    },
  }))
  assert.deepEqual(run.calls.map(c => c.label), ['step:start', 'checkpoint:start', 'lens:x', 'verify:x', 'scout:x', 'step:submit:1', 'log-run'], 'each task dispatched once, then the submit')
  const fired = run.logs.filter(l => l.startsWith('⏱️'))
  assert.equal(fired.length, 2, run.logs.join('\n'))
  assert.match(String(fired[0]), /^⏱️ task agent 'verify:x' exhausted its 30min budget with no response — abandoning the wait .*treated as a dead agent/)
  assert.match(String(fired[1]), /^⏱️ task agent 'lens:x' exhausted its 90min budget with no response/)
  assert.ok(!run.logs.some(l => /re-running/.test(l)), 'a deadline fire is not re-run on the default type')
  assert.match(run.report, /INCOMPLETE/)
})

test('each kind takes the engine\'s phase deadline; an answer in time comes back and leaves no timer armed', async () => {
  assert.deepEqual(['scout', 'lens', 'criticLens', 'verify', 'dedup', 'adjudicate', 'critic', 'warmup', undefined].map(taskDeadlineMs),
    [900000, 5400000, 5400000, 1800000, 1800000, 1800000, 1800000, 900000, 1800000])
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    /** @type {Record<string, unknown>[]} */
    const seen = []
    const call = deadlined(async (_p, opts) => { seen.push(opts); return 'done' }, () => assert.fail('no fire'))
    assert.equal(await call('p', { label: 'l', deadlineMs: 1000 }), 'done')
    assert.deepEqual(seen, [{ label: 'l' }], 'the deadline is the driver\'s, never agent()\'s option')
    assert.equal(vi.getTimerCount(), 0)
  } finally {
    vi.useRealTimers()
  }
})
