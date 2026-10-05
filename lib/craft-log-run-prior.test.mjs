// The prior-round read path, pinned at its edges: the exact empty answer, the ledger shape the
// workflow's strict schema needs, the transport cap, the chain evidence a dead run's directory
// gives, and why a row does or does not become a round.
import { test, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  PRIOR_ROUND_NONE, normalizeLedger, findPriorRound, partialChainEvidence, priorFpRevisions, priorBasisVerdict,
  recordFilename, checkpointDir, writeCheckpoint, WHY_TRANSPORT_MAX,
} from './craft-log-run.mjs'

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior-edges-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const EMPTY_ITEM = { fp: '', file: '', line: 0, symbol: '', severity: '', tier: '', disposition: '', source: '', ruleId: '', title: '', why: '' }
const TS = '2026-10-01T00-00-00Z'

/** @param {string} store @param {unknown[]} rows */
const writeIndex = (store, rows) => fs.writeFileSync(path.join(store, 'index.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
/** @param {string} store @param {Record<string, unknown>} rec */
const writeRec = (store, rec) => fs.writeFileSync(path.join(store, recordFilename(rec)), JSON.stringify(rec))
const repoWithHead = () => {
  const repo = tmp()
  execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: repo })
  return { repo, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() }
}
/** @param {string} repo @param {string} head @param {Record<string, unknown>} [over] */
const row = (repo, head, over = {}) => ({ ts: TS, kind: 'workflow', name: 'review', project: repo, branch: 'feat/x', head, round: 1, findingsTotal: 3, ...over })

test('the empty prior round, exactly', () => {
  assert.deepEqual(PRIOR_ROUND_NONE, {
    found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, journalSourced: false,
    sameFpBasis: false, fpBasisKnown: false, priorFpRevisions: [], priorFpRevisionsCheck: '', reason: '',
  })
})

test('normalizeLedger: every key at its natural empty, nothing for a non-array, a whyRef kept only when both parts are strings', () => {
  assert.deepEqual(normalizeLedger([{}, null]), [EMPTY_ITEM, EMPTY_ITEM])
  assert.deepEqual(normalizeLedger('x'), [])
  assert.deepEqual(normalizeLedger([{ whyRef: null }, { whyRef: { record: 5, fp: 'f' } }, { whyRef: { record: 'r', fp: 5 } }]), [EMPTY_ITEM, EMPTY_ITEM, EMPTY_ITEM])
  assert.deepEqual(normalizeLedger([{ whyRef: { record: 'r', fp: 'f', extra: 1 } }]), [{ ...EMPTY_ITEM, whyRef: { record: 'r', fp: 'f' } }])
})

test('a complete round found without a workdir: a why at the cap crosses whole, the row\'s count stands in for a record without findings', () => {
  const store = tmp()
  const { repo, head } = repoWithHead()
  writeIndex(store, [row(repo, head)])
  const atCap = 'w'.repeat(WHY_TRANSPORT_MAX)
  writeRec(store, { ts: TS, kind: 'workflow', name: 'review', round: 1, ledger: [{ fp: 'a', why: atCap }] })
  const r = findPriorRound({ store, project: repo, branch: 'feat/x' })
  assert.equal(r.found, true)
  assert.deepEqual(r.ledger, [{ ...EMPTY_ITEM, fp: 'a', why: atCap }])
  assert.equal(r.priorFindings, 3)
})

test('a row whose record is gone proves a degraded round, with no revisions claimed', () => {
  const store = tmp()
  const { repo, head } = repoWithHead()
  writeIndex(store, [row(repo, head, { round: 4 })])
  const r = findPriorRound({ store, project: repo, branch: 'feat/x' })
  assert.deepEqual([r.found, r.round, r.head, r.ledger, r.priorFindings], [true, 4, head, [], 3])
  assert.deepEqual([r.priorFpRevisions, r.priorFpRevisionsCheck], [[], ''])
})

test('a partial record with no findings field proves its round with the row\'s count', () => {
  const store = tmp()
  const { repo, head } = repoWithHead()
  writeIndex(store, [row(repo, head)])
  writeRec(store, { ts: TS, kind: 'workflow', name: 'review', partial: true, round: 2 })
  const r = findPriorRound({ store, project: repo, branch: 'feat/x' })
  assert.deepEqual([r.found, r.round, r.priorFindings, r.journalSourced], [true, 2, 3, true])
})

test('no branch, no prior round', () => {
  assert.equal(findPriorRound({ store: tmp() }).reason, 'no-branch')
})

test('why no row matched: only an all-but-absolute review row of this branch reads as unattributable', () => {
  const base = { ts: TS, kind: 'workflow', name: 'review', branch: 'b', project: '.' }
  /** @param {Record<string, unknown>} over */
  const reason = over => {
    const store = tmp()
    writeIndex(store, [{ ...base, ...over }])
    return findPriorRound({ store, project: '/repo-x', branch: 'b' }).reason
  }
  assert.equal(reason({}), 'unattributable-rows-only')
  for (const over of [{ kind: 'agent' }, { name: 'other' }, { branch: 'c' }, { project: 5 }, { project: '/elsewhere' }]) {
    assert.equal(reason(over), 'no-candidate-rows', JSON.stringify(over))
  }
})

test('a relative project is never searched under its own spelling', () => {
  const store = tmp()
  writeIndex(store, [{ ts: TS, kind: 'workflow', name: 'review', branch: 'b', project: '.', head: '' }])
  assert.equal(findPriorRound({ store, project: '.', branch: 'b' }).reason, 'unattributable-rows-only')
})

/** @param {string} store @param {Date} at @param {Record<string, unknown>} payload @param {Record<string, unknown>} [record] */
const deadDir = (store, at, payload, record = { kind: 'workflow', name: 'review' }) => {
  const dir = checkpointDir(record, { store, now: at, project: '/p' })
  writeCheckpoint(dir, 'scout', payload, { project: '/p' })
  return dir
}

test('chain evidence: any branch when none is asked, newest first, only review directories, nothing from a broken partial store', () => {
  const store = tmp()
  const older = deadDir(store, new Date('2026-10-01T00:00:00Z'), { branch: 'feat/x', head: 'h1' })
  const newer = deadDir(store, new Date('2026-10-02T00:00:00Z'), { branch: 'feat/x', head: 'h2' })
  const middle = deadDir(store, new Date('2026-10-01T12:00:00Z'), { branch: 'feat/x', head: 'h3' })
  deadDir(store, new Date('2026-10-01T06:00:00Z'), { branch: 'feat/x', head: 'h4' }, { kind: 'workflow', name: 'other' })
  fs.symlinkSync(path.join(store, 'nowhere'), path.join(store, '.partial', '2026-10-03T00-00-00Z-workflow-review'))
  assert.deepEqual(partialChainEvidence({ store, project: '/p' }).map(e => e.dir), [newer, middle, older])
  const broken = tmp()
  fs.writeFileSync(path.join(broken, '.partial'), '')
  assert.deepEqual(partialChainEvidence({ store: broken, project: '/p' }), [])
})

test('chain evidence names the revisions its checkpoints were minted under, comma-separated', () => {
  const store = tmp()
  const dir = deadDir(store, new Date('2026-10-01T00:00:00Z'), { workflowEngineRevision: 3 })
  writeCheckpoint(dir, 'gate', { workflowEngineRevision: 4 }, { project: '/p' })
  const [e] = partialChainEvidence({ store, project: '/p' })
  assert.deepEqual([e?.priorFpRevisions, e?.priorFpRevisionsCheck], [[3, 4], '3,4'])
})

test('priorFpRevisions: no record, and a partial record with neither phases nor a kept revision, establish nothing', () => {
  assert.deepEqual(priorFpRevisions(null), [])
  assert.deepEqual(priorFpRevisions({ partial: true }), [])
  assert.equal(priorBasisVerdict({ partial: true, phases: [{ workflowEngineRevision: 3 }, { workflowEngineRevision: 4 }] }).priorFpRevisionsCheck, '3,4')
})
