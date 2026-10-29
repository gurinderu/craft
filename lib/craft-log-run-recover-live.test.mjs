// recover removes a run directory only when its run is dead by the clock: a run still alive keeps
// writing checkpoints there and folds them into its own record (realm @nick/craft, node #340).
import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkpointDir, writeCheckpoint, recoverPartials, partialChainEvidence, run } from './craft-log-run.mjs'

const NOW = new Date('2026-10-02T12:00:00Z')
/** @type {string[]} */
const made = []
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-recover-live-'))
  made.push(d)
  return d
}

/** A run directory with one round-2 checkpoint, its files `ageMin` minutes old. @param {string} store @param {number} ageMin */
function runDir(store, ageMin) {
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, now: NOW, project: store })
  writeCheckpoint(dir, 'scout', { round: 2, branch: 'feat/x' }, { project: store })
  age(dir, ageMin)
  return dir
}

/** @param {string} dir @param {number} minutes */
function age(dir, minutes) {
  const at = new Date(Date.now() - minutes * 60 * 1000)
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), at, at)
}

/** @param {string} store */
const indexRows = store => fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).length

test('a directory written to within the threshold is recovered but kept, and the CLI says so', async () => {
  const store = tmp()
  const dir = runDir(store, 5)
  const r = await run(['recover', '--store', store, '--project', store], {}, store)
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.match(r.stdout.join('\n'), /^recovered /)
  assert.match(r.stderr.join('\n'), /kept, the run may still be live/)
  assert.ok(fs.existsSync(dir), 'a possibly live run keeps its directory')
  assert.equal(indexRows(store), 1)
  // Its recovered record stands for the round: the kept directory is not a second, newer one.
  assert.deepEqual(partialChainEvidence({ store, project: store, branch: 'feat/x' }), [])
})

test('a directory whose newest checkpoint is older than the default 6 h is removed', () => {
  const store = tmp()
  const dir = runDir(store, 7 * 60)
  const [o] = recoverPartials({ store, project: store, now: NOW })
  assert.deepEqual([o?.live, o?.kept, fs.existsSync(dir)], [false, false, false])
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

test('a kept directory is not indexed twice: skipped while live, its record rewritten once it goes stale', () => {
  const store = tmp()
  const dir = runDir(store, 5)
  const [first] = recoverPartials({ store, project: store, now: NOW })
  assert.ok(first?.live)
  assert.deepEqual(recoverPartials({ store, project: store, now: NOW }), [], 'still live: nothing new')
  // The run lived on and wrote one more checkpoint, then died.
  writeCheckpoint(dir, 'lenses', { round: 2, branch: 'feat/x' }, { project: store })
  age(dir, 7 * 60)
  const [later] = recoverPartials({ store, project: store, now: NOW })
  assert.equal(later?.file, first?.file)
  assert.equal(later?.phases, 2)
  assert.equal(fs.existsSync(dir), false)
  assert.equal(indexRows(store), 1, 'one run, one index row')
  assert.equal(JSON.parse(fs.readFileSync(/** @type {string} */ (later?.file), 'utf8')).phases.length, 2)
})
