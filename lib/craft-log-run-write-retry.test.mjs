// A store write re-dispatched with the identical payload files nothing new (realm @nick/craft, node
// #246): the logger agent can run the script and still return no structured answer, and the engine
// sends the same prompt once more. `write` and every `finalize` leave a proof; a different payload,
// project or session is never taken for a retry.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './craft-log-run.mjs'

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-write-retry-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** @param {string} store */
const records = store => fs.readdirSync(store).filter(f => f.endsWith('.json'))
/** @param {string} store */
const indexLines = store => fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)

const RECORD = {
  schemaVersion: 1, runtime: 'claude-code', kind: 'workflow', name: 'triage-findings', verdict: 'Approve',
  findings: { total: 1 }, ledger: [{ fp: 'a', title: 't', severity: 'Low' }],
}

/** @param {string} store @param {string} project @param {string} cmd @param {unknown} rec @param {string[]} [extra] */
const file = (store, project, cmd, rec, extra = []) =>
  run([cmd, '--store', store, '--project', project, ...extra], process.env, project, () => JSON.stringify(rec))

for (const cmd of ['write', 'finalize']) {
  test(`${cmd}: the identical payload twice files one record and one index line`, async () => {
    const store = tmp()
    const project = tmp()
    const first = await file(store, project, cmd, RECORD, ['--session', 's1'])
    assert.equal(first.exitCode, 0, first.stderr.join('\n'))
    const filed = records(store)
    assert.equal(filed.length, 1)
    const again = await file(store, project, cmd, RECORD, ['--session', 's1'])
    assert.equal(again.exitCode, 0, again.stderr.join('\n'))
    assert.deepEqual(again.stdout, [`already filed ${path.join(store, /** @type {string} */ (filed[0]))}`])
    assert.ok(!again.stderr.some(l => /craft-log-run (WARNING|FAILED)/.test(l)), again.stderr.join('\n'))
    assert.deepEqual(records(store), filed)
    assert.equal(indexLines(store).length, 1)
  })

  test(`${cmd}: a different payload, session or project is never a retry`, async () => {
    const store = tmp()
    const project = tmp()
    await file(store, project, cmd, RECORD, ['--session', 's1'])
    const variants = [
      await file(store, project, cmd, { ...RECORD, verdict: 'Warning' }, ['--session', 's1']),
      await file(store, project, cmd, RECORD, ['--session', 's2']),
      await file(store, tmp(), cmd, RECORD, ['--session', 's1']),
    ]
    for (const v of variants) assert.match(String(v.stdout[0]), /^wrote /, v.stderr.join('\n'))
    assert.equal(indexLines(store).length, 4)
  })

  test(`${cmd}: a proven record that is gone is filed again`, async () => {
    const store = tmp()
    const project = tmp()
    await file(store, project, cmd, RECORD)
    for (const f of records(store)) fs.rmSync(path.join(store, f))
    const again = await file(store, project, cmd, RECORD)
    assert.match(String(again.stdout[0]), /^wrote /)
    assert.equal(records(store).length, 1)
  })

  test(`${cmd}: a proof older than an hour is not a retry`, async () => {
    const store = tmp()
    const project = tmp()
    await file(store, project, cmd, RECORD)
    const proofs = path.join(store, '.finalize-proofs')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    for (const p of fs.readdirSync(proofs)) fs.utimesSync(path.join(proofs, p), old, old)
    const again = await file(store, project, cmd, RECORD)
    assert.match(String(again.stdout[0]), /^wrote /)
  })
}
