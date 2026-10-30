// What each engine's `logRun` does with the logger agent, executed rather than pattern-matched. The
// four engines bind ONE writer (lib/run-logging.mjs, makeRunLogger) with their own phase, target and
// loss note; these pin what each binding must keep doing, so the binding cannot drift unseen.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord, RECORD_FILING_ENGINES } from './engine-harness.mjs'
import { ENGINE_REVISION } from './run-record.mjs'
import { MISSED_STRUCTURED_OUTPUT } from './run-logging.mjs'

/** @type {Record<string, any>} */
const ARGS = { 'triage-findings': { pr: '60' } }
/** @param {string} engine */
const argsFor = engine => ({ ...(ARGS[engine] || {}) })

// The phase the record write is dispatched under, per engine: the last phase each one runs.
/** @type {Record<string, string>} */
const PHASE = { review: 'Synthesize', 'adversarial-review': 'Coverage', 'rust-audit': 'Synthesize', 'triage-findings': 'Plan' }
const WARNING = 'craft-log-run WARNING: --dir /tmp/elsewhere is not inside the store'
const SUCCESS = 'wrote /store/2026-10-30-review.json (folded 3 checkpoint(s))'

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
    const run = await runEngine(engine, { args: argsFor(engine), script: { 'log-run': { ok: true, output: [SUCCESS, WARNING] }, '*': null } })
    assert.ok(run.logs.includes(`⚠️ telemetry: ${WARNING}`), run.logs.join('\n'))
    assert.ok(!run.logs.some(l => /telemetry lost: the run directory/.test(l)), 'a landed record is not logged as lost')
  })

  // adversarial-review finalizes (its start checkpoint, below); the other two write.
  test(`${engine}: writes with its own command, in the session's own checkout`, async () => {
    const run = await runEngine(engine, { args: argsFor(engine), script: {} })
    const call = run.calls.find(c => /^log-run/.test(c.label))
    assert.match(String(call?.prompt), engine === 'adversarial-review' ? /node "\$CRAFT_LOGGER" finalize / : /node "\$CRAFT_LOGGER" write /)
    assert.match(String(call?.prompt), /cd '\.' && /)
    assert.ok(!('workflowEngineRevision' in (filedRecord(run) || {})), 'the fingerprint basis is review\'s field')
  })
}

test('adversarial-review: the record finalizes the directory its start checkpoint returned', async () => {
  const run = await runEngine('adversarial-review', {
    script: {
      scout: { head: 'abc1234', baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/app.ts'], notes: 'x' },
      checkpoint: { runDir: '/store/.partial/run-A', error: '' },
      '*': null,
    },
  })
  const slice = run.calls.find(c => c.label === 'checkpoint:prep')
  assert.equal(JSON.parse(String(slice?.prompt).split(/\nPAYLOAD:\s*\n/)[1] ?? 'null')?.startHead, 'abc1234')
  const call = run.calls.find(c => /^log-run/.test(c.label))
  assert.match(String(call?.prompt), /node "\$CRAFT_LOGGER" finalize .*--dir '\/store\/\.partial\/run-A' /)
})

test('review: the record write finalizes, and stamps the fingerprint basis last', async () => {
  const run = await runEngine('review', { args: {}, script: {} })
  const call = run.calls.find(c => /^log-run/.test(c.label))
  assert.match(String(call?.prompt), /node "\$CRAFT_LOGGER" finalize /)
  assert.equal(filedRecord(run)?.workflowEngineRevision, ENGINE_REVISION)
})

test('review: a landed record with a refused directory is logged and reported as landed, not lost', async () => {
  // A landed record must not read as lost (realm @nick/craft #39) — in the log as in the report.
  const run = await runEngine('review', { args: {}, script: { 'log-run': { ok: true, output: [SUCCESS, WARNING] }, '*': null } })
  assert.ok(run.logs.includes(`⚠️ telemetry: ${WARNING}`), run.logs.join('\n'))
  assert.ok(!run.logs.some(l => /telemetry lost: the run directory/.test(l)), 'a landed record is not logged as lost')
  assert.match(run.report, /## ⚠️ Telemetry incomplete/)
  assert.ok(!/## ⚠️ Telemetry lost/.test(run.report), 'nor headed as lost in the report')
  assert.match(run.report, /- the run directory \(the record itself landed\) — craft-log-run WARNING/)
})

test('review: a model-invented WARNING under ok:true raises no telemetry warning', async () => {
  // A live run (realm @nick/craft, node #409): the script printed only its success line, and the logger model
  // wrote its own "craft-log-run WARNING: …" into `error`. A warning is read only off relayed `output` lines.
  const invented = `craft-log-run WARNING: wrote run record, but the logger folded 3 checkpoint(s)`
  const run = await runEngine('review', { args: {}, script: { 'log-run': { ok: true, output: [SUCCESS], error: invented }, '*': null } })
  assert.ok(!run.logs.some(l => /telemetry/.test(l)), run.logs.join('\n'))
  assert.ok(!/Telemetry (incomplete|lost)/.test(run.report), 'a complete record is not called incomplete')
})

test('review: a relayed FAILED line is a lost record, and is not re-dispatched', async () => {
  const failed = 'craft-log-run FAILED: readback mismatch'
  const run = await runEngine('review', { args: {}, script: { 'log-run': { ok: false, output: [failed], error: failed }, '*': null } })
  assert.match(run.report, /## ⚠️ Telemetry lost/)
  assert.match(run.report, /- the run record — craft-log-run FAILED: readback mismatch/)
  assert.equal(run.calls.filter(c => /^log-run/.test(c.label)).length, 1, 'a script refusal is not re-dispatched (realm @nick/craft, node #246)')
})

test('review: a lost record is reported under the lost heading, naming the write', async () => {
  const run = await runEngine('review', { args: {}, script: {} })
  assert.match(run.report, /## ⚠️ Telemetry lost/)
  assert.match(run.report, /- the run record — /)
})

// A logger agent that ran the script but returned no structured answer is re-dispatched once, the same
// prompt marked `--retry`; only a second miss is a lost record (realm @nick/craft, node #246).
const MISSED = `agent({schema}): subagent completed ${MISSED_STRUCTURED_OUTPUT} (after in-conversation nudge)`
/** @param {unknown[]} answers one per log-run call: an Error is thrown, anything else returned */
const logRunScript = answers => ({
  'log-run': (/** @type {{ callIndex: number }} */ { callIndex }) => {
    const a = answers[Math.min(callIndex, answers.length - 1)]
    if (a instanceof Error) throw a
    return a
  },
  '*': null,
})
/** @param {{ calls: { label: string, prompt: string, opts?: { model?: string } }[] }} run */
const logRunCalls = run => run.calls.filter(c => /^log-run/.test(c.label))

for (const engine of RECORD_FILING_ENGINES) {
  test(`${engine}: a missed structured answer is re-dispatched once with the same prompt marked --retry, and its success is no loss`, async () => {
    const run = await runEngine(engine, { args: argsFor(engine), script: logRunScript([new Error(MISSED), { ok: true }]) })
    const calls = logRunCalls(run)
    assert.equal(calls.length, 2)
    assert.doesNotMatch(String(calls[0]?.prompt), /--retry/)
    assert.match(String(calls[1]?.prompt), /node "\$CRAFT_LOGGER" (write|finalize) .*--retry /)
    assert.equal(String(calls[1]?.prompt).replace('--retry ', ''), calls[0]?.prompt)
    assert.ok(!run.logs.some(l => /telemetry lost: the run record/.test(l)), run.logs.join('\n'))
  })

  test(`${engine}: a second missed structured answer is noted as lost, once`, async () => {
    const run = await runEngine(engine, { args: argsFor(engine), script: logRunScript([new Error(MISSED)]) })
    assert.equal(logRunCalls(run).length, 2)
    assert.equal(run.logs.filter(l => l.startsWith('⚠️ telemetry lost: the run record — ')).length, 1, run.logs.join('\n'))
  })

  test(`${engine}: a FAILED line from the script itself is not re-dispatched`, async () => {
    for (const first of [{ ok: false, error: 'craft-log-run FAILED: boom' }]) {
      const run = await runEngine(engine, { args: argsFor(engine), script: logRunScript([first, { ok: true }]) })
      assert.equal(logRunCalls(run).length, 1)
      assert.ok(run.logs.some(l => l.startsWith('⚠️ telemetry lost: the run record — ')), run.logs.join('\n'))
    }
  })
}

// The record must not hang on one logger agent (realm @nick/craft, node #299): a logger that threw, or
// answered a failure that is not the script's FAILED line, is re-dispatched once on the stronger model,
// marked `--retry` so a first attempt that did file is answered `already filed` (#246).
for (const engine of RECORD_FILING_ENGINES) {
  test(`${engine}: a logger agent that died is re-dispatched once, marked --retry, and its success is no loss`, async () => {
    for (const first of [new Error('agent died'), { ok: false, error: 'the shell was killed' }]) {
      const run = await runEngine(engine, { args: argsFor(engine), script: logRunScript([first, { ok: true }]) })
      const calls = logRunCalls(run)
      assert.equal(calls.length, 2)
      assert.doesNotMatch(String(calls[0]?.prompt), /--retry/)
      assert.match(String(calls[1]?.prompt), /node "\$CRAFT_LOGGER" (write|finalize) .*--retry /)
      assert.equal(calls[1]?.opts?.model, 'sonnet')
      assert.ok(!run.logs.some(l => /telemetry lost: the run record/.test(l)), run.logs.join('\n'))
    }
  })

  test(`${engine}: a logger agent that dies on the re-dispatch too is one lost record`, async () => {
    const run = await runEngine(engine, { args: argsFor(engine), script: logRunScript([new Error('agent died')]) })
    assert.equal(logRunCalls(run).length, 2)
    assert.equal(run.logs.filter(l => /^\S+ telemetry lost: the run record/.test(l)).length, 1, run.logs.join('\n'))
  })
}
