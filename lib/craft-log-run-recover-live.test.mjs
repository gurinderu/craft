// recover removes a run directory only when its run is dead by the clock: a run still alive keeps
// writing checkpoints there and folds them into its own record (realm @nick/craft, node #340).
import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkpointDir, writeCheckpoint, recoverPartials, partialChainEvidence, finalizeRun, run } from './craft-log-run.mjs'
import { indexProjection } from './run-record.mjs'

const MIN = 60 * 1000
/** @type {string[]} */
const made = []
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-recover-live-'))
  made.push(d)
  return d
}

const RECORD = { kind: 'workflow', name: 'review' }
/** `minutes` from now, as recover's injected clock. @param {number} minutes */
const later = minutes => new Date(Date.now() + minutes * MIN)

/** A run directory with one round-2 checkpoint, written now. @param {string} store */
function runDir(store) {
  const dir = checkpointDir(RECORD, { store, project: store })
  checkpoint(store, dir, 'scout')
  return dir
}

/** @param {string} store @param {string} dir @param {string} phase */
function checkpoint(store, dir, phase) {
  writeCheckpoint(dir, phase, { round: 2, branch: 'feat/x' }, { project: store })
}

/** @param {string} store */
const indexLines = store => fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)
/** @param {string} store */
const records = store => fs.readdirSync(store).filter(f => f.endsWith('.json'))

test('a directory written to within the threshold is recovered but kept, and the CLI says so', async () => {
  const store = tmp()
  const dir = runDir(store)
  const r = await run(['recover', '--store', store, '--project', store], {}, store)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.match(r.stdout.join('\n'), /^recovered /)
  assert.match(r.stderr.join('\n'), /kept, the run may still be live/)
  assert.ok(fs.existsSync(dir), 'a possibly live run keeps its directory')
  assert.equal(indexLines(store).length, 1)
  // Its recovered record stands for the round: the kept directory is not a second, newer one.
  assert.deepEqual(partialChainEvidence({ store, project: store, branch: 'feat/x' }), [])
})

test('staleness is the checkpoints\' own time against the injected clock: removed after the default 6 h', () => {
  const store = tmp()
  const dir = runDir(store)
  const [early] = recoverPartials({ store, project: store, now: later(60) })
  assert.deepEqual([early?.live, fs.existsSync(dir)], [true, true])
  const [late] = recoverPartials({ store, project: store, now: later(7 * 60) })
  assert.deepEqual([late?.live, late?.kept, fs.existsSync(dir)], [false, false, false])
})

test('a checkpoint stamped after the clock does not pin its directory live: the name stamp decides', () => {
  const store = tmp()
  // Named 7 h before recover's clock; its checkpoint (written now) is 7 h after it, and passed over.
  const dir = checkpointDir(RECORD, { store, project: store, now: later(-14 * 60) })
  checkpoint(store, dir, 'scout')
  const [o] = recoverPartials({ store, project: store, now: later(-7 * 60) })
  assert.deepEqual([o?.live, fs.existsSync(dir)], [false, false])
})

test('the payload cannot set a checkpoint\'s `at`: it is the logger\'s clock', () => {
  const store = tmp()
  const dir = checkpointDir(RECORD, { store, project: store })
  const file = writeCheckpoint(dir, 'scout', { round: 2, at: '2099-01-01T00:00:00.000Z' }, { project: store })
  assert.ok(Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).at) <= Date.now())
})

test('--stale-after sets the threshold in minutes, and --force removes a fresh directory', async () => {
  const store = tmp()
  const dir = runDir(store)
  const r = await run(['recover', '--store', store, '--project', store, '--stale-after', '0'], {}, store)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.equal(fs.existsSync(dir), false)
  const store2 = tmp()
  const fresh = runDir(store2)
  const f = await run(['recover', '--store', store2, '--project', store2, '--force'], {}, store2)
  assert.equal(f.exitCode, 0, f.stderr.join('\n'))
  assert.equal(fs.existsSync(fresh), false)
  const bad = await run(['recover', '--store', store2, '--stale-after', 'soon'], {}, store2)
  assert.equal(bad.exitCode, 1)
  assert.match(bad.stderr.join('\n'), /--stale-after takes minutes/)
})

test('a kept directory is not indexed twice: skipped while live, its record and index row rewritten once stale', () => {
  const store = tmp()
  const dir = runDir(store)
  const [first] = recoverPartials({ store, project: store })
  assert.ok(first?.live)
  assert.deepEqual(recoverPartials({ store, project: store }), [], 'still live: nothing new')
  // The run lived on and wrote one more checkpoint, then died.
  checkpoint(store, dir, 'lenses')
  const [stale] = recoverPartials({ store, project: store, now: later(7 * 60) })
  assert.equal(stale?.file, first?.file)
  assert.equal(stale?.phases, 2)
  assert.equal(fs.existsSync(dir), false)
  const rows = indexLines(store)
  assert.equal(rows.length, 1, 'one run, one index row')
  const rec = JSON.parse(fs.readFileSync(/** @type {string} */ (stale?.file), 'utf8'))
  assert.equal(rec.phases.length, 2)
  assert.deepEqual(JSON.parse(/** @type {string} */ (rows[0])), JSON.parse(JSON.stringify(indexProjection(rec))), 'the row matches the rewritten record')
})

test('a run recover kept that then finalizes with its --dir replaces recover\'s record: one record, one row', () => {
  const store = tmp()
  const dir = runDir(store)
  const [kept] = recoverPartials({ store, project: store })
  assert.ok(kept?.live)
  checkpoint(store, dir, 'lenses')
  const res = finalizeRun({ ...RECORD, branch: 'feat/x', verdict: 'Approve', round: 2 }, { store, project: store, dir, warnings: [] })
  assert.equal(res.file, kept?.file, 'the record recover filed is the one replaced')
  assert.equal(res.folded, 2)
  assert.deepEqual(records(store), [path.basename(/** @type {string} */ (kept?.file))])
  const rows = indexLines(store)
  assert.equal(rows.length, 1)
  const rec = JSON.parse(fs.readFileSync(res.file, 'utf8'))
  assert.equal(rec.partial, undefined, 'the full record, not the recovered partial')
  assert.equal(JSON.parse(/** @type {string} */ (rows[0])).verdict, rec.verdict)
  assert.equal(fs.existsSync(dir), false)
})

test('a rerun\'s rejoin does not adopt a directory recover kept, so the round is not filed twice', () => {
  const store = tmp()
  const now = new Date()
  const dir = runDir(store)
  const rejoin = () => checkpointDir({ ...RECORD, branch: 'feat/x' }, { store, project: store, rejoin: true, now })
  assert.equal(rejoin(), dir, 'before recover, the directory is the one a rejoin finds')
  recoverPartials({ store, project: store, now })
  assert.ok(fs.existsSync(dir))
  assert.notEqual(rejoin(), dir)
})
