// A finalize RETRIED after its logger agent died having already run the script, told apart from a
// first finalize whose run directory vanished before it ran (realm @nick/craft, node #245). A retry is
// proven — the first finalize left a proof naming its record and the hash of the payload it filed — and
// files nothing; a vanished directory with no matching proof still files the record, its ledger short
// and its declared total kept, loudly.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkpointDir, writeCheckpoint, finalizeRun, findPriorRound, run } from './craft-log-run.mjs'
import { shardLedger } from './ledger-shards.mjs'

const NOW = new Date('2026-10-02T12:00:00Z')
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-retry-'))
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
  return { repo: fs.realpathSync(repo), head: git(['rev-parse', 'HEAD'], repo) }
}
/** @param {string} store */
const records = store => fs.readdirSync(store).filter(f => f.endsWith('.json'))

const LEDGER = Array.from({ length: 30 }, (_, i) => ({
  fp: `fp${i}`, file: 'src/a.rs', line: i + 1, symbol: 's', severity: 'Medium', tier: 'confirmed', disposition: 'open',
  source: 'safety', ruleId: 'R', title: `t${i}`, why: `${i} `.padEnd(700, 'w'),
}))
const SHARDS = shardLedger(LEDGER)
const DECLARED = {
  schemaVersion: 1, runtime: 'claude-code', kind: 'workflow', name: 'review', verdict: 'Warning', round: 1, branch: 'feat/x',
  findings: { total: LEDGER.length }, ledgerInShards: { of: SHARDS.length, total: LEDGER.length },
}
/** @param {string} store @param {string} project @param {string} head */
function runDir(store, project, head) {
  const dir = checkpointDir(DECLARED, { store, now: NOW, project })
  for (const s of SHARDS) writeCheckpoint(dir, `ledger-${s.ledgerShard.index}`, { branch: 'feat/x', head, ...s }, { project })
  return dir
}

test('a retry with the identical payload files nothing new and says it was already filed', async () => {
  const store = tmp()
  const { repo, head } = repoWithHead()
  const dir = runDir(store, repo, head)
  const argv = ['finalize', '--store', store, '--project', repo, '--dir', dir]
  const stdin = () => JSON.stringify(DECLARED)
  const first = await run(argv, process.env, repo, stdin)
  assert.equal(first.exitCode, 0, first.stderr.join('\n'))
  const filed = records(store)
  assert.equal(filed.length, 1)
  const again = await run(argv, process.env, repo, stdin)
  assert.equal(again.exitCode, 0, again.stderr.join('\n'))
  assert.deepEqual(again.stdout, [`already filed ${path.join(store, /** @type {string} */ (filed[0]))}`])
  assert.ok(!again.stderr.some(l => /craft-log-run (WARNING|FAILED)/.test(l)), again.stderr.join('\n'))
  assert.deepEqual(records(store), filed)
  const prior = findPriorRound({ store, project: repo, branch: 'feat/x' })
  assert.deepEqual([prior.ledger.length, prior.ledgerCount], [LEDGER.length, LEDGER.length])
})

test('a first finalize whose run directory is already gone files the record, short and loud', () => {
  const store = tmp()
  const { repo, head } = repoWithHead()
  const dir = runDir(store, repo, head)
  fs.rmSync(dir, { recursive: true, force: true })   // a sibling folded it, or recover promoted it
  /** @type {string[]} */
  const warnings = []
  const r = finalizeRun(DECLARED, { store, project: repo, dir, now: NOW, warnings, gitId: { branch: 'feat/x', head } })
  const rec = JSON.parse(fs.readFileSync(r.file, 'utf8'))
  assert.deepEqual(rec.ledger, [])
  assert.equal(rec.ledgerInShards.total, LEDGER.length)
  assert.ok(warnings.some(w => /^craft-log-run WARNING: .*gone before finalize/.test(w)), warnings.join('\n'))
  const prior = findPriorRound({ store, project: repo, branch: 'feat/x' })
  assert.deepEqual([prior.ledger.length, prior.ledgerCount], [0, LEDGER.length])
})

test('a proof left for the same directory name by a different payload is not a retry', () => {
  const store = tmp()
  const dir = runDir(store, '/p', 'h0')
  finalizeRun(DECLARED, { store, project: '/p', dir, now: NOW, warnings: [] })
  /** @type {string[]} */
  const warnings = []
  const r = finalizeRun({ ...DECLARED, verdict: 'Block' }, { store, project: '/p', dir, now: new Date(NOW.getTime() + 1000), warnings })
  assert.equal(records(store).length, 2, 'the sibling\'s record is filed')
  assert.equal(JSON.parse(fs.readFileSync(r.file, 'utf8')).verdict, 'Block')
  assert.ok(warnings.some(w => /gone before finalize/.test(w)), warnings.join('\n'))
})

test('a retry after a resume (a new session, past the hour) is still proven by its run directory', async () => {
  const store = tmp()
  const { repo, head } = repoWithHead()
  const dir = runDir(store, repo, head)
  const stdin = () => JSON.stringify(DECLARED)
  const first = await run(['finalize', '--store', store, '--project', repo, '--dir', dir, '--session', 's1'], process.env, repo, stdin)
  assert.equal(first.exitCode, 0, first.stderr.join('\n'))
  const filed = records(store)
  const proofs = path.join(store, '.finalize-proofs')
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  for (const p of fs.readdirSync(proofs)) fs.utimesSync(path.join(proofs, p), old, old)
  const again = await run(['finalize', '--store', store, '--project', repo, '--dir', dir, '--session', 's2'], process.env, repo, stdin)
  assert.deepEqual(again.stdout, [`already filed ${path.join(store, /** @type {string} */ (filed[0]))}`])
  assert.deepEqual(records(store), filed)
})
