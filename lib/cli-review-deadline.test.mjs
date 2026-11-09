// A review task agent that never answers is cut at its kind's deadline, as the review engine cuts it
// (lib/cli-review-deadline.mjs, lib/review-deadlines.mjs): the wait is abandoned, it counts as dead — never re-run on
// the default type — and the run goes on to its submit, which tells the binary what came back. The deadlines are the
// engine's own (90 min for a lens, 30 for a verifier), so the host's timers are faked and moved on a minute at a time.
import { test, vi } from 'vitest'
import { setTimeout as realSleep } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { deadlined, taskCut, taskDeadlineMs } from './cli-review-deadline.mjs'
import { runEngine } from './engine-harness.mjs'

const RUN = '/tmp/craft-run-deadline'
/** @param {string} id @param {string} kind @param {string} [agentType] */
const task = (id, kind, agentType) => ({
  id, label: `${id}:x`, model: 'sonnet', kind, ...(agentType ? { agentType } : {}),
  promptFile: `${RUN}/tasks/${id}.md`, schemaFile: `${RUN}/tasks/${id}.schema.json`, answerFile: `${RUN}/answers/${id}.json`,
})
/** @param {unknown} value */
const ran = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })

// The faked minutes moved on so far, read by a scripted agent to tell when it was dispatched.
let fakeMinute = 0

/**
 * `run()` with the host's timers faked, moved on a minute at a time until it settles.
 * @template T @param {() => Promise<T>} run @returns {Promise<T>}
 */
async function onFakeTimers(run) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fakeMinute = 0
  try {
    let settled = false
    const p = run().finally(() => { settled = true })
    // The engine is built and its files read on the real clock (a busy machine may take seconds): each faked minute
    // waits a real millisecond, bounded by about a minute of real time.
    for (let turn = 0; turn < 50_000 && !settled; turn++) {
      await vi.advanceTimersByTimeAsync(60_000)
      fakeMinute++
      await realSleep(1)
    }
    if (!settled) throw new Error(`the run did not settle in ${fakeMinute} faked minutes`)
    return await p
  } finally {
    vi.useRealTimers()
  }
}

test('a task agent that never answers is abandoned at its kind\'s deadline, never re-run, and the run goes on', async () => {
  const hang = () => new Promise(() => {})
  const run = await onFakeTimers(() => runEngine('review', {
    args: { repo: '/work/repo', craftBin: '/opt/craft' },
    script: {
      'step:locate': { exitCode: 0, stdout: 'root=/opt/plugin\n', stderr: '' },
      'step:start': ran({ run: RUN, done: false, tasks: [task('lens', 'lens', 'rust-reviewer'), task('verify', 'verify'), task('scout', 'scout')] }),
      lens: hang, verify: hang, scout: 'done',
      'step:submit:1': ran({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'INCOMPLETE' }),
    },
  }))
  assert.deepEqual(run.calls.map(c => c.label), ['step:locate', 'step:start', 'lens:x', 'verify:x', 'scout:x', 'step:submit:1'], 'each task dispatched once, then the submit')
  const submit = String(run.calls.find(c => c.label === 'step:submit:1')?.prompt)
  assert.match(submit, /review submit --run '[^']+' --abandoned 'verify' --abandoned 'lens' --agents 3 --output-tokens \d+$/m, 'the binary is told which tasks were abandoned, so it fails them and never hands them out again')
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
    /** @type {(prompt: string, opts: { label: string, cut: import('./cli-review-deadline.mjs').Cut }) => Promise<unknown>} */
    const call = deadlined(async (/** @type {string} */ _p, /** @type {{ label: string }} */ opts) => { seen.push(opts); return 'done' })
    const cut = taskCut('lens')
    assert.equal(await call('p', { label: 'l', cut }), 'done')
    cut.dispose()
    assert.deepEqual([seen, cut.fired], [[{ label: 'l' }], false], 'the deadline is the driver\'s, never agent()\'s option')
    assert.equal(vi.getTimerCount(), 0)
  } finally {
    vi.useRealTimers()
  }
})

test('a typed task and its re-run on the default type share one budget: the re-run waits only what is left', async () => {
  let dispatched = -1
  let submitted = -1
  const run = await onFakeTimers(() => runEngine('review', {
    args: { repo: '/work/repo', craftBin: '/opt/craft' },
    script: {
      'step:start': ran({ run: RUN, done: false, tasks: [task('lens', 'lens', 'rust-reviewer')] }),
      // The typed agent dies after 80 minutes; its re-run on the default type never answers.
      lens: (/** @type {{ opts: { agentType?: string } }} */ { opts }) => {
        if (!opts.agentType) return new Promise(() => {})
        dispatched = fakeMinute
        return new Promise(resolve => { setTimeout(() => resolve(null), 80 * 60_000) })
      },
      'step:submit:1': () => { submitted = fakeMinute; return ran({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'INCOMPLETE' }) },
    },
  }))
  assert.deepEqual(run.calls.filter(c => c.label === 'lens:x').map(c => c.opts.agentType ?? 'default'), ['craft:rust-reviewer', 'default'])
  const waited = submitted - dispatched
  assert.ok(waited >= 89 && waited <= 91, `cut at the task's 90 minutes, not 80 + 90 (${waited})`)
  assert.match(String(run.calls.find(c => c.label === 'step:submit:1')?.prompt), /--abandoned 'lens' --agents 2 --output-tokens \d+$/m)
})

test('a typed task dead with less than the floor left of its budget is not re-run on the default type', async () => {
  const run = await onFakeTimers(() => runEngine('review', {
    args: { repo: '/work/repo', craftBin: '/opt/craft' },
    script: {
      'step:start': ran({ run: RUN, done: false, tasks: [task('lens', 'lens', 'rust-reviewer')] }),
      // Dies with 30 s of its 90 min left, under the engine's one-minute floor.
      lens: () => new Promise(resolve => { setTimeout(() => resolve(null), 89.5 * 60_000) }),
      'step:submit:1': ran({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'INCOMPLETE' }),
      checkpoint: { runDir: '/store/.partial/run-A', error: '' },
      'log-run': { ok: true, output: ['wrote /store/r.json'] },
    },
  }))
  assert.equal(run.calls.filter(c => c.label === 'lens:x').length, 1, 'no re-run into a budget it could not answer in')
  assert.ok(run.logs.some(l => /NOT re-dispatching/.test(l)), run.logs.join('\n'))
  assert.doesNotMatch(String(run.calls.find(c => c.label === 'step:submit:1')?.prompt), /--abandoned/, 'a death, not a deadline fire: the binary asks for it again')
})
