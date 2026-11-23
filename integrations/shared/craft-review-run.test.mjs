// integrations/shared/craft-review-run.mjs against a stand-in for bin/craft: a script that prints the events and the answer a run
// prints, with the argv it was given as its first event.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { START, advance, answerText, delegation, flagWords, progressLine, runReview, summaryOf } from './craft-review-run.mjs'
import { writeExecutable } from './write-executable.mjs'

const ANSWER =
  '## Verdict\n\n⛔ Block\n\nReport: /r/report.md\n\n## Findings\n\n- [High] a.rs:3 — bug (opus)\n- [Low] b.rs — nit\n\n## Notes\n\n- not a finding\n'

/** A stand-in wrapper that runs `body` (sh). @param {string} body */
function fake(body) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-run-')), 'craft')
  writeExecutable(file, `#!/bin/sh\n${body}\n`)
  return file
}

const EVENTS = [
  { type: 'log', line: 'run=/r' },
  { type: 'round', round: 1, phase: 'lenses', tasks: 2 },
  { type: 'task_started', id: 't1', label: 'a', agent: null, model: null, tier: 'opus' },
  { type: 'task_started', id: 't2', label: 'b', agent: null, model: null, tier: 'opus' },
  { type: 'task_finished', id: 't1', tokens: null, cost_usd: null },
  { type: 'task_failed', id: 't2', reason: 'boom' },
  { type: 'result', verdict: 'Block', report: '/r/report.md', run: '/r', findings: 2, exit_code: 1 },
]

test('a run is read to its end: the argv, each progress change, the result and the answer', async () => {
  const lines = EVENTS.map(e => `echo '${JSON.stringify(e)}' >&2`).join('\n')
  const wrapper = fake(`printf '{"type":"argv","argv":"%s"}\\n' "$*" >&2\n${lines}\nprintf '%s' '${ANSWER}'\nexit 1`)
  /** @type {string[]} */
  const seen = []
  const got = await runReview({ backend: 'pi', args: ['--base', 'main'], cwd: os.tmpdir(), wrapper, onProgress: p => seen.push(progressLine(p)) })
  assert.equal(got.code, 1)
  assert.equal(got.answer, ANSWER)
  assert.deepEqual(got.said, [])
  assert.deepEqual(seen, [
    'craft review: starting — 0 running, 0 done',
    'craft review: lenses, round 1 — 0 running, 0 done',
    'craft review: lenses, round 1 — 1 running, 0 done',
    'craft review: lenses, round 1 — 2 running, 0 done',
    'craft review: lenses, round 1 — 1 running, 1 done',
    'craft review: lenses, round 1 — 0 running, 1 done, 1 failed',
  ])
  assert.deepEqual(summaryOf(got), { verdict: 'Block', report: '/r/report.md', run: '/r', findings: ['- [High] a.rs:3 — bug (opus)', '- [Low] b.rs — nit'] })
  assert.equal(answerText(got), ANSWER.trim())
})

test('the wrapper is given the backend, the event stream and the flags', async () => {
  const wrapper = fake('echo "$*" >&2')
  const got = await runReview({ backend: 'opencode', args: ['--models', 'a/b'], cwd: os.tmpdir(), wrapper })
  assert.deepEqual(got.said, ['review run --backend opencode --events json --models a/b'])
})

test('a wrapper that fails before any event is said in the answer, INCOMPLETE', async () => {
  const wrapper = fake("echo 'craft: neither curl nor wget is on the PATH' >&2; exit 127")
  const got = await runReview({ backend: 'pi', args: [], cwd: os.tmpdir(), wrapper })
  assert.equal(got.code, 127)
  assert.equal(got.result, null)
  assert.deepEqual(summaryOf(got), { verdict: 'INCOMPLETE', report: null, run: null, findings: [] })
  assert.equal(answerText(got), '## Verdict\n\nINCOMPLETE — the craft review gave no answer (exit 127):\n\ncraft: neither curl nor wget is on the PATH')
})

test('an abort stops the run', async () => {
  const wrapper = fake('exec sleep 30')
  const stop = new AbortController()
  const running = runReview({ backend: 'pi', args: [], cwd: os.tmpdir(), wrapper, signal: stop.signal })
  stop.abort()
  await assert.rejects(running, /abort/i)
})

test('flags split as a shell splits words, quotes kept together', () => {
  assert.deepEqual(flagWords(` --base main  --path "a b" --optional='x y'z `), ['--base', 'main', '--path', 'a b', '--optional=x yz'])
  assert.deepEqual(flagWords(''), [])
})

test('an event of no known kind changes nothing; a usage limit is the line', () => {
  assert.equal(advance(START, { type: 'degraded', note: 'n' }), START)
  assert.equal(advance(START, { type: 'usage_limit', text: 'try later' }).line, 'usage limit: try later')
  assert.equal(advance(START, { type: 'phase', name: 'verify' }).phase, 'verify')
})

const TASK = { type: 'task', key: 3, id: 't1', label: 'lens a', agent: 'review-task', model: 'p/m', prompt: 'read p.md' }

test('a delegated run hands each task to onTask and writes its reply to the binary under the key', async () => {
  // The stand-in emits a task, then says back the line it read on stdin.
  const wrapper = fake(`echo '${JSON.stringify(TASK)}' >&2\nread -r line\necho "argv:$*" >&2\nprintf 'got:%s\\n' "$line" >&2`)
  /** @type {unknown[]} */
  const seen = []
  const got = await runReview({
    backend: 'opencode',
    args: ['--base', 'main'],
    cwd: os.tmpdir(),
    wrapper,
    onTask: (task, signal) => {
      seen.push(task, signal.aborted)
      return Promise.resolve('```craft-answer\n{}\n```')
    },
  })
  assert.deepEqual(seen, [TASK, false])
  assert.deepEqual(got.said, [
    'argv:review run --backend opencode --events json --delegate --base main',
    `got:${JSON.stringify({ key: 3, text: '```craft-answer\n{}\n```' })}`,
  ])
})

test("a task that fails is said to the binary as its error, by the failure's message", async () => {
  const wrapper = fake(`echo '${JSON.stringify(TASK)}' >&2\nread -r line\nprintf 'got:%s\\n' "$line" >&2`)
  const got = await runReview({
    backend: 'opencode',
    args: [],
    cwd: os.tmpdir(),
    wrapper,
    onTask: () => Promise.reject(new Error('the child session failed (provider.no-route): no route')),
  })
  assert.deepEqual(got.said, [`got:${JSON.stringify({ key: 3, error: 'the child session failed (provider.no-route): no route' })}`])
})

test('a cancelled task is aborted, and so is every task still running once the binary is gone', () => {
  /** @type {AbortSignal[]} */
  const signals = []
  const never = new Promise(() => {})
  const d = delegation(
    (_t, signal) => {
      signals.push(signal)
      return /** @type {Promise<string>} */ (never)
    },
    () => {},
  )
  d.heard({ ...TASK, key: 1 })
  d.heard({ ...TASK, key: 2 })
  d.heard({ type: 'task_cancelled', key: 1 })
  assert.deepEqual(
    signals.map(s => s.aborted),
    [true, false],
  )
  d.stop()
  assert.deepEqual(
    signals.map(s => s.aborted),
    [true, true],
  )
})

test('a run that delegates nothing gives the binary no input and no --delegate', async () => {
  const wrapper = fake('echo "$*" >&2; if read -r line; then echo "read:$line" >&2; fi')
  const got = await runReview({ backend: 'pi', args: [], cwd: os.tmpdir(), wrapper })
  assert.deepEqual(got.said, ['review run --backend pi --events json'])
})

test('a settled task is no longer running: a later cancel or stop leaves it be, and a cancel of no task is passed over', async () => {
  /** @type {AbortSignal[]} */
  const signals = []
  /** @type {string[]} */
  const replies = []
  const d = delegation(
    (_t, signal) => {
      signals.push(signal)
      return Promise.resolve('ok')
    },
    line => replies.push(line),
  )
  d.heard({ type: 'task_cancelled', key: 9 })
  d.heard({ ...TASK, key: 1 })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(replies, [JSON.stringify({ key: 1, text: 'ok' })])
  d.heard({ type: 'task_cancelled', key: 1 })
  d.stop()
  assert.equal(signals[0]?.aborted, false)
})

test('a reply that comes after the binary is gone is lost with it, not thrown', async () => {
  const wrapper = fake(`echo '${JSON.stringify(TASK)}' >&2\nexit 0`)
  const got = await runReview({
    backend: 'opencode',
    args: [],
    cwd: os.tmpdir(),
    wrapper,
    onTask: () => new Promise(resolve => setTimeout(() => resolve('late'), 50)),
  })
  assert.equal(got.code, 0)
  await new Promise(resolve => setTimeout(resolve, 100))
})

test('a task still running when the binary exits is aborted', async () => {
  const wrapper = fake(`echo '${JSON.stringify(TASK)}' >&2\nsleep 0.2\nexit 1`)
  /** @type {AbortSignal[]} */
  const signals = []
  await runReview({
    backend: 'opencode',
    args: [],
    cwd: os.tmpdir(),
    wrapper,
    onTask: (_t, signal) => {
      signals.push(signal)
      return new Promise(() => {})
    },
  })
  assert.equal(signals.length, 1)
  assert.equal(signals[0]?.aborted, true)
})
