// A review whose ledger shards landed but whose record lost a part: `recover` files it partial, and the next
// round still reads its ledger from the shards kept in its phases (realm @nick/craft, nodes #245, #396).
import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkpointDir, writeCheckpoint, recoverPartials, findPriorRound } from './craft-log-run.mjs'
import { cutRecord } from './record-parts.mjs'
import { shardLedger } from './ledger-shards.mjs'
import { ledgerRecordFields } from './ledger-in-shards.mjs'

// Git with no global or system config, so a machine's hooks or signing never reach the temp repository.
/** @param {string[]} args @param {string} cwd */
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()

/** @type {string[]} */
const made = []
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** @param {string} prefix */
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(d)
  return d
}

function repo() {
  const dir = tmp('craft-rpl-repo-')
  const g = (/** @type {string[]} */ a) => git(a, dir)
  g(['init', '-q', '-b', 'feat/x'])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a'), '1'); g(['add', 'a']); g(['commit', '-qm', 'one'])
  return { project: dir, head: g(['rev-parse', 'HEAD']) }
}

const LEDGER = Array.from({ length: 30 }, (_, i) => ({ fingerprint: `fp${i}`, severity: 'Medium', title: `t${i}`, status: 'open' }))

/**
 * A round-2 review's directory as its logger leaves it when finalize dies: its ledger in shards, then its
 * record in parts, the last part lost; `shardsLost` shards never landed either.
 * @param {number} shardsLost
 */
function deadRound(shardsLost) {
  const store = tmp('craft-rpl-store-')
  const { project, head } = repo()
  const shards = shardLedger(LEDGER, { max: 1024 })
  assert.ok(shards.length >= 2)
  const rec = {
    schemaVersion: 1, runtime: 'claude-code', kind: 'workflow', name: 'review', craftVersion: '9.9.9', round: 2,
    workflowEngineRevision: 7, verdict: 'Warning', findings: { total: 30 }, ...ledgerRecordFields(LEDGER, shards, true),
    items: Array.from({ length: 60 }, (_, i) => ({ title: `t${i}`, why: `${i} `.padEnd(900, 'w') })),
  }
  const { parts } = cutRecord(rec)
  const dir = checkpointDir(rec, { store, project })
  const ckpt = { kind: rec.kind, name: rec.name, craftVersion: rec.craftVersion, workflowEngineRevision: 7, round: 2, branch: 'feat/x', head }
  for (const s of shards.slice(0, shards.length - shardsLost)) writeCheckpoint(dir, `ledger-${String(s.ledgerShard.index).padStart(2, '0')}`, { ...ckpt, ...s }, { project })
  for (const p of parts.slice(0, -1)) writeCheckpoint(dir, `record-${String(p.recordPart.index).padStart(2, '0')}`, { ...ckpt, ...p }, { project })
  recoverPartials({ store, project, now: new Date(Date.now() + 7 * 60 * 60 * 1000) })
  const [file] = fs.readdirSync(store).filter(f => f.endsWith('.json'))
  return { store, project, record: JSON.parse(fs.readFileSync(path.join(store, String(file)), 'utf8')) }
}

test('a short part set beside a whole shard set: partial, its shards kept in phases, the next round reads all 30 rows', () => {
  const { store, project, record } = deadRound(0)
  assert.equal(record.partial, true)
  assert.ok(record.phases.some((/** @type {object} */ p) => 'ledgerShard' in p), 'ledger shards stay in a partial record\'s phases')
  assert.ok(record.phases.every((/** @type {object} */ p) => !('recordPart' in p)), 'record parts never do')
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.equal(hit.ledger.length, 30)
})

test('a short part set beside a short shard set: the next round reads the ledger as truncated, not as a short round', () => {
  const { store, project } = deadRound(1)
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.ok(hit.ledger.length > 0 && hit.ledger.length < 30)
  assert.equal(hit.ledgerCount, 30, "the declared total beside a shorter array is what the engine reads as truncated")
})
