// lib/craft-review-run.mjs against a stand-in for bin/craft: a script that prints the events and the answer a run
// prints, with the argv it was given as its first event.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { START, advance, answerText, flagWords, progressLine, runReview, summaryOf } from './craft-review-run.mjs'
import { writeExecutable } from './write-executable.mjs'

const ANSWER = '## Verdict\n\n⛔ Block\n\nReport: /r/report.md\n\n## Findings\n\n- [High] a.rs:3 — bug (opus)\n- [Low] b.rs — nit\n\n## Notes\n\n- not a finding\n'

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
