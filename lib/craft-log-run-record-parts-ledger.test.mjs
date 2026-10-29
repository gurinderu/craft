// A record sent in parts that lost one (realm @nick/craft, node #396) keeps #245's rule for its ledger: a
// shortfall reaches the next round as a truncated ledger, never as a quietly short one.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkpointDir, writeCheckpoint, finalizeRun, findPriorRound } from './craft-log-run.mjs'
import { shardLedger } from './ledger-shards.mjs'
import { cutRecord } from './record-parts.mjs'

const NOW = new Date('2026-10-02T12:00:00Z')
const LATER = new Date(NOW.getTime() + 60 * 1000)
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-rpl-'))
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
const LEDGER = Array.from({ length: 60 }, (_, i) => ({
  fp: `fp${i}`, file: 'src/a.rs', line: i + 1, symbol: 's', severity: 'Medium', tier: 'confirmed', disposition: 'open',
  source: 'safety', ruleId: 'R', title: `t${i}`, why: `${i} `.padEnd(700, 'w'),
}))
const BASE = { schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Warning', round: 1, branch: 'feat/x', findings: { total: 60 }, notes: 'n'.repeat(30000) }

/**
 * A run directory holding the given ledger shards and the record's parts but the one `lost` picks — or, with
 * `entry`, every part, short of the entries `lost` picks; the record filed from its header.
 * @param {Record<string, unknown>} rec @param {ReturnType<typeof shardLedger>} shards @param {(e: unknown[]) => boolean} lost
 * @param {{ entry?: boolean }} [o]
 */
function fileWithLostPart(rec, shards, lost, { entry = false } = {}) {
  const store = tmp()
  const { repo, head } = repoWithHead()
  const dir = checkpointDir(rec, { store, now: NOW, project: repo })
  for (const s of shards) writeCheckpoint(dir, `ledger-${s.ledgerShard.index}`, { branch: 'feat/x', head, ...s }, { project: repo })
  const { header, parts } = cutRecord(rec)
  const gone = parts.findIndex(p => p.recordEntries.some(lost))
  assert.ok(gone >= 0 && parts.length >= 3, 'the part to lose exists')
  parts.forEach((p, i) => {
    const kept = entry ? { ...p, recordEntries: p.recordEntries.filter(e => !lost(e)) } : p
    if (entry || i !== gone) writeCheckpoint(dir, `record-${i + 1}`, { kind: 'workflow', name: 'review', ...kept }, { project: repo })
  })
  /** @type {string[]} */
  const warnings = []
  const r = finalizeRun(header, { store, project: repo, dir, now: LATER, warnings, gitId: { branch: 'feat/x', head } })
  return { store, repo, warnings, filed: JSON.parse(fs.readFileSync(r.file, 'utf8')) }
}

test('the part that carried the ledger\'s shard declaration is lost: the header still names the shards, and the ledger is rebuilt', () => {
  const shards = shardLedger(LEDGER)
  const rec = { ...BASE, ledgerInShards: { of: shards.length, total: LEDGER.length } }
  const { filed, warnings } = fileWithLostPart(rec, shards, e => /** @type {unknown[]} */ (e[0])[0] === 'ledgerInShards')
  assert.deepEqual(filed.ledger, LEDGER)
  assert.ok(warnings.some(w => /declared in \d+ part\(s\)/.test(w)), warnings.join('\n'))
})

test('a part holding some of a ledger carried whole is lost: the next round reads the ledger as truncated', () => {
  const { filed, store, repo, warnings } = fileWithLostPart({ ...BASE, ledger: LEDGER }, [], e => /** @type {unknown[]} */ (e[0])[0] === 'ledger' && /** @type {unknown[]} */ (e[0]).length === 2)
  assert.ok(filed.ledger.length < LEDGER.length && filed.ledger.length > 0)
  assert.ok(warnings.some(w => /declared in \d+ part\(s\)/.test(w)), warnings.join('\n'))
  const prior = findPriorRound({ store, project: repo, branch: 'feat/x' })
  assert.equal(prior.found, true)
  assert.equal(prior.ledgerCount, LEDGER.length, 'the declared length crosses, so the engine sees a truncated ledger')
  assert.ok(prior.ledger.length < prior.ledgerCount)
})

test('every part came back but one ledger entry was dropped in the copy: no phantom row, the next round reads the ledger as truncated', () => {
  const { filed, store, repo, warnings } = fileWithLostPart({ ...BASE, ledger: LEDGER }, [], e => JSON.stringify(e[0]) === '["ledger",3]', { entry: true })
  assert.equal(filed.ledger.length, LEDGER.length - 1)
  assert.ok(filed.ledger.every((/** @type {unknown} */ r) => r && typeof r === 'object'), 'no null where the entry was')
  assert.equal(filed.recordInParts.altered, true)
  assert.ok(warnings.some(w => /all came back, but what they hold is not the record that was cut/.test(w)), warnings.join('\n'))
  const prior = findPriorRound({ store, project: repo, branch: 'feat/x' })
  assert.equal(prior.ledgerCount, LEDGER.length)
  assert.equal(prior.ledger.length, LEDGER.length - 1)
  assert.ok(prior.ledger.every((/** @type {{ fp: string }} */ r) => r.fp !== ''), 'no phantom item')
})
