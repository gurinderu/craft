import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'vitest'

import { STOP_CAUSES, UNFINISHED, stopCause, stopNotRun, stopRead } from './cli-review-stop.mjs'

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
