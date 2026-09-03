// The store is only worth having if a record on disk means what it says. These tests pin the three
// failure modes that actually happened: a record that lands truncated and looks complete, a run that
// dies before it writes anything at all, and a reconstruction that quietly claims candidate findings
// were confirmed ones.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  stamp, recordFilename, computedFields, writeRecord, checkpointDir, writeCheckpoint,
  readCheckpoints, recoverPartials, classifyResult, recordFromJournal, runtimeStats,
  backfillEngineRevision, normalizeStampBoundary, repairIndex, compactPrettyBlock, readJsonlCounted,
  indexKey, describeBlock, blockFields, findRejoinableDir, finalizeRun, dirIdentity, identityAgrees,
} from './craft-log-run.mjs'
import { ENGINE_REVISION } from './run-record.mjs'

const SCRIPT = fileURLToPath(new URL('./craft-log-run.mjs', import.meta.url))

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

// The failure this pins: the FIRST checkpoint is what mints the run directory and hands `runDir`
// back to the sandboxed workflow. When it dies (dead logger agent, a moved craftRoot, a throw) the
// workflow has no runDir to thread, so every LATER checkpoint of the same run asked for a fresh
// directory named after a fresh `now` — one run fragmenting into several orphan partials, each
// holding one phase, and `recover` then reporting them as unrelated half-runs.
test('a run whose first checkpoint failed still lands in ONE directory', () => {
  const store = tmpStore()
  // Phase 1 never reaches disk at all — that is the failure.
  // Phase 2 mints the directory, minutes later.
  const d2 = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: store, rejoin: true, now: new Date('2026-08-02T14:26:15Z') })
  writeCheckpoint(d2, 'rust-lenses', { ranLenses: ['safety'], candidates: { total: 12, bySeverity: {} } }, { project: store })
  // Phase 3 comes with no --dir either, because the workflow still has no runDir.
  const d3 = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: store, rejoin: true, now: new Date('2026-08-02T14:41:02Z') })
  writeCheckpoint(d3, 'rust-verify', { verdict: 'Block' }, { project: store })
  assert.equal(d3, d2, 'a later checkpoint of the same run rejoins the directory the run already has')
  assert.equal(fs.readdirSync(path.join(store, '.partial')).length, 1, 'one run, one partial directory')

  const out = recoverPartials({ store, project: store })
  assert.equal(out.length, 1, 'one interrupted run, not several unrelated half-runs')
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.deepEqual(rec.phases.map(p => p.phase), ['rust-lenses', 'rust-verify'])
  assert.equal(rec.verdict, 'Block')
})

test('a stale leftover is not adopted by the next run', () => {
  const store = tmpStore()
  const dead = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: store, now: new Date('2026-08-01T09:00:00Z') })
  writeCheckpoint(dead, 'rust-plan', { branch: 'old', gate: { status: 'pass' } }, { project: store })
  // A day later a different run starts. Folding its phases into yesterday's corpse would file one
  // record describing two runs — the corruption the rejoin must not trade for the fragmentation.
  const fresh = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: store, rejoin: true, now: new Date('2026-08-02T14:26:15Z') })
  assert.notEqual(fresh, dead)
  assert.equal(fs.readdirSync(path.join(store, '.partial')).length, 2)
})

// The guard this pins used to look for `<dirname>.json` in the store — a file that cannot exist,
// because writeRecord stamps a FRESH ts from `now` and the record therefore never shares the
// directory's name. It is a marker finalize writes now, so the guard can actually match.
test('recover leaves a run alone once it has been finalized', () => {
  const store = tmpStore()
  const now = new Date('2026-08-02T14:26:15Z')
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: store, now })
  writeCheckpoint(dir, 'rust-plan', { gate: { status: 'pass' } }, { project: store })
  finalizeRun(RECORD, { store, project: store, dir, now: new Date('2026-08-02T14:40:00Z') })
  assert.deepEqual(recoverPartials({ store, project: store }), [], 'a finalized run is not resurrected as a partial one')

  // …and the same holds when the removal itself failed and the directory survived: the marker, not
  // the absence of the directory, is what says "already finalized".
  const kept = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: store, now })
  writeCheckpoint(kept, 'rust-plan', { gate: { status: 'pass' } }, { project: store })
  fs.writeFileSync(path.join(kept, '.finalized'), 'x\n')
  assert.deepEqual(recoverPartials({ store, project: store }), [], 'a marked directory is not recovered')
  assert.equal(findRejoinableDir({ kind: 'workflow', name: 'review' }, { store, project: store, now: new Date('2026-08-02T14:41:00Z') }), null,
    'nor adopted by a later rejoin')
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

// The real store's index was found holding 268 lines of which 29 did not parse, in two hand-written
// blocks: one a pretty-printed index projection that joins cleanly, one truncated mid-object. These
// pin both classes, the good lines surviving untouched, and the refusal to invent the damaged one.
const GOOD_A = '{"schemaVersion":1,"runtime":"claude-code","ts":"2026-07-18T21-17-02Z","kind":"workflow","name":"review","project":"/p","commit":"aaa","dirty":false,"verdict":"Approve","findingsTotal":0,"nested":false,"via":null}'
const GOOD_B = '{"schemaVersion":1,"runtime":"claude-code","ts":"2026-08-27T19-58-04Z","kind":"agent","name":"rust-reviewer","project":"/p","commit":"bbb","dirty":true,"verdict":"Warning","findingsTotal":8,"nested":false,"via":null}'
// Pretty-printed by hand where one compact line belonged — joins into exactly one object.
const PRETTY = ['{', '  "schemaVersion": 1,', '  "kind": "workflow",', '  "name": "triage-findings",', '  "ts": "2026-08-27T10-06-51Z",', '  "dirty": false', '}']
// The same accident, but truncated: no closing brace. Nothing here is recoverable without inventing.
const DAMAGED = ['{', '  "schemaVersion": 1,', '  "kind": "workflow",', '  "name": "adversarial-review",', '  "dirty": true']

function corruptIndex() {
  const store = tmpStore()
  fs.writeFileSync(path.join(store, 'index.jsonl'), [GOOD_A, ...DAMAGED, GOOD_B, ...PRETTY].join('\n') + '\n')
  return store
}

test('repair-index compacts a pretty-printed block, quarantines a damaged one, and writes nothing when dry', () => {
  const store = corruptIndex()
  const before = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8')

  const dry = repairIndex({ store })
  assert.equal(dry.parsedBefore, 2)
  assert.equal(dry.recovered.length, 1)
  assert.deepEqual([dry.recovered[0].from, dry.recovered[0].to], [8, 14])
  assert.equal(dry.recovered[0].line, '{"schemaVersion":1,"kind":"workflow","name":"triage-findings","ts":"2026-08-27T10-06-51Z","dirty":false}')
  assert.equal(dry.quarantined.length, 1)
  assert.deepEqual([dry.quarantined[0].from, dry.quarantined[0].to], [2, 6])
  assert.equal(dry.backup, null)
  assert.equal(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8'), before, 'a dry run writes nothing')

  const applied = repairIndex({ store, apply: true })
  const lines = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)
  // Every previously-parsing line survives byte for byte, in order, and the recovered row joins them.
  assert.deepEqual(lines, [GOOD_A, GOOD_B, applied.recovered[0].line])
  assert.equal(readJsonlCounted(path.join(store, 'index.jsonl')).malformed, 0)
  // The damaged block is preserved verbatim in the sidecar and NOT reconstructed into the index.
  const quarantine = fs.readFileSync(applied.quarantineFile, 'utf8')
  assert.match(quarantine, /lines 2-6/)
  assert.ok(quarantine.includes(DAMAGED.join('\n')))
  assert.equal(lines.filter(l => l.includes('adversarial-review')).length, 0)
  // The original is recoverable in full.
  assert.equal(fs.readFileSync(applied.backup, 'utf8'), before)

  // Idempotent: the repaired file is already clean, so a second pass finds nothing and writes nothing.
  const again = repairIndex({ store, apply: true })
  assert.deepEqual([again.recovered.length, again.quarantined.length, again.backup], [0, 0, null])
  assert.deepEqual(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').split('\n').filter(Boolean), lines)
})

test('repair-index recovers only a block that joins into one plain object', () => {
  assert.equal(compactPrettyBlock(['{', '  "a": 1', '}']), '{"a":1}')
  assert.equal(compactPrettyBlock(['{', '  "a": 1']), null)          // truncated
  assert.equal(compactPrettyBlock(['[', '  1', ']']), null)          // an array is not an index row
  assert.equal(compactPrettyBlock(['not', 'json']), null)
  assert.throws(() => repairIndex({ store: tmpStore() }), /no index\.jsonl/)
})

// The real store's block 40-53, verbatim, and the healthy compact line 54 it duplicates field for
// field. In the store the block is unparsable only because the closing brace is missing — luck, not
// design, is what kept the repair from double-counting this run. Here the brace is CLOSED, so the
// block joins and the duplicate guard is the only thing standing between it and the aggregates.
const REAL_BLOCK_40_53 = [
  "{",
  "  \"schemaVersion\": 1,",
  "  \"runtime\": \"claude-code\",",
  "  \"kind\": \"workflow\",",
  "  \"name\": \"adversarial-review\",",
  "  \"verdict\": \"Block\",",
  "  \"findingsTotal\": 6,",
  "  \"nested\": false,",
  "  \"via\": null,",
  "  \"outputTokens\": 384529,",
  "  \"ts\": \"2026-07-19T09-46-09Z\",",
  "  \"project\": \"/Users/gurinderu/projects/craft\",",
  "  \"commit\": \"363e76a\",",
  "  \"dirty\": true",
]
const REAL_LINE_54 = '{"schemaVersion":1,"runtime":"claude-code","kind":"workflow","name":"adversarial-review","verdict":"Block","findingsTotal":6,"nested":false,"via":null,"outputTokens":384529,"ts":"2026-07-19T09-46-09Z","project":"/Users/gurinderu/projects/craft","commit":"363e76a","dirty":true}'

test('a recovered block that duplicates a run already in the index is quarantined, not counted twice', () => {
  const store = tmpStore()
  const closed = [...REAL_BLOCK_40_53, '}']
  assert.notEqual(compactPrettyBlock(closed), null, 'with the brace closed the block DOES join — the guard is the only defence')
  // The twin sits AFTER the block, exactly as in the real store: the guard must look at the whole file.
  fs.writeFileSync(path.join(store, 'index.jsonl'), [GOOD_A, ...closed, REAL_LINE_54, GOOD_B].join('\n') + '\n')

  const res = repairIndex({ store, apply: true })
  assert.equal(res.recovered.length, 0, 'the duplicate must NOT be recovered into the index')
  assert.equal(res.quarantined.length, 1)
  assert.match(res.quarantined[0].reason, /duplicates a run already in the index/)
  const lines = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)
  assert.deepEqual(lines, [GOOD_A, REAL_LINE_54, GOOD_B], 'the good lines survive and the run appears exactly once')
  assert.equal(lines.filter(l => l.includes('2026-07-19T09-46-09Z')).length, 1, 'the run is counted once by jq -s, not twice')
  // The header says WHAT the block is, so a hand repair cannot silently reintroduce it.
  const quarantine = fs.readFileSync(res.quarantineFile, 'utf8')
  assert.match(quarantine, /duplicates a run already in the index/)
  assert.match(quarantine, /# block: ts=2026-07-19T09-46-09Z kind=workflow name=adversarial-review/)
  assert.ok(quarantine.includes(closed.join('\n')), 'the bytes are preserved verbatim')
})

test('the duplicate key is the run identity, and the sidecar describes a block that does not parse', () => {
  const a = { ts: '2026-07-19T09-46-09Z', kind: 'workflow', name: 'adversarial-review', project: '/p' }
  // Key order and extra fields differ — byte identity would miss this; run identity does not.
  assert.equal(indexKey(a), indexKey({ name: 'adversarial-review', project: '/p', kind: 'workflow', ts: a.ts, outputTokens: 1 }))
  assert.notEqual(indexKey(a), indexKey({ ...a, ts: '2026-07-19T09-46-10Z' }), 'a different second is a different run')
  assert.notEqual(indexKey(a), indexKey({ ...a, project: '/q' }), 'the same workflow in another project is another run')
  // No ts and no name → nothing identifies a run, so fall back to the bytes.
  assert.equal(indexKey({ foo: 1 }, 'RAW'), indexKey({ foo: 2 }, 'RAW'))
  assert.notEqual(indexKey({ foo: 1 }, 'RAW'), indexKey({ foo: 1 }, 'OTHER'))
  // describeBlock reads the raw bytes, so it works on the truncated class too.
  assert.deepEqual(blockFields(DAMAGED), { kind: 'workflow', name: 'adversarial-review' })
  assert.equal(describeBlock(DAMAGED), 'kind=workflow name=adversarial-review')
  assert.equal(describeBlock(['garbage']), '(no recognisable fields)')
})

test('an unrecoverable block whose run is already in the index warns against completing it by hand', () => {
  const store = tmpStore()
  // The real store's shape: block 40-53 truncated (no closing brace), its healthy twin on line 54.
  fs.writeFileSync(path.join(store, 'index.jsonl'), [...REAL_BLOCK_40_53, REAL_LINE_54].join('\n') + '\n')
  const res = repairIndex({ store, apply: true })
  assert.equal(res.recovered.length, 0)
  assert.match(res.quarantined[0].reason, /ALREADY in the index; do not complete it by hand/)
  // …and an unrecoverable block that is NOT a duplicate says only that it does not join.
  const other = tmpStore()
  fs.writeFileSync(path.join(other, 'index.jsonl'), [GOOD_A, ...DAMAGED].join('\n') + '\n')
  assert.equal(repairIndex({ store: other }).quarantined[0].reason, 'does not join into one JSON object')
})

test('a repair that finds nothing writes nothing and says so', () => {
  const store = tmpStore()
  fs.writeFileSync(path.join(store, 'index.jsonl'), [GOOD_A, GOOD_B].join('\n') + '\n')
  const res = repairIndex({ store, apply: true })
  assert.deepEqual([res.recovered.length, res.quarantined.length, res.backup, res.quarantineFile], [0, 0, null, null])
  const out = execFileSync(process.execPath, [SCRIPT, 'repair-index', '--apply', '--store', store], { encoding: 'utf8' })
  assert.match(out, /already clean/)
  assert.equal(/repaired/.test(out), false, 'nothing was written, so nothing may claim it was')
  assert.equal(fs.existsSync(path.join(store, 'index.jsonl.repair')), false)
})

test('the run identity ignores a trailing slash on project — a re-typed path is the same project', () => {
  // What this key guards against is a hand-reproduced projection, so the differences to expect are
  // the ones a human or a model introduces without noticing. `/p/` for `/p` is the cheapest of them,
  // and left unnormalised it reads as a second project and lets the duplicate back into the index.
  const row = { ts: '2026-07-19T09-46-09Z', kind: 'workflow', name: 'adversarial-review', project: '/Users/x/craft' }
  assert.equal(indexKey(row), indexKey({ ...row, project: '/Users/x/craft/' }), 'one trailing slash is the same run')
  assert.equal(indexKey(row), indexKey({ ...row, project: '/Users/x/craft///' }), 'several are too')
  assert.notEqual(indexKey(row), indexKey({ ...row, project: '/Users/x/other' }), 'a different project is still a different run')
})

// The hazard the rejoin would introduce if it were automatic. Concurrent reviews on one machine are
// ordinary here — a second review was observed running against another repo while this work went on
// — and both would be minting their first directory within the window, with no --dir to tell them
// apart. Adopting the neighbour's directory files ONE record describing TWO runs, which is a worse
// corruption than the fragmentation, and it lands on the healthy path rather than the failure path.
test('a concurrent second run does not adopt the first run\'s directory', () => {
  const store = tmpStore()
  const a = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: store, now: new Date('2026-08-02T14:26:15Z') })
  writeCheckpoint(a, 'rust-plan', { branch: 'feat/a', gate: { status: 'pass' } }, { project: store })
  // Minutes later, a second review starts. Its first checkpoint carries no --dir either.
  const b = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: store, now: new Date('2026-08-02T14:31:00Z') })
  assert.notEqual(b, a, 'a run starting fresh must never adopt a live run\'s directory')
  assert.equal(fs.readdirSync(path.join(store, '.partial')).length, 2, 'two runs, two partial directories')
})

// ---- the rejoin, on the path it is actually armed on ----
// The committed concurrency test above never armed the rejoin (`rejoin` defaults to false), so it
// did not exercise the dangerous path at all. These do. The store is machine-global and review.js
// hardcodes kind/name to workflow/review for EVERY repository, so a neighbour's directory is an
// equally valid candidate under a name-only predicate — and finalize then folds it into this run's
// record and deletes it.
test('a rejoin never adopts a neighbouring run against a DIFFERENT repository', () => {
  const store = tmpStore()
  const theirs = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/other', now: new Date('2026-08-02T14:26:15Z') })
  writeCheckpoint(theirs, 'rust-plan', { branch: 'feat/theirs', gate: { status: 'pass' } }, { project: '/repos/other' })
  // Our run's first checkpoint died, so it arms the rejoin. Its directory is by construction the
  // OLDER one whenever the neighbour started later — "newest" would hand us the neighbour's.
  const ours = checkpointDir({ kind: 'workflow', name: 'review' },
    { store, project: '/repos/mine', rejoin: true, now: new Date('2026-08-02T14:31:00Z') })
  assert.notEqual(ours, theirs, 'a directory belonging to another repository is not this run')
  writeCheckpoint(ours, 'rust-lenses', { branch: 'feat/mine' }, { project: '/repos/mine' })
  // …and finalize must not destroy the victim either.
  const res = finalizeRun({ ...RECORD, branch: 'feat/mine' },
    { store, project: '/repos/mine', rejoin: true, now: new Date('2026-08-02T14:40:00Z') })
  assert.equal(res.dir, ours, 'finalize folds OUR directory, located the same way')
  assert.equal(fs.existsSync(theirs), true, 'the neighbour\'s checkpoints are still on disk')
  const rec = JSON.parse(fs.readFileSync(res.file, 'utf8'))
  assert.deepEqual(rec.phases.map(p => p.branch), ['feat/mine'], 'one record, one run')
})

test('a rejoin refuses when two directories are equally good candidates', () => {
  const store = tmpStore()
  for (const at of ['2026-08-02T14:26:15Z', '2026-08-02T14:28:15Z']) {
    const d = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/mine', now: new Date(at) })
    writeCheckpoint(d, 'rust-plan', { branch: 'feat/x' }, { project: '/repos/mine' })
  }
  const mine = checkpointDir({ kind: 'workflow', name: 'review' },
    { store, project: '/repos/mine', rejoin: true, now: new Date('2026-08-02T14:31:00Z') })
  assert.equal(fs.readdirSync(path.join(store, '.partial')).length, 3,
    'ambiguity is answered with a fresh directory — fragmentation is recoverable, a merged record is not')
  assert.equal(readCheckpoints(mine).length, 0)
})

test('a rejoin refuses a same-repo run on another branch, and a future-stamped leftover', () => {
  const store = tmpStore()
  const other = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/mine', now: new Date('2026-08-02T14:26:15Z') })
  writeCheckpoint(other, 'rust-plan', { branch: 'feat/other' }, { project: '/repos/mine' })
  assert.equal(findRejoinableDir({ kind: 'workflow', name: 'review', branch: 'feat/mine' },
    { store, project: '/repos/mine', now: new Date('2026-08-02T14:31:00Z') }), null, 'another branch is another run')

  // Clock skew or a restored store puts a directory in the FUTURE. Math.abs made those adoptable —
  // and, sorting newest-first, made them win.
  const store2 = tmpStore()
  const ahead = checkpointDir({ kind: 'workflow', name: 'review' }, { store: store2, project: '/repos/mine', now: new Date('2026-08-02T15:26:15Z') })
  writeCheckpoint(ahead, 'rust-plan', { branch: 'feat/mine' }, { project: '/repos/mine' })
  assert.equal(findRejoinableDir({ kind: 'workflow', name: 'review', branch: 'feat/mine' },
    { store: store2, project: '/repos/mine', now: new Date('2026-08-02T14:31:00Z') }), null, 'a future-stamped directory is not this run')
})

test('a legacy directory carrying no identity is never adopted', () => {
  const store = tmpStore()
  const legacy = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/mine', now: new Date('2026-08-02T14:26:15Z') })
  writeCheckpoint(legacy, 'rust-plan', { gate: { status: 'pass' } })      // written before identity existed
  assert.equal(findRejoinableDir({ kind: 'workflow', name: 'review' },
    { store, project: '/repos/mine', now: new Date('2026-08-02T14:31:00Z') }), null, 'absence of proof is not proof')
  assert.equal(identityAgrees({ project: '/repos/mine', branch: '', head: '' }, dirIdentity(readCheckpoints(legacy))), false)
})

test('finalize never deletes a directory whose checkpoints disagree with the record', () => {
  const store = tmpStore()
  const theirs = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/other', now: new Date('2026-08-02T14:26:15Z') })
  writeCheckpoint(theirs, 'rust-plan', { branch: 'feat/theirs' }, { project: '/repos/other' })
  const res = finalizeRun({ ...RECORD, branch: 'feat/mine' },
    { store, project: '/repos/mine', rejoin: true, now: new Date('2026-08-02T14:40:00Z') })
  assert.equal(res.folded, 0, 'nothing of another run enters this record')
  assert.equal(fs.existsSync(theirs), true)
  // …and the victim is still recoverable as its own run.
  assert.equal(recoverPartials({ store, project: '/repos/other' }).length, 1)
})

test('the CLI parses --rejoin end to end, for checkpoint and for finalize', () => {
  const store = tmpStore()
  const run = (args, stdin) => execFileSync('node', [SCRIPT, ...args, '--store', store, '--project', store],
    { input: stdin, encoding: 'utf8' })
  // The run's FIRST checkpoint is the one that failed, so nothing threads a --dir anywhere.
  const first = JSON.parse(run(['checkpoint', '--phase', 'lenses', '--rejoin'],
    JSON.stringify({ kind: 'workflow', name: 'review', branch: 'feat/x' })))
  assert.ok(first.runDir, 'the first --rejoin call mints a directory, since there is none to rejoin')
  const second = JSON.parse(run(['checkpoint', '--phase', 'verify', '--rejoin'],
    JSON.stringify({ kind: 'workflow', name: 'review', branch: 'feat/x' })))
  assert.equal(second.runDir, first.runDir, '--rejoin re-enters this run\'s own directory')
  const out = run(['finalize', '--rejoin'], JSON.stringify({ ...RECORD, branch: 'feat/x' }))
  assert.match(out, /folded 2 checkpoint\(s\)/, 'finalize --rejoin finds the same directory')
  assert.equal(fs.existsSync(first.runDir), false, 'and consumes it, leaving no orphan behind')
})

// `--dir` is not proof of ownership. The workflow keeps one `runDir` and assigns it from ANY
// successful checkpoint — including one that used `--rejoin` and adopted a directory — after which
// every later call, finalize included, carries `--dir <adopted>`. Trusting that flag meant the
// identity re-check added for exactly this hazard ran only when no checkpoint ever returned a dir.
test('finalize refuses to fold or delete an explicitly named directory that is not this run', () => {
  const store = tmpStore()
  const now = new Date('2026-08-02T14:26:15Z')
  const theirs = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/theirs', now })
  writeCheckpoint(theirs, 'rust-plan', { branch: 'feat/theirs', head: 'main' }, { project: '/repos/theirs' })

  const out = finalizeRun(
    { schemaVersion: 1, kind: 'workflow', name: 'review', branch: 'feat/mine', head: 'main', verdict: 'Approve' },
    { store, project: '/repos/mine', dir: theirs, now },
  )
  assert.equal(out.folded, 0, "another run's phases must not enter this record")
  assert.equal(out.kept, true)
  assert.ok(fs.existsSync(theirs), 'and the directory it named must survive — deleting it destroys live telemetry')
  assert.deepEqual(fs.readdirSync(theirs).filter(f => /^\d\d-/.test(f)).length, 1)
})

test('finalize still folds and clears a directory that is this run, and a legacy one with no identity', () => {
  // The marker must not fire on the healthy path, and a partial written before identity existed has
  // nothing to compare — refusing it would strand every leftover already in the store.
  const store = tmpStore()
  const now = new Date('2026-08-02T14:26:15Z')
  const mine = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/mine', now })
  writeCheckpoint(mine, 'rust-plan', { branch: 'feat/mine', head: 'main' }, { project: '/repos/mine' })
  const ok = finalizeRun(
    { schemaVersion: 1, kind: 'workflow', name: 'review', branch: 'feat/mine', head: 'main', verdict: 'Approve' },
    { store, project: '/repos/mine', dir: mine, now },
  )
  assert.equal(ok.folded, 1)
  assert.ok(!fs.existsSync(mine))

  const legacy = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/mine', now })
  fs.writeFileSync(path.join(legacy, '00-rust-plan.json'), JSON.stringify({ phase: 'rust-plan' }))
  const old = finalizeRun(
    { schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Approve' },
    { store, project: '/repos/mine', dir: legacy, now },
  )
  assert.equal(old.folded, 1, 'a leftover attesting no identity is still foldable')
})

// `--dir` arrives from a MODEL: the sandboxed workflow cannot reach the filesystem, so the run
// directory round-trips through an agent's structured output and comes back as a string this script
// then `fs.rmSync(recursive, force)`s. A hallucinated or mis-copied path would delete what it names.
test('an out-of-store --dir costs the directory, never the record', () => {
  // `--dir` arrives from a MODEL: the sandboxed workflow cannot reach the filesystem, so the run
  // directory round-trips through an agent's structured output and comes back as a string this script
  // folds and `fs.rmSync(recursive, force)`s. A garbled path must not be obeyed — and must not cost
  // the finished record either, which is what throwing did: the CLI's catch exits before writeRecord.
  const store = tmpStore()
  const outsider = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-not-a-run-'))
  fs.writeFileSync(path.join(outsider, 'keep.txt'), 'precious')

  const out = finalizeRun({ schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Block', findings: { total: 9 } }, { store, dir: outsider })
  assert.equal(out.refusedDir, outsider, 'the refusal must be reportable')
  assert.equal(out.folded, 0)
  assert.ok(fs.existsSync(path.join(outsider, 'keep.txt')), 'the directory it named must survive')
  assert.ok(fs.existsSync(out.file), 'and the record must be on disk — losing it is the defect, not the fix')
  assert.equal(JSON.parse(fs.readFileSync(out.file, 'utf8')).verdict, 'Block')
  fs.rmSync(outsider, { recursive: true, force: true })

  // The store root is not a run directory either.
  assert.equal(finalizeRun({ schemaVersion: 1, kind: 'workflow', name: 'review' }, { store, dir: path.join(store, '.partial') }).refusedDir, path.join(store, '.partial'))

  // A real run directory still folds and clears.
  const real = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/mine' })
  writeCheckpoint(real, 'rust-plan', { branch: 'b', head: 'h' }, { project: '/repos/mine' })
  const ok = finalizeRun({ schemaVersion: 1, kind: 'workflow', name: 'review' }, { store, project: '/repos/mine', dir: real })
  assert.equal(ok.folded, 1)
  assert.equal(ok.refusedDir, '')
})

test('two runs starting in the same second get their own partial directory', () => {
  // stamp() has one-second resolution and mkdirSync(recursive) silently returns an existing dir, so
  // both runs wrote phases into one directory and the first to finalize deleted it under the other.
  // rust-audit dispatches one nested review per changed crate, so this is ordinary, not exotic.
  const store = tmpStore()
  const now = new Date('2026-08-02T14:26:15Z')
  const a = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/a', now })
  const b = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/b', now })
  assert.notEqual(a, b, 'a second run must not be handed the first run\'s directory')
  assert.equal(fs.readdirSync(path.join(store, '.partial')).length, 2)
  // The name keeps its exact shape, so recover still parses both — an empty directory attests to no
  // run and is skipped, so each gets a phase first.
  writeCheckpoint(a, 'rust-plan', { branch: 'feat/a', head: 'main' }, { project: '/repos/a' })
  writeCheckpoint(b, 'rust-plan', { branch: 'feat/b', head: 'main' }, { project: '/repos/b' })
  const recovered = recoverPartials({ store, project: '/repos/b' })
  assert.equal(recovered.length, 2, 'two interrupted runs, two records — not one swallowing the other')
})

test('two records finishing in the same second do not overwrite each other', () => {
  // stamp() has one-second resolution, so the second write silently replaced the first — one record
  // gone, and index.jsonl then carrying two lines pointing at one file.
  const store = tmpStore()
  const now = new Date('2026-08-02T14:26:15Z')
  const a = writeRecord({ schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Approve' }, { store, project: '/repos/a', now })
  const b = writeRecord({ schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Block' }, { store, project: '/repos/b', now })
  assert.notEqual(a.file, b.file, 'a second record must not be written over the first')
  assert.equal(JSON.parse(fs.readFileSync(a.file, 'utf8')).verdict, 'Approve')
  assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf8')).verdict, 'Block')
  // The name and the contents must agree, or a reader keyed by either one disagrees with the other.
  assert.ok(path.basename(b.file).startsWith(JSON.parse(fs.readFileSync(b.file, 'utf8')).ts))
  const index = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n')
  assert.equal(index.length, 2)
})

test('an unreadable run directory costs the fold, never the record', () => {
  const store = tmpStore()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/mine' })
  writeCheckpoint(dir, 'rust-plan', { branch: 'b', head: 'h' }, { project: '/repos/mine' })
  fs.chmodSync(dir, 0o000)
  try {
    const out = finalizeRun({ schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Block' }, { store, project: '/repos/mine', dir })
    assert.ok(fs.existsSync(out.file), 'the record must be on disk')
    assert.equal(JSON.parse(fs.readFileSync(out.file, 'utf8')).verdict, 'Block')
    assert.ok(out.unreadable, 'and the failure to read the leftovers must be reportable')
  } finally {
    fs.chmodSync(dir, 0o700)
  }
})
