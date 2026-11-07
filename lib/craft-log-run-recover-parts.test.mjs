// `recover` on a run whose finalize died after its record's parts landed (realm @nick/craft, nodes #396, #401):
// the record is put back from the parts on finalize's terms, and they never become its phases.
import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkpointDir, writeCheckpoint, recoverPartials, finalizeRun } from './craft-log-run.mjs'
import { cutRecord } from './record-parts.mjs'
import { indexProjection } from './run-record.mjs'
import { run as analyze } from './analyze-runs.mjs'

const HOUR = 60 * 60 * 1000
/** @type {string[]} */
const made = []
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-recover-parts-'))
  made.push(d)
  return d
}

// A triage record (no round, as triage-findings files it) far past one call, so it goes in parts.
const BIG = {
  schemaVersion: 1, runtime: 'claude-code', kind: 'workflow', name: 'triage-findings', craftVersion: '9.9.9',
  workflowEngineRevision: 7, verdict: 'Warning', findings: { total: 60, bySeverity: { Critical: 0, High: 2, Medium: 30, Low: 28, Info: 0 } },
  items: Array.from({ length: 60 }, (_, i) => ({ title: `t${i}`, why: `${i} `.padEnd(900, 'w') })),
}

/**
 * The run's directory as the logger leaves it when finalize dies: one checkpoint per part, minted by the
 * first, each carrying what lib/run-logging.mjs puts on a part. `skip` names part indexes that never landed.
 * @param {string} store @param {{ skip?: number[], before?: string[] }} [o]
 */
function partsDir(store, { skip = [], before = [] } = {}) {
  const { header, parts } = cutRecord(BIG)
  assert.ok(parts.length >= 3)
  const dir = checkpointDir(BIG, { store, project: store })
  const head = { kind: BIG.kind, name: BIG.name, craftVersion: BIG.craftVersion, workflowEngineRevision: BIG.workflowEngineRevision }
  for (const phase of before) writeCheckpoint(dir, phase, { ...head, findings: BIG.findings }, { project: store })
  for (const part of parts) {
    if (skip.includes(part.recordPart.index)) continue
    writeCheckpoint(dir, `record-${String(part.recordPart.index).padStart(2, '0')}`, { ...head, ...part }, { project: store })
  }
  return { dir, header, parts }
}

/** @param {string} store */
const records = store => fs.readdirSync(store).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(store, f), 'utf8')))
/** @param {string} store */
const indexRows = store => fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
/** @param {string} store */
const deadListed = async store => (await analyze([store], {}, store)).stdout.join('\n').includes('Runs that did not finish')
const stale = () => new Date(Date.now() + 7 * HOUR)

test('finalize died after every part landed: recover files the complete record, its index row, no dead run', async () => {
  const store = tmp()
  const { dir } = partsDir(store)
  const [o] = recoverPartials({ store, project: store, now: stale() })
  assert.deepEqual([o?.kept, o?.warning, fs.existsSync(dir)], [false, '', false], 'a stale round-0 parts directory is removed')
  const [rec, ...more] = records(store)
  assert.equal(more.length, 0)
  assert.equal(rec.partial, undefined)
  assert.equal(rec.recordInParts, undefined)
  assert.equal(rec.phases, undefined, 'its parts are transport, never phases')
  assert.deepEqual(rec.items, BIG.items)
  assert.equal(rec.workflowEngineRevision, 7)
  assert.deepEqual(indexRows(store), [JSON.parse(JSON.stringify(indexProjection(rec)))])
  assert.equal(await deadListed(store), false)
})

test('a record put back from its parts keeps the run\'s own phases and drops the parts', () => {
  const store = tmp()
  partsDir(store, { before: ['scout'] })
  recoverPartials({ store, project: store, now: stale() })
  const [rec] = records(store)
  assert.equal(rec.partial, undefined)
  assert.deepEqual(rec.phases.map((/** @type {{ phase: string }} */ p) => p.phase), ['scout'])
})

test('a part never landed: a partial record with what the rest hold, no transport slice in phases, marked', async () => {
  const store = tmp()
  const { dir, parts } = partsDir(store, { skip: [2], before: ['scout'] })
  const [o] = recoverPartials({ store, project: store, now: stale() })
  assert.match(o?.warning ?? '', /declared in \d+ part\(s\), \d+ found/)
  assert.equal(fs.existsSync(dir), false)
  const [rec] = records(store)
  assert.equal(rec.partial, true)
  assert.deepEqual(rec.recordInParts, { of: parts.length, id: parts[0]?.recordPart.id, seen: parts.length - 1 })
  assert.deepEqual(rec.phases.map((/** @type {{ phase: string }} */ p) => p.phase), ['scout'])
  assert.ok(rec.phases.every((/** @type {object} */ p) => !('recordPart' in p) && !('recordEntries' in p)))
  assert.match(rec.partialReason, /sent in \d+ part\(s\) and \d+ came back/)
  assert.equal(rec.verdict, 'Warning (INCOMPLETE)')
  assert.ok(rec.items.length > 0 && rec.items.length < BIG.items.length, 'what the landed parts hold is filed')
  assert.equal(await deadListed(store), true)
})

test('a part altered in its copy: the content id refuses it as whole, filed partial', () => {
  const store = tmp()
  const { dir } = partsDir(store)
  const file = path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('record-02.json')) ?? '')
  const part = JSON.parse(fs.readFileSync(file, 'utf8'))
  part.recordEntries[0][1] = 'altered'
  fs.writeFileSync(file, JSON.stringify(part))
  const [o] = recoverPartials({ store, project: store, now: stale() })
  assert.match(o?.warning ?? '', /content id differs/)
  const [rec] = records(store)
  assert.equal(rec.partial, true)
  assert.equal(rec.recordInParts.altered, true)
})

test('a round-0 parts directory still possibly live is kept and marked; the run\'s finalize then replaces the record', () => {
  const store = tmp()
  const { dir, header } = partsDir(store)
  const [o] = recoverPartials({ store, project: store })
  assert.deepEqual([o?.live, o?.kept, fs.existsSync(dir)], [true, true, true])
  assert.deepEqual(recoverPartials({ store, project: store }), [], 'a second sweep files nothing more')
  const out = finalizeRun(/** @type {any} */ (header), { store, project: store, dir })
  assert.equal(out.file, o?.file)
  assert.equal(fs.existsSync(dir), false)
  assert.equal(records(store).length, 1)
  assert.equal(indexRows(store).length, 1)
})

test('a round-0 directory without parts is still kept as its round\'s witness', () => {
  const store = tmp()
  const dir = checkpointDir(BIG, { store, project: store })
  writeCheckpoint(dir, 'scout', { kind: BIG.kind, name: BIG.name }, { project: store })
  const [o] = recoverPartials({ store, project: store, now: stale() })
  assert.deepEqual([o?.kept, fs.existsSync(dir)], [true, true])
})
