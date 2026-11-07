// The filing proof a store write leaves and a re-dispatch checks (lib/finalize-proof.mjs), read
// directly: its key ways, their windows, the proof's own checks, and the pruning. Through the logger
// CLI: craft-log-run-write-retry.test.mjs, craft-log-run-finalize-retry.test.mjs.
import { test, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { filedBefore, leaveFilingProof } from './finalize-proof.mjs'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const RECORD = { engine: 'review', round: 1 }
const BOTH = { retry: true, runDir: true }
const RETRY = { retry: true, runDir: false }
const RUN_DIR = { retry: false, runDir: true }

/** @type {string} */
let store
/** @type {string} */
let file
beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-proof-'))
  file = path.join(store, 'run-1.json')
  fs.writeFileSync(file, '{}')
})
afterEach(() => fs.rmSync(store, { recursive: true, force: true }))

const proofs = () => fs.readdirSync(path.join(store, '.finalize-proofs')).sort()
/** @param {string} name @param {number} ageMs */
const age = (name, ageMs) => {
  const t = new Date(Date.now() - ageMs)
  fs.utimesSync(path.join(store, '.finalize-proofs', name), t, t)
}

test('a retry is proven by payload, directory and project; the warning lines the filing printed ride along', () => {
  leaveFilingProof(RECORD, { store, dir: '/elsewhere/d', project: 'p', file, warnings: ['craft-log-run WARNING: short', 'noise'] })
  assert.equal(proofs().length, 1, 'a directory outside the store\'s .partial names no proof by directory')
  assert.deepEqual(filedBefore(RECORD, { store, dir: '/elsewhere/d', project: 'p' }, RETRY), { file, warnings: ['craft-log-run WARNING: short'] })
  assert.equal(filedBefore(RECORD, { store, dir: '/elsewhere/d', project: 'q' }, RETRY), null, 'another project')
  assert.equal(filedBefore({ ...RECORD, round: 2 }, { store, dir: '/elsewhere/d', project: 'p' }, RETRY), null, 'another payload')
  assert.equal(filedBefore(RECORD, { store, dir: '/elsewhere/d', project: 'p' }, RUN_DIR), null, 'no run-directory proof')
  assert.equal(filedBefore(RECORD, { store, dir: '/elsewhere/d', project: 'p' }, { retry: false, runDir: false }), null, 'no way asked')
})

test('an absent directory and project key the same as empty ones; no warnings leave an empty list', () => {
  leaveFilingProof(RECORD, { store, file })
  assert.deepEqual(filedBefore(RECORD, { store, dir: '', project: '' }, RETRY), { file, warnings: [] })
})

test('a run directory under the store\'s .partial proves a finalize by payload and directory alone, both ways written', () => {
  const dir = path.join(store, '.partial', 'run-abc')
  leaveFilingProof(RECORD, { store, dir, project: 'p', file })
  assert.equal(proofs().length, 2)
  assert.ok(proofs().some(n => n.startsWith('dir-')))
  assert.deepEqual(filedBefore(RECORD, { store, dir, project: 'other' }, RUN_DIR), { file, warnings: [] })
  assert.equal(filedBefore(RECORD, { store, dir: path.join(store, '.partial', 'run-xyz') }, RUN_DIR), null, 'another run directory')
})

test('windows: a retry proof holds an hour, a run-directory proof a week', () => {
  const dir = path.join(store, '.partial', 'run-abc')
  leaveFilingProof(RECORD, { store, dir, file })
  const byDir = String(proofs().find(n => n.startsWith('dir-')))
  const byRetry = String(proofs().find(n => !n.startsWith('dir-')))
  age(byRetry, 30 * 60 * 1000)
  assert.deepEqual(filedBefore(RECORD, { store, dir }, RETRY), { file, warnings: [] })
  age(byRetry, 2 * HOUR)
  assert.equal(filedBefore(RECORD, { store, dir }, RETRY), null)
  age(byDir, 6 * DAY)
  assert.deepEqual(filedBefore(RECORD, { store, dir }, BOTH), { file, warnings: [] })
  age(byDir, 8 * DAY)
  assert.equal(filedBefore(RECORD, { store, dir }, BOTH), null)
})

test('a proof whose record is gone, or whose key is not its name, proves nothing', () => {
  leaveFilingProof(RECORD, { store, file })
  const name = String(proofs()[0])
  fs.rmSync(file)
  assert.equal(filedBefore(RECORD, { store }, RETRY), null, 'record gone')
  fs.writeFileSync(file, '{}')
  const at = path.join(store, '.finalize-proofs', name)
  fs.writeFileSync(at, JSON.stringify({ file: 'run-1.json', key: 'other' }))
  assert.equal(filedBefore(RECORD, { store }, RETRY), null, 'key mismatch')
  fs.writeFileSync(at, JSON.stringify({ file: '../../run-1.json', key: name, warnings: 'not a list' }))
  assert.deepEqual(filedBefore(RECORD, { store }, RETRY), { file, warnings: [] }, 'the file is read inside the store; warnings not a list read as none')
  fs.writeFileSync(at, '{not json')
  assert.equal(filedBefore(RECORD, { store }, RETRY), null, 'unreadable proof')
})

test('no proof directory at all proves nothing', () => {
  assert.equal(filedBefore(RECORD, { store, dir: path.join(store, '.partial', 'r') }, BOTH), null)
})

test('each filing prunes the proofs past the week, keeping the younger ones', () => {
  fs.mkdirSync(path.join(store, '.finalize-proofs'))
  for (const n of ['old', 'young']) fs.writeFileSync(path.join(store, '.finalize-proofs', n), '{}')
  age('old', 8 * DAY)
  age('young', 6 * DAY)
  leaveFilingProof(RECORD, { store, file })
  assert.equal(proofs().length, 2)
  assert.ok(proofs().includes('young'))
  assert.ok(!proofs().includes('old'))
})

test('a proof directory that cannot be made costs the proof, never an error', () => {
  fs.writeFileSync(path.join(store, '.finalize-proofs'), 'a file in the way')
  assert.doesNotThrow(() => leaveFilingProof(RECORD, { store, file }))
  assert.equal(filedBefore(RECORD, { store }, RETRY), null)
})
