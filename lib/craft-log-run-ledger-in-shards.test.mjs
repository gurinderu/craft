// Finalize rebuilding the ledger from this run's own shard checkpoints when the record arrives
// without it (realm @nick/craft, node #245): a complete set files the record exactly as a record that
// carried its ledger would be filed; a short or unprovable set files what it has and keeps the
// declared total, so the next round reads the ledger as truncated, never as a short round.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkpointDir, writeCheckpoint, finalizeRun, findPriorRound } from './craft-log-run.mjs'
import { shardLedger } from './ledger-shards.mjs'

const NOW = new Date('2026-10-02T12:00:00Z')
const LATER = new Date(NOW.getTime() + 60 * 1000)
const RECORD = { schemaVersion: 1, runtime: 'claude-code', kind: 'workflow', name: 'review', verdict: 'Warning', round: 1, findings: { total: 40 } }

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-lis-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** @param {string[]} args @param {string} cwd */
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
const repoWithHead = () => {
  const repo = tmp()
  git(['init', '-q'], repo)
  git(['symbolic-ref', 'HEAD', 'refs/heads/feat/x'], repo)
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'i'], repo)
  return { repo, head: git(['rev-parse', 'HEAD'], repo) }
}
/** @param {string} file @returns {Record<string, any>} */
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

// Forty ledger rows with a long `why`, enough for several shards at the real shard bound.
const LEDGER = Array.from({ length: 40 }, (_, i) => ({
  fp: `fp${i}`, file: 'src/a.rs', line: i + 1, symbol: 's', severity: 'Medium', tier: 'confirmed', disposition: 'open',
  source: 'safety', ruleId: 'R', title: `t${i}`, why: `${i} `.padEnd(700, 'w'),
}))
const SHARDS = shardLedger(LEDGER)

// A run directory written the way the engine writes it: a plan slice, then the given shards.
/** @param {string} store @param {string} project @param {{ branch?: string, head?: string, shards?: typeof SHARDS }} [o] */
function runDirWith(store, project, { branch = 'feat/x', head = 'h0', shards = SHARDS } = {}) {
  const dir = checkpointDir(RECORD, { store, now: NOW, project })
  writeCheckpoint(dir, 'rust-plan', { branch, head }, { project })
  for (const s of shards) writeCheckpoint(dir, `ledger-${String(s.ledgerShard.index).padStart(2, '0')}`, { branch, head, ...s }, { project })
  return dir
}
const DECLARED = { ...RECORD, branch: 'feat/x', ledgerInShards: { of: SHARDS.length, total: LEDGER.length } }

test('the fixture really is several shards', () => {
  assert.ok(SHARDS.length >= 2, `${SHARDS.length} shard(s)`)
})

test('every shard landed: the record is filed with the whole ledger and no declaration, the directory removed', () => {
  const store = tmp()
  const dir = runDirWith(store, '/p')
  /** @type {string[]} */
  const warnings = []
  const r = finalizeRun(DECLARED, { store, project: '/p', dir, now: LATER, warnings })
  const rec = readJson(r.file)
  assert.deepEqual(rec['ledger'], LEDGER)
  assert.ok(!('ledgerInShards' in rec), 'a complete ledger reads exactly as one the record carried')
  assert.ok(!(rec['phases'] || []).some((/** @type {any} */ p) => p.ledgerShard), 'the shards are not folded in a second time')
  assert.deepEqual(warnings, [])
  assert.equal(fs.existsSync(dir), false)
})

test('a later set matching the declaration wins over an earlier one left in the same directory', () => {
  const store = tmp()
  const stale = shardLedger(LEDGER.slice(0, 3).map(e => ({ ...e, why: 'stale' })))
  const dir = runDirWith(store, '/p', { shards: [...stale, ...SHARDS] })
  const rec = readJson(finalizeRun(DECLARED, { store, project: '/p', dir, now: LATER, warnings: [] }).file)
  assert.deepEqual(rec['ledger'], LEDGER)
})

test('a missing shard: the short ledger is filed with the declared total, loudly, and the next round reads it as truncated', () => {
  const store = tmp()
  const { repo, head } = repoWithHead()
  const dir = runDirWith(store, repo, { head, shards: SHARDS.slice(1) })
  /** @type {string[]} */
  const warnings = []
  const r = finalizeRun(DECLARED, { store, project: repo, dir, now: LATER, warnings, gitId: { branch: 'feat/x', head } })
  const rec = readJson(r.file)
  const held = SHARDS.slice(1).flatMap(s => s.ledgerItems)
  assert.deepEqual(rec['ledger'], held)
  assert.deepEqual(rec['ledgerInShards'], { of: SHARDS.length, total: LEDGER.length, seen: SHARDS.length - 1 })
  assert.ok(warnings.some(w => /^craft-log-run WARNING: .*ledger/.test(w)), warnings.join('\n'))
  const prior = findPriorRound({ store, project: repo, branch: 'feat/x' })
  assert.equal(prior.found, true)
  assert.equal(prior.ledger.length, held.length)
  assert.equal(prior.ledgerCount, LEDGER.length, 'the declared total crosses, so the engine sees a truncated ledger')
})

test('a directory not proven this run\'s: nothing is taken from it, it is kept, and the shortfall is declared', () => {
  const store = tmp()
  const dir = runDirWith(store, '/p', { branch: 'other' })
  /** @type {string[]} */
  const warnings = []
  const r = finalizeRun(DECLARED, { store, project: '/p', dir, rejoin: true, now: LATER, warnings })
  const rec = readJson(r.file)
  assert.equal(r.kept, true)
  assert.deepEqual(rec['ledger'], [])
  assert.deepEqual(rec['ledgerInShards'], { of: SHARDS.length, total: LEDGER.length, seen: 0 })
  assert.ok(warnings.some(w => /^craft-log-run WARNING: .*ledger/.test(w)), warnings.join('\n'))
  assert.equal(fs.existsSync(dir), true, 'the only copy of the shards stays for recover')
})

test('a record that carries its ledger is filed as before, whatever shards the directory holds', () => {
  const store = tmp()
  const dir = runDirWith(store, '/p')
  const mine = [LEDGER[0]]
  const rec = readJson(finalizeRun({ ...RECORD, branch: 'feat/x', ledger: mine }, { store, project: '/p', dir, now: LATER, warnings: [] }).file)
  assert.deepEqual(rec['ledger'], mine)
  assert.ok(!('ledgerInShards' in rec))
})

test('a retried finalize of the same declaration-only record files nothing new once the first one finalized the directory', () => {
  const store = tmp()
  const { repo, head } = repoWithHead()
  const dir = runDirWith(store, repo, { head })
  const opts = { store, project: repo, dir, now: LATER, gitId: { branch: 'feat/x', head } }
  const first = finalizeRun(DECLARED, { ...opts, warnings: [] })
  /** @type {string[]} */
  const warnings = []
  const again = finalizeRun(DECLARED, { ...opts, now: new Date(LATER.getTime() + 1000), warnings })
  assert.equal(again.file, '', 'the retry files no record')
  assert.ok(warnings.some(w => /^craft-log-run WARNING: .*already finalized or is gone/.test(w)), warnings.join('\n'))
  const files = fs.readdirSync(store).filter(f => f.endsWith('.json'))
  assert.deepEqual(files, [path.basename(first.file)])
  const prior = findPriorRound({ store, project: repo, branch: 'feat/x' })
  assert.deepEqual([prior.ledger.length, prior.ledgerCount], [LEDGER.length, LEDGER.length])
})
