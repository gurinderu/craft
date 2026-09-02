// The store is only worth having if a record on disk means what it says. These tests pin the three
// failure modes that actually happened: a record that lands truncated and looks complete, a run that
// dies before it writes anything at all, and a reconstruction that quietly claims candidate findings
// were confirmed ones.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  stamp, recordFilename, computedFields, writeRecord, checkpointDir, writeCheckpoint,
  readCheckpoints, recoverPartials, classifyResult, recordFromJournal, runtimeStats,
  backfillEngineRevision, normalizeStampBoundary,
} from './craft-log-run.mjs'
import { ENGINE_REVISION } from './run-record.mjs'

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'craft-store-'))
}

const RECORD = {
  schemaVersion: 1, runtime: 'claude-code', kind: 'workflow', name: 'review', nested: false, via: null,
  verdict: 'Block', findings: { total: 2, bySeverity: { Critical: 0, High: 2, Medium: 0, Low: 0, Info: 0 } },
  dimensions: [{ lens: 'safety', confirmed: 1 }, { lens: 'errors', confirmed: 1 }],
  verification: { candidates: 5, confirmed: 2, refuteRate: 0.6 },
}

test('stamp is UTC, filename-safe and lexically sortable', () => {
  const a = stamp(new Date('2026-08-02T13:50:13.482Z'))
  assert.equal(a, '2026-08-02T13-50-13Z')
  // selectPriorRound picks the newest prior round by STRING comparison; chronology must survive it.
  assert.ok(stamp(new Date('2026-08-02T13:50:14Z')) > a)
  assert.ok(stamp(new Date('2026-12-31T23:59:59Z')) > stamp(new Date('2026-08-02T13:50:13Z')))
  assert.equal(/[:]/.test(a), false, 'a colon would break the filename on some filesystems')
})

test('recordFilename cannot be steered out of the store by a hostile kind/name', () => {
  assert.equal(recordFilename({ ts: '2026-08-02T13-50-13Z', kind: 'workflow', name: 'review' }), '2026-08-02T13-50-13Z-workflow-review.json')
  const evil = recordFilename({ ts: 'x', kind: '../../etc', name: 'pa/ss wd' })
  assert.equal(evil.includes('/'), false, 'no path separator survives')
  assert.equal(evil.includes('..'), true, 'dots are kept — only separators are neutralised')
  assert.equal(recordFilename({}), 'unknown-unknown-unknown.json', 'a record missing every field still gets a name')
})

test('writeRecord owns the computed fields and refuses to trust the caller', () => {
  const store = tmpStore()
  // The old prompt asked a model to compute these. If a caller supplies its own, the script wins.
  const { file, record } = writeRecord({ ...RECORD, ts: 'LIES', project: '/nope', commit: 'deadbeef' }, { store, project: store })
  assert.notEqual(record.ts, 'LIES')
  assert.equal(record.project, store)
  assert.equal(typeof record.dirty, 'boolean')
  const back = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(back.dimensions.length, 2, 'arrays survive the round trip')
  assert.deepEqual(back.verification, RECORD.verification)
})

test('writeRecord appends exactly one index line per run and it carries the engine version', () => {
  const store = tmpStore()
  writeRecord(RECORD, { store, project: store })
  writeRecord({ ...RECORD, verdict: 'Approve' }, { store, project: store, now: new Date(Date.now() + 1000) })
  const lines = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  const idx = lines.map(l => JSON.parse(l))
  assert.equal(idx[0].findingsTotal, 2, 'the index carries the count the analyzer filters on')
  assert.deepEqual(idx.map(e => e.verdict), ['Block', 'Approve'])
  for (const e of idx) assert.ok('craftCommit' in e, 'craftCommit must ride in the INDEX, not only the detail file')
  assert.ok(fs.existsSync(path.join(store, 'README.md')), 'the store documents itself on first write')
})

test('computedFields never throws on a path that is not a git repo', () => {
  const dir = tmpStore()
  const f = computedFields(dir, new Date('2026-08-02T13:50:13Z'))
  assert.equal(f.commit, '', 'unresolvable commit is empty, not an exception')
  assert.equal(f.dirty, false)
  assert.equal(f.ts, '2026-08-02T13-50-13Z')
})

// ---- checkpoints + recovery ----
test('checkpoints survive a run that never finalizes, and recover turns them into a partial record', () => {
  const store = tmpStore()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: store, now: new Date('2026-08-02T14:26:15Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'pr-1203-review', head: 'dd95346d', gate: { status: 'pass' } })
  writeCheckpoint(dir, 'rust-lenses', { ranLenses: ['safety', 'errors'], candidates: { total: 179, bySeverity: {} } })
  // …and then the run dies. Nothing calls finalize.
  const phases = readCheckpoints(dir)
  assert.deepEqual(phases.map(p => p.phase), ['rust-plan', 'rust-lenses'], 'checkpoints replay in the order they were written')

  const out = recoverPartials({ store, project: store })
  assert.equal(out.length, 1)
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.equal(rec.partial, true, 'a run that did not finish must never look complete')
  assert.equal(rec.head, 'dd95346d')
  assert.equal(rec.branch, 'pr-1203-review')
  assert.equal(rec.phases.length, 2)
  assert.ok(rec.notRun.length, 'and it must say outright that the rest is missing')
  // The recovered record keeps the identity its checkpoints were written under, not "now".
  assert.ok(path.basename(out[0].file).startsWith('2026-08-02T14-26-15Z'), 'ts comes from the checkpoint dir')
  assert.equal(fs.existsSync(dir), false, 'the partial dir is consumed, so a second recover is a no-op')
  assert.deepEqual(recoverPartials({ store, project: store }), [])
})

test('recover leaves a run alone once it has been finalized', () => {
  const store = tmpStore()
  const now = new Date('2026-08-02T14:26:15Z')
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: store, now })
  writeCheckpoint(dir, 'rust-plan', { gate: { status: 'pass' } })
  writeRecord(RECORD, { store, project: store, now }) // same ts/kind/name → same filename
  assert.deepEqual(recoverPartials({ store, project: store }), [], 'a finalized run is not resurrected as a partial one')
})

// ---- journal reconstruction ----
test('classifyResult separates the agent result shapes a review actually produces', () => {
  assert.equal(classifyResult({ lens: 'safety', findings: [] }), 'lens')
  assert.equal(classifyResult({ refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true }), 'verify')
  assert.equal(classifyResult({ verdicts: [{ index: 0, refuted: true }] }), 'verify-batch')
  assert.equal(classifyResult({ sizeBucket: 'medium', lenses: ['safety'] }), 'scout')
  assert.equal(classifyResult({ baseRef: 'origin/main', files: ['a.rs'] }), 'base')
  assert.equal(classifyResult({ status: 'pass', seedFindings: [] }), 'gate')
  assert.equal(classifyResult({ groups: [[0, 1]] }), 'dedup')
  assert.equal(classifyResult({ missingLenses: [] }), 'critic')
  assert.equal(classifyResult(null), 'unknown')
  assert.equal(classifyResult('a string'), 'unknown')
})

function fakeJournal(dir, entries) {
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n')
}

test('recordFromJournal rebuilds a dead run and never passes candidates off as confirmed findings', () => {
  const dir = tmpStore()
  const hi = (source, title) => ({ severity: 'High', title, file: 'a.rs', line: 1, why: 'w', source })
  fakeJournal(dir, [
    { type: 'started', agentId: 'a1' }, { type: 'started', agentId: 'a2' }, { type: 'started', agentId: 'a3' },
    { type: 'started', agentId: 'a4' }, { type: 'started', agentId: 'a5' }, { type: 'started', agentId: 'a6' },
    { type: 'result', agentId: 'a1', result: { baseRef: 'origin/main', files: ['a.rs'], head: 'abc1234', branch: 'feat' } },
    // The scout's real schema: it classifies, it does not budget — no maxRounds, no verifyVotes.
    { type: 'result', agentId: 'a2', result: { sizeBucket: 'medium', lenses: ['safety'], isLibrary: false, securitySensitive: true } },
    { type: 'result', agentId: 'a3', result: { status: 'pass', seedFindings: [hi('clippy', 'seed defect')] } },
    { type: 'result', agentId: 'a4', result: { lens: 'safety', findings: [hi('safety', 'unwrap panics')] } },
    { type: 'result', agentId: 'a5', result: { refuted: true, citedLineMatches: true, reachable: true, premiseSupported: true } },
    // a6 never returned — the usage-limit death this whole path exists for.
  ])
  const rec = recordFromJournal(dir)
  assert.equal(rec.partial, true)
  assert.match(rec.verdict, /\(candidates\)$/, 'the verdict must be labelled as pre-verification')
  assert.equal(rec.findings.total, 2, 'lens findings AND gate seeds are both candidates')
  assert.deepEqual(rec.candidatesBySource, { clippy: 1, safety: 1 })
  assert.equal(rec.agentsStarted, 6)
  assert.equal(rec.agentsReturned, 5)
  assert.equal(rec.agentsLost, 1)
  assert.ok(rec.notRun.length, 'a lost agent is reported, not silently dropped')
  assert.deepEqual(rec.verificationVotes, { refuted: 1, upheld: 0 })
  assert.equal(rec.head, 'abc1234')
  // Rigor is derived on the plan, which no transcript carries — the reconstruction says size and
  // lenses rather than claiming rigor it cannot observe.
  assert.deepEqual(rec.scout, [{ size: 'medium', lenses: ['safety'] }])
})

test('recordFromJournal survives a corrupt journal line instead of losing the whole run', () => {
  const dir = tmpStore()
  fs.writeFileSync(path.join(dir, 'journal.jsonl'),
    '{"type":"started","agentId":"a1"}\n{ this is not json\n{"type":"result","agentId":"a1","result":{"lens":"safety","findings":[]}}\n')
  const rec = recordFromJournal(dir)
  assert.equal(rec.agentsStarted, 1)
  assert.equal(rec.agentsReturned, 1)
})

test('runtimeStats reports the longest silence inside one agent, not just totals', () => {
  const dir = tmpStore()
  // A "slow" agent and a HUNG one have similar durations; only the stall tells them apart, and that
  // is the difference between a review that is working and one that is dead for an hour.
  const at = s => ({ timestamp: new Date(Date.parse('2026-08-02T14:00:00Z') + s * 1000).toISOString() })
  fs.writeFileSync(path.join(dir, 'agent-busy.jsonl'), [0, 60, 120, 180, 240, 300].map(s => JSON.stringify(at(s))).join('\n'))
  fs.writeFileSync(path.join(dir, 'agent-busy.meta.json'), JSON.stringify({ model: 'sonnet' }))
  fs.writeFileSync(path.join(dir, 'agent-hung.jsonl'), [0, 20, 3860].map(s => JSON.stringify(at(s))).join('\n'))
  fs.writeFileSync(path.join(dir, 'agent-hung.meta.json'), JSON.stringify({ model: 'sonnet' }))
  const s = runtimeStats(dir)
  assert.equal(s.agents, 2)
  assert.equal(s.longestStallSeconds, 3840, 'the 64-minute hang is visible')
  assert.equal(s.wallClockMinutes, 64.3)
  assert.deepEqual(s.byModel, { sonnet: 2 })
})

test('runtimeStats on a directory with no agent logs returns zeros rather than throwing', () => {
  assert.deepEqual(runtimeStats(tmpStore()), { agents: 0, wallClockMinutes: 0, agentMinutes: 0, longestStallSeconds: 0, byModel: {} })
  assert.equal(runtimeStats(path.join(os.tmpdir(), 'craft-does-not-exist-xyz')).agents, 0)
})

test('every written record says which engine wrote it, and the caller cannot lie about it', () => {
  const store = tmpStore()
  assert.equal(computedFields().engineRevision, ENGINE_REVISION)
  // A record that claims a different revision is overwritten by the computed one: the writer knows
  // which craft is running, the payload only thinks it does.
  const { record } = writeRecord({ ...RECORD, engineRevision: 999 }, { store })
  assert.equal(record.engineRevision, ENGINE_REVISION)
  const back = JSON.parse(fs.readFileSync(path.join(store, recordFilename(record)), 'utf8'))
  assert.equal(back.engineRevision, ENGINE_REVISION, 'it survives to disk, not just to the return value')
})

test('a recovered dead run is attributed too — an outage record is still an engine record', () => {
  const store = tmpStore()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store })
  writeCheckpoint(dir, 'scout', { verdict: 'Block' })
  const [out] = recoverPartials({ store })
  assert.equal(JSON.parse(fs.readFileSync(out.file, 'utf8')).engineRevision, ENGINE_REVISION)
})

test('normalizeStampBoundary accepts both spellings of a timestamp and rejects junk', () => {
  assert.equal(normalizeStampBoundary('2026-09-01T20:08:31Z'), '2026-09-01T20-08-31Z')
  assert.equal(normalizeStampBoundary('2026-09-01T20-08-31Z'), '2026-09-01T20-08-31Z')
  assert.equal(normalizeStampBoundary('2026-09-01T20:08:31.123Z'), '2026-09-01T20-08-31Z')
  assert.equal(normalizeStampBoundary('yesterday'), null)
  assert.equal(normalizeStampBoundary(''), null)
})

test('backfill-engine stamps only what predates the cut, and only when asked to write', () => {
  const store = tmpStore()
  const write = (name, rec) => fs.writeFileSync(path.join(store, name), JSON.stringify(rec, null, 2))
  write('a.json', { schemaVersion: 1, ts: '2026-08-05T01-59-07Z', name: 'review' })
  write('b.json', { schemaVersion: 1, ts: '2026-09-01T23-00-00Z', name: 'review' })   // after the cut
  write('c.json', { schemaVersion: 1, ts: '2026-08-06T01-00-00Z', name: 'review', engineRevision: 2 })
  write('d.json', { schemaVersion: 1, name: 'review' })                               // no ts at all
  fs.writeFileSync(path.join(store, 'broken.json'), '{')

  const dry = backfillEngineRevision({ store, revision: 1, before: '2026-09-01T20:08:31Z' })
  assert.deepEqual(dry.stamped, ['a.json'])
  assert.equal(dry.alreadyAttributed, 1, 'an attributed record is never rewritten')
  // b (after the cut) and d (unplaceable) are both left alone: neither can be classified without
  // guessing, and guessing is the defect.
  assert.deepEqual(dry.afterCut.sort(), ['b.json', 'd.json'])
  assert.equal(dry.unreadable.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(store, 'a.json'), 'utf8')).engineRevision, undefined,
    'a dry run writes nothing')

  const applied = backfillEngineRevision({ store, revision: 1, before: '2026-09-01T20:08:31Z', apply: true })
  assert.deepEqual(applied.stamped, ['a.json'])
  assert.equal(JSON.parse(fs.readFileSync(path.join(store, 'a.json'), 'utf8')).engineRevision, 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(store, 'b.json'), 'utf8')).engineRevision, undefined)
  assert.equal(JSON.parse(fs.readFileSync(path.join(store, 'c.json'), 'utf8')).engineRevision, 2)
  // Idempotent: a second pass has nothing left to do.
  assert.deepEqual(backfillEngineRevision({ store, revision: 1, before: '2026-09-01T20:08:31Z' }).stamped, [])
})

test('backfill-engine refuses a missing revision or an unparseable cut', () => {
  const store = tmpStore()
  assert.throws(() => backfillEngineRevision({ store, before: '2026-09-01T20:08:31Z' }), /--revision/)
  assert.throws(() => backfillEngineRevision({ store, revision: 1 }), /--before/)
  assert.throws(() => backfillEngineRevision({ store, revision: 1, before: 'soon' }), /--before/)
})
