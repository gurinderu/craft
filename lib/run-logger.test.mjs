// makeRunLogger and telemetryLossNoter: the run-record writer every engine binds as its `logRun`.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { makeRunLogger, telemetryLossNoter } from './run-logging.mjs'

/** @typedef {{ prompt: string, opts: { label: string, phase: string } }} Sent */

/** @param {unknown} answer */
function recorder(answer) {
  /** @type {Sent[]} */
  const sent = []
  /** @type {[string, string, boolean][]} */
  const notes = []
  return {
    sent,
    notes,
    /** @param {string} prompt @param {{ label: string, phase: string }} opts */
    call: async (prompt, opts) => { sent.push({ prompt, opts }); return answer },
    /** @param {string} what @param {string} why @param {boolean} landed */
    noteLoss: (what, why, landed) => { notes.push([what, why, landed]) },
  }
}

/** @param {string} prompt */
const recordIn = prompt => JSON.parse(/** @type {string} */ (prompt.match(/\nRECORD:\n([\s\S]+)$/)?.[1]))

test('makeRunLogger: one dispatch under the bound phase, carrying the prepared record', async () => {
  const r = recorder({ ok: true, error: '' })
  const logRun = makeRunLogger({
    call: r.call, phase: 'Plan', noteLoss: r.noteLoss,
    target: () => ({ craftRoot: '/opt/craft' }),
    prepare: rec => ({ ...rec, stamped: 3 }),
  })
  await logRun({ name: 'x', craftVersion: '1.2.3' })
  assert.equal(r.sent.length, 1)
  const [sent] = r.sent
  assert.equal(sent?.opts.phase, 'Plan')
  assert.match(String(sent?.opts.label), /^log-run/)
  assert.deepEqual(recordIn(String(sent?.prompt)), { name: 'x', craftVersion: '1.2.3', stamped: 3 })
  assert.ok(String(sent?.prompt).includes(`'/opt/craft'`), 'the bound craftRoot reaches the prelude')
  assert.deepEqual(r.notes, [], 'a clean landing notes nothing')
})

test('makeRunLogger: the target is read at each call, not when the logger is bound', async () => {
  const r = recorder({ ok: true })
  let dir = ''
  const logRun = makeRunLogger({ call: r.call, phase: 'P', noteLoss: r.noteLoss, target: () => ({ command: 'finalize', dir }) })
  dir = '/store/.partial/run-A'
  await logRun({})
  assert.match(String(r.sent[0]?.prompt), /finalize --dir '\/store\/\.partial\/run-A' /)
})

test('makeRunLogger: without prepare the record goes out as given', async () => {
  const r = recorder({ ok: true })
  await makeRunLogger({ call: r.call, phase: 'P', noteLoss: r.noteLoss, target: () => ({}) })({ a: 1 })
  assert.deepEqual(recordIn(String(r.sent[0]?.prompt)), { a: 1 })
})

test('makeRunLogger: a lost record and a landed one with a refused directory are noted apart', async () => {
  const lost = recorder({ __threw: 'boom' })
  await makeRunLogger({ call: lost.call, phase: 'P', noteLoss: lost.noteLoss, target: () => ({}) })({})
  assert.deepEqual(lost.notes, [['the run record', 'boom', false]])

  const dead = recorder(null)
  await makeRunLogger({ call: dead.call, phase: 'P', noteLoss: dead.noteLoss, target: () => ({}) })({})
  assert.deepEqual(dead.notes, [['the run record', 'the logger agent returned no result', false]])

  const landed = recorder({ ok: true, error: 'craft-log-run WARNING: x' })
  await makeRunLogger({ call: landed.call, phase: 'P', noteLoss: landed.noteLoss, target: () => ({}) })({})
  assert.deepEqual(landed.notes, [['the run directory (the record itself landed)', 'craft-log-run WARNING: x', true]])
})

test('telemetryLossNoter: every loss is kept; only a lost write is logged as lost', () => {
  /** @type {string[]} */
  const lost = []
  /** @type {string[]} */
  const said = []
  const note = telemetryLossNoter(lost, line => { said.push(line) })
  note('the run record', 'boom', false)
  note('the run directory (the record itself landed)', 'craft-log-run WARNING: x', true)
  assert.deepEqual(lost, [
    'the run record — boom',
    'the run directory (the record itself landed) — craft-log-run WARNING: x',
  ])
  assert.deepEqual(said, [
    '⚠️ telemetry lost: the run record — boom',
    '⚠️ telemetry: craft-log-run WARNING: x',
  ])
})
