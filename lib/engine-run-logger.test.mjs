// What each engine's `logRun` does with the logger agent, executed rather than pattern-matched. The
// four engines bind ONE writer (lib/run-logging.mjs, makeRunLogger) with their own phase, target and
// loss note; these pin what each binding must keep doing, so the binding cannot drift unseen.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord, RECORD_FILING_ENGINES } from './engine-harness.mjs'
import { ENGINE_REVISION } from './run-record.mjs'

/** @type {Record<string, any>} */
const ARGS = { 'triage-findings': { pr: '60' } }
/** @param {string} engine */
const argsFor = engine => ({ ...(ARGS[engine] || {}) })

// The phase the record write is dispatched under, per engine: the last phase each one runs.
/** @type {Record<string, string>} */
const PHASE = { review: 'Synthesize', 'adversarial-review': 'Coverage', 'rust-audit': 'Synthesize', 'triage-findings': 'Plan' }
const WARNING = 'craft-log-run WARNING: --dir /tmp/elsewhere is not inside the store'

test('every record-filing engine has its phase pinned here', () => {
  assert.deepEqual([...RECORD_FILING_ENGINES].sort(), Object.keys(PHASE).sort())
})

for (const engine of RECORD_FILING_ENGINES) {
  test(`${engine}: the record write is dispatched under the engine's own phase`, async () => {
    const run = await runEngine(engine, { args: argsFor(engine), script: {} })
    const writes = run.calls.filter(c => /^log-run/.test(c.label))
    assert.ok(writes.length, 'the engine must attempt to file a record')
    for (const c of writes) assert.equal(c.opts.phase, PHASE[engine])
  })

  test(`${engine}: a lost record is logged as lost, naming the write`, async () => {
    const run = await runEngine(engine, { args: argsFor(engine), script: {} })
    assert.ok(run.logs.some(l => l.startsWith('⚠️ telemetry lost: the run record — ')), run.logs.join('\n'))
  })
}

for (const engine of RECORD_FILING_ENGINES.filter(e => e !== 'review')) {
  test(`${engine}: a landed record with a refused directory is logged under its own prefix`, async () => {
    const run = await runEngine(engine, { args: argsFor(engine), script: { 'log-run': { ok: true, error: WARNING }, '*': null } })
    assert.ok(run.logs.includes(`⚠️ telemetry: ${WARNING}`), run.logs.join('\n'))
    assert.ok(!run.logs.some(l => /telemetry lost: the run directory/.test(l)), 'a landed record is not logged as lost')
  })

  test(`${engine}: writes with the plain write command, in the session's own checkout`, async () => {
    const run = await runEngine(engine, { args: argsFor(engine), script: {} })
    const call = run.calls.find(c => /^log-run/.test(c.label))
    assert.match(String(call?.prompt), /node "\$CRAFT_LOGGER" write /)
    assert.match(String(call?.prompt), /cd '\.' && /)
    assert.ok(!('workflowEngineRevision' in (filedRecord(run) || {})), 'the fingerprint basis is review\'s field')
  })
}

test('review: the record write finalizes, and stamps the fingerprint basis last', async () => {
  const run = await runEngine('review', { args: {}, script: {} })
  const call = run.calls.find(c => /^log-run/.test(c.label))
  assert.match(String(call?.prompt), /node "\$CRAFT_LOGGER" finalize /)
  assert.equal(filedRecord(run)?.workflowEngineRevision, ENGINE_REVISION)
})

test('review: a landed record with a refused directory is logged and reported as landed, not lost', async () => {
  // A landed record must not read as lost (realm @nick/craft #39) — in the log as in the report.
  const run = await runEngine('review', { args: {}, script: { 'log-run': { ok: true, error: WARNING }, '*': null } })
  assert.ok(run.logs.includes(`⚠️ telemetry: ${WARNING}`), run.logs.join('\n'))
  assert.ok(!run.logs.some(l => /telemetry lost: the run directory/.test(l)), 'a landed record is not logged as lost')
  assert.match(run.report, /## ⚠️ Telemetry incomplete/)
  assert.ok(!/## ⚠️ Telemetry lost/.test(run.report), 'nor headed as lost in the report')
  assert.match(run.report, /- the run directory \(the record itself landed\) — craft-log-run WARNING/)
})

test('review: a lost record is reported under the lost heading, naming the write', async () => {
  const run = await runEngine('review', { args: {}, script: {} })
  assert.match(run.report, /## ⚠️ Telemetry lost/)
  assert.match(run.report, /- the run record — /)
})
