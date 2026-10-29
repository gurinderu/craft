// recover removes a run directory only when its run is dead by the clock: a run still alive keeps
// writing checkpoints there and folds them into its own record (realm @nick/craft, node #340).
import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkpointDir, writeCheckpoint, recoverPartials, partialChainEvidence, run } from './craft-log-run.mjs'
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

/**
 * A run directory stamped and checkpointed `ageMin` minutes before `now`, its checkpoint at round 2.
 * @param {string} store @param {number} ageMin @param {Date} [now]
 */
function runDir(store, ageMin, now = new Date()) {
  const dir = checkpointDir(RECORD, { store, now: new Date(now.getTime() - ageMin * MIN), project: store })
  checkpoint(store, dir, 'scout', ageMin, now)
  return dir
}

/** @param {string} store @param {string} dir @param {string} phase @param {number} ageMin @param {Date} [now] */
function checkpoint(store, dir, phase, ageMin, now = new Date()) {
  const at = new Date(now.getTime() - ageMin * MIN).toISOString()
  writeCheckpoint(dir, phase, { round: 2, branch: 'feat/x', at }, { project: store })
}

/** @param {string} store */
const indexLines = store => fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)

test('a directory written to within the threshold is recovered but kept, and the CLI says so', async () => {
  const store = tmp()
  const dir = runDir(store, 5)
  const r = await run(['recover', '--store', store, '--project', store], {}, store)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.match(r.stdout.join('\n'), /^recovered /)
  assert.match(r.stderr.join('\n'), /kept, the run may still be live/)
  assert.ok(fs.existsSync(dir), 'a possibly live run keeps its directory')
  assert.equal(indexLines(store).length, 1)
  // Its recovered record stands for the round: the kept directory is not a second, newer one.
  assert.deepEqual(partialChainEvidence({ store, project: store, branch: 'feat/x' }), [])
})

test('a directory whose newest checkpoint is older than the default 6 h is removed', () => {
  const store = tmp()
  const dir = runDir(store, 7 * 60)
  const [o] = recoverPartials({ store, project: store })
  assert.deepEqual([o?.live, o?.kept, fs.existsSync(dir)], [false, false, false])
})

test('staleness is read off the checkpoints\' own time against the injected clock, not file mtimes', () => {
  const store = tmp()
  const at = new Date('2026-10-02T12:00:00Z')
  const dir = runDir(store, 0, at)   // fresh mtimes, but the checkpoint says 12:00
  const [early] = recoverPartials({ store, project: store, now: new Date(at.getTime() + 60 * MIN) })
  assert.equal(early?.live, true)
  const [late] = recoverPartials({ store, project: store, now: new Date(at.getTime() + 7 * 60 * MIN) })
  assert.equal(late?.live, false)
  assert.equal(fs.existsSync(dir), false)
})

test('--stale-after sets the threshold in minutes, and --force removes a fresh directory', async () => {
  const store = tmp()
  const dir = runDir(store, 2)
  const r = await run(['recover', '--store', store, '--project', store, '--stale-after', '1'], {}, store)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.equal(fs.existsSync(dir), false)
  const store2 = tmp()
  const fresh = runDir(store2, 0)
  const f = await run(['recover', '--store', store2, '--project', store2, '--force'], {}, store2)
  assert.equal(f.exitCode, 0, f.stderr.join('\n'))
  assert.equal(fs.existsSync(fresh), false)
  const bad = await run(['recover', '--store', store2, '--stale-after', 'soon'], {}, store2)
  assert.equal(bad.exitCode, 1)
  assert.match(bad.stderr.join('\n'), /--stale-after takes minutes/)
})

test('a kept directory is not indexed twice: skipped while live, its record and index row rewritten once stale', () => {
  const store = tmp()
  const dir = runDir(store, 5)
  const [first] = recoverPartials({ store, project: store })
  assert.ok(first?.live)
  assert.deepEqual(recoverPartials({ store, project: store }), [], 'still live: nothing new')
  // The run lived on and wrote one more checkpoint, then died.
  checkpoint(store, dir, 'lenses', 4)
  const [later] = recoverPartials({ store, project: store, now: new Date(Date.now() + 7 * 60 * MIN) })
  assert.equal(later?.file, first?.file)
  assert.equal(later?.phases, 2)
  assert.equal(fs.existsSync(dir), false)
  const rows = indexLines(store)
  assert.equal(rows.length, 1, 'one run, one index row')
  const rec = JSON.parse(fs.readFileSync(/** @type {string} */ (later?.file), 'utf8'))
  assert.equal(rec.phases.length, 2)
  assert.deepEqual(JSON.parse(/** @type {string} */ (rows[0])), JSON.parse(JSON.stringify(indexProjection(rec))), 'the row matches the rewritten record')
})

test('a rerun\'s rejoin does not adopt a directory recover kept, so the round is not filed twice', () => {
  const store = tmp()
  const now = new Date()
  const dir = runDir(store, 5, now)
  const rejoin = () => checkpointDir({ ...RECORD, branch: 'feat/x' }, { store, project: store, rejoin: true, now })
  assert.equal(rejoin(), dir, 'before recover, the directory is the one a rejoin finds')
  recoverPartials({ store, project: store, now })
  assert.ok(fs.existsSync(dir))
  assert.notEqual(rejoin(), dir)
})
