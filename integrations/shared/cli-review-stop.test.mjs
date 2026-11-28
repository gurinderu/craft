import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'vitest'

import { STOP_CAUSES, UNFINISHED, recoveryFailure, stopCause, stopNotRun, stopRead } from './cli-review-stop.mjs'

const parity = JSON.parse(fs.readFileSync(new URL('../../content/parity/stop-causes.json', import.meta.url), 'utf8'))

test('the cause lines are the ones the binary files too (content/parity/stop-causes.json)', () => {
  assert.equal(UNFINISHED, parity.unfinished)
  for (const [cause, line] of Object.entries(STOP_CAUSES)) assert.equal(line, parity.causes[cause], cause)
  assert.deepEqual(
    Object.keys(parity.causes).filter(c => !(c in STOP_CAUSES)),
    ['host'],
    'only the binary drives a host',
  )
})

test("a stop's cause: the harness's refusal, the usage limit, else the caller's", () => {
  assert.equal(stopCause({ error: 'refused', harness: '' }, 'step'), 'harness')
  assert.equal(stopCause({ error: "stopped: usage limit reached (You've hit your limit)" }, 'start'), 'limit')
  assert.equal(stopCause({ error: 'the command printed no JSON' }, 'step'), 'step')
  assert.deepEqual(stopNotRun('rounds'), [UNFINISHED, "stopped: the driver's round backstop was reached"])
})

test('a known limit replaces a lost answer, but not an explicit harness refusal', () => {
  const lost = { error: 'the command printed no JSON' }
  const refused = { error: 'permission denied', harness: '/bin/craft review submit' }
  assert.deepEqual(stopRead(lost, 'weekly limit'), { error: 'stopped: usage limit reached (weekly limit)' })
  assert.deepEqual(stopRead(lost, ''), lost)
  assert.deepEqual(stopRead(refused, 'weekly limit'), refused)
})

test('recovery distinguishes a failed command from a lost answer, including an unquoted harness refusal', () => {
  const command = "/b/craft review status --run '/r' --brief"
  for (const code of [1, 2, 124, 137]) {
    const got = { exitCode: code, stdout: '', stderr: 'cannot read state' }
    assert.deepEqual(recoveryFailure(got, command), { error: `\`${command}\`: the command exited ${String(code)}: cannot read state` })
  }
  assert.deepEqual(recoveryFailure({ exitCode: 1, stdout: '', stderr: 'Permission for this action was denied. The command was not run.' }, command), {
    error: "the harness's permission check refused the command, not craft: it quoted none",
    harness: '',
  })
  for (const got of [null, {}, { limit: 'weekly limit' }, { cut: 'page unreadable' }, { exitCode: 0, stdout: 'cut JSON', stderr: '' }])
    assert.equal(recoveryFailure(got, command), null)
})
