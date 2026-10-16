// The final record leaves the ledger to its shards when every shard landed in the run's own
// directory (realm @nick/craft, node #245): the one heredoc the logger copies no longer carries the
// largest array, and finalize rebuilds it from those shards. Any doubt about the shards — one died, or
// the run's directory may have been adopted — and the record carries the whole ledger, as before.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runEngine, sentRecord, filedRecord } from './engine-harness.mjs'
import { execFileSync } from 'node:child_process'
import { checkpointDir, writeCheckpoint, finalizeRun, findPriorRound } from './craft-log-run.mjs'
import { shardLedger } from './ledger-shards.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const FINDINGS = Array.from({ length: 30 }, (_, i) => ({
  severity: 'Medium', title: `t${i}`, file: 'src/lib.rs', line: i + 1, why: `${i} `.padEnd(600, 'w'), fix: 'fix it',
  blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: `g${i}`, whereChecked: '',
}))

// A first review whose one lens returns FINDINGS; `checkpoint` is the knob every test turns.
/** @param {unknown} checkpoint */
const scriptWith = checkpoint => ({
  detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint,
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? FINDINGS : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  synthesis: null,
  '*': null,
})
const RUN_DIR = { runDir: '/store/.partial/run-A', error: '' }
/** @param {{ calls: import('./engine-harness.mjs').Call[] }} run */
const shardCalls = run => run.calls.filter(c => /^checkpoint:ledger-/.test(c.label))

test('every shard landed in the run\'s own directory: the record sent to the logger carries no ledger, only its declaration', async () => {
  const run = await runEngine('review', { args: {}, script: scriptWith(RUN_DIR) })
  const sent = sentRecord(run)
  assert.ok(shardCalls(run).length >= 2, 'the ledger must span several shards, or nothing was tested')
  assert.ok(!('ledger' in sent), 'the ledger rides in the shards, not in the one copy')
  assert.deepEqual(sent.ledgerInShards, { of: shardCalls(run).length, total: FINDINGS.length })
  const logCall = run.calls.find(c => /^log-run/.test(c.label))
  assert.ok(!String(logCall?.prompt).includes(FINDINGS[0]?.why ?? '-'), 'no ledger row reaches the heredoc')
  assert.equal(filedRecord(run)?.ledger?.length, FINDINGS.length)
})

test('the record finalize files from those shards carries the same ledger a dead-checkpoint run sends whole', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-lis-engine-'))
  onTestFinished(() => fs.rmSync(store, { recursive: true, force: true }))
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/p' })
  // The checkpoint agent's job done for real: the payload it was handed, written into the run's directory.
  const writeIt = (/** @type {{ prompt: string }} */ { prompt }) => {
    const payload = JSON.parse(/** @type {string} */ (prompt.match(/\nPAYLOAD:\s*\n([\s\S]+)$/)?.[1]))
    const phase = /** @type {string} */ (prompt.match(/--phase '([^']+)'/)?.[1])
    writeCheckpoint(dir, phase, payload, { project: '/p' })
    return { runDir: dir, error: '' }
  }
  const sharded = await runEngine('review', { args: {}, script: scriptWith(writeIt) })
  const whole = await runEngine('review', { args: {}, script: scriptWith(null) })
  const wholeLedger = sentRecord(whole).ledger
  assert.equal(wholeLedger.length, FINDINGS.length)
  const r = finalizeRun(sentRecord(sharded), { store, project: '/p', dir, warnings: [] })
  const filed = JSON.parse(fs.readFileSync(r.file, 'utf8'))
  assert.deepEqual(filed.ledger, wholeLedger)
  assert.ok(!('ledgerInShards' in filed))
})

test('a shard that did not land: the record carries the whole ledger', async () => {
  const run = await runEngine('review', { args: {}, script: { ...scriptWith(RUN_DIR), 'checkpoint:ledger-02': null } })
  const sent = sentRecord(run)
  assert.equal(sent.ledger?.length, FINDINGS.length)
  assert.ok(!('ledgerInShards' in sent))
})

test('a run whose directory may have been adopted (a rejoin was armed): the record carries the whole ledger', async () => {
  const firstDies = (/** @type {{ callIndex: number }} */ { callIndex }) => (callIndex === 0 ? null : RUN_DIR)
  const run = await runEngine('review', { args: {}, script: scriptWith(firstDies) })
  assert.ok(shardCalls(run).every(c => c.result?.runDir), 'every shard itself landed')
  assert.equal(sentRecord(run).ledger?.length, FINDINGS.length)
})

test('across rounds: a short shard set filed by finalize reaches the next round as a truncated ledger', async () => {
  const tmp = (/** @type {string} */ p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); onTestFinished(() => fs.rmSync(d, { recursive: true, force: true })); return d }
  const store = tmp('craft-lis-store-')
  const repo = tmp('craft-lis-repo-')
  const git = (/** @type {string[]} */ a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  git(['init', '-q']); git(['symbolic-ref', 'HEAD', 'refs/heads/feat/x'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'i'])
  const head = git(['rev-parse', 'HEAD'])
  // Round 1's real ledger, its first shard lost before finalize.
  const round1 = sentRecord(await runEngine('review', { args: {}, script: scriptWith(RUN_DIR) }))
  const shards = shardLedger(filedRecord(await runEngine('review', { args: {}, script: scriptWith(null) })).ledger)
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: repo })
  for (const sh of shards.slice(1)) writeCheckpoint(dir, `ledger-${sh.ledgerShard.index}`, { branch: 'feat/x', head, ...sh }, { project: repo })
  finalizeRun({ ...round1, round: 1 }, { store, project: repo, dir, warnings: [], gitId: { branch: 'feat/x', head } })
  const prior = JSON.parse(JSON.stringify(findPriorRound({ store, project: repo, branch: 'feat/x' })))
  assert.equal(prior.found, true)
  assert.ok(prior.ledger.length < prior.ledgerCount, `${prior.ledger.length} of ${prior.ledgerCount}`)
  const round2 = await runEngine('review', { args: {}, script: { ...scriptWith(RUN_DIR), 'prior-round': prior } })
  assert.ok(round2.logs.some(l => /prior-round ledger arrived TRUNCATED/.test(l)), round2.logs.join('\n'))
})
