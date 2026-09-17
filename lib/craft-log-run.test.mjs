// The store is only worth having if a record on disk means what it says. These tests pin the three
// failure modes that actually happened: a record that lands truncated and looks complete, a run that
// dies before it writes anything at all, and a reconstruction that quietly claims candidate findings
// were confirmed ones.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  stamp, recordFilename, computedFields, writeRecord, checkpointDir, writeCheckpoint,
  readCheckpoints, recoverPartials, classifyResult, recordFromJournal, runtimeStats,
  backfillEngineRevision, normalizeStampBoundary, repairIndex, compactPrettyBlock, readJsonlCounted,
  indexKey, describeBlock, blockFields, findRejoinableDir, finalizeRun, dirIdentity, identityAgrees,
  findingsFromJournal, findPriorRound, parseIndividualVerifyTarget, parseBatchVerifyTargets, repoKey,
  gitIdentity, applyGitIdentity,
} from './craft-log-run.mjs'
import { ENGINE_REVISION } from './run-record.mjs'
import { slugifyProjectPath } from './journal-link.mjs'
import { sanitizeAttack, ATTACK_MAX } from './review-adjudicate.mjs'

const SCRIPT = fileURLToPath(new URL('./craft-log-run.mjs', import.meta.url))

const PARTIAL = '.partial'

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

// `payload` is the JSON a logger AGENT copies into a heredoc — the model-mediated channel this
// file's header documents as having silently corrupted data before. A `session`/`project` key
// INSIDE the payload must never be able to shadow the shell-expanded `identity` this function was
// given — that is the whole point of the identity being shell-expanded rather than model-composed.
test('writeCheckpoint: a session/project key inside the payload cannot override the shell-provided identity', () => {
  const store = tmpStore()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: store, now: new Date('2026-08-02T14:26:15Z') })
  const file = writeCheckpoint(dir, 'rust-plan',
    { branch: 'feat/x', session: 'attacker-session', project: '/not/the/real/repo' },
    { project: store, session: 'real-session' })
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.session, 'real-session', 'the shell-expanded session must win over a payload-supplied one')
  assert.equal(written.project, store, 'the shell-expanded project must win over a payload-supplied one')
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

  const out = recoverPartials({ store, project: store, claudeHome: tmpStore() })
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
  assert.deepEqual(recoverPartials({ store, project: store, claudeHome: tmpStore() }), [])
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

  const out = recoverPartials({ store, project: store, claudeHome: tmpStore() })
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
  assert.deepEqual(recoverPartials({ store, project: store, claudeHome: tmpStore() }), [], 'a finalized run is not resurrected as a partial one')

  // …and the same holds when the removal itself failed and the directory survived: the marker, not
  // the absence of the directory, is what says "already finalized".
  const kept = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: store, now })
  writeCheckpoint(kept, 'rust-plan', { gate: { status: 'pass' } }, { project: store })
  fs.writeFileSync(path.join(kept, '.finalized'), 'x\n')
  assert.deepEqual(recoverPartials({ store, project: store, claudeHome: tmpStore() }), [], 'a marked directory is not recovered')
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

// The verify/verify-batch `result` entry carries no finding identity of its own (no fingerprint, no
// label) — only `agentId`. The identity survives in the verifier's OWN transcript, which the harness
// persists alongside the journal as agent-<agentId>.jsonl; its first user message is the verify
// prompt, which embeds "FINDING: [severity] title\n  at file:line" (individual) or repeating
// "--- FINDING <i> ---\n[severity] title\n  at file:line" blocks (batch). findingsFromJournal must
// recover that link and drop a finding the dead run's own verification refuted.
function fakeAgentTranscript(dir, agentId, userText) {
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`),
    JSON.stringify({ type: 'user', message: { role: 'user', content: userText } }) + '\n')
}

test('findingsFromJournal drops a finding the dead run\'s own verification refuted', () => {
  const dir = tmpStore()
  const finding = { severity: 'High', title: 'unwrap panics', file: 'a.rs', line: 1, why: 'w', source: 'safety' }
  fakeJournal(dir, [
    { type: 'result', agentId: 'lens1', result: { lens: 'safety', findings: [finding] } },
    { type: 'result', agentId: 'verifier1', result: { refuted: true, citedLineMatches: true, reachable: true, premiseSupported: true } },
  ])
  fakeAgentTranscript(dir, 'verifier1',
    'You are skeptic #1 trying to REFUTE a code review finding.\n\nFINDING: [High] unwrap panics\n  at a.rs:1\n  why: w\n  source: safety\n\nReturn {refuted, citedLineMatches, reachable, premiseSupported, reason}.')
  const findings = findingsFromJournal(dir)
  assert.deepEqual(findings, [], 'a refuted finding must not come back as an ordinary open candidate')
})

test('findingsFromJournal carries a verify-batch refutation forward too, by index into the batch prompt', () => {
  const dir = tmpStore()
  const finding = { severity: 'Medium', title: 'unused import', file: 'b.rs', line: 5, why: 'w', source: 'idioms' }
  fakeJournal(dir, [
    { type: 'result', agentId: 'lens1', result: { lens: 'idioms', findings: [finding] } },
    { type: 'result', agentId: 'batch1', result: { verdicts: [{ index: 0, refuted: true, citedLineMatches: true, reachable: true, premiseSupported: true }] } },
  ])
  fakeAgentTranscript(dir, 'batch1',
    '--- FINDING 0 ---\n[Medium] unused import\n  at b.rs:5\n  why: w\n  source: idioms\n\nReturn {verdicts: [...]}.')
  const findings = findingsFromJournal(dir)
  assert.deepEqual(findings, [], 'a batch-refuted finding must be excluded too')
})

test('findingsFromJournal carries an upheld finding forward as suspected, honestly labelled, not silently confirmed', () => {
  const dir = tmpStore()
  const finding = { severity: 'High', title: 'unwrap panics', file: 'a.rs', line: 1, why: 'w', source: 'safety' }
  fakeJournal(dir, [
    { type: 'result', agentId: 'lens1', result: { lens: 'safety', findings: [finding] } },
    { type: 'result', agentId: 'verifier1', result: { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true } },
  ])
  fakeAgentTranscript(dir, 'verifier1',
    'You are skeptic #1 trying to REFUTE a code review finding.\n\nFINDING: [High] unwrap panics\n  at a.rs:1\n  why: w\n  source: safety\n\nReturn {refuted, citedLineMatches, reachable, premiseSupported, reason}.')
  const findings = findingsFromJournal(dir)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].tier, 'suspected', 'not "confirmed" — one recovered vote is not the full adversarial panel')
  assert.match(findings[0].why, /upheld/, 'the honest reason must say the dead run itself upheld it')
})

// Falsifier for the branch's defect #4: the OLD rule compared `refuted > upheld` directly, so a
// 3-vote panel that split 1 refuted / 2 upheld (refuted(1) > upheld... no, 1 is NOT > 2 either —
// the actually dangerous split is 1 refuted / 0 upheld with a THIRD vote that never linked at all,
// leaving {refuted:1, upheld:0} even though the panel was really 1/2. tierFromVotes compares against
// the PANEL SIZE it actually collected (v.length, i.e. refuted+upheld here), not against upheld
// alone: refutes must be a STRICT MAJORITY of refuted+upheld to disconfirm. This drives three votes
// through individually (one refuted, two upheld) and asserts the finding survives as suspected.
// The literal dangerous scenario from the branch's defect #4: a 3-vote panel really went 1 refuted /
// 2 upheld, but only the refuted voter's transcript survived (agent-<id>.jsonl renamed/moved/never
// written for the other two) — findingsFromJournal recovers a tally of {refuted:1, upheld:0} for
// this finding alone. The OLD rule (`refuted > upheld`, 1 > 0) dropped it outright: a real defect
// vanishing because two OTHER transcripts were unreadable. The fix demotes instead of dropping
// whenever the journal shows unlinked verify verdicts anywhere (panel size cannot be vouched for).
test('findingsFromJournal keeps (demoted) a finding whose tally looks refuted-majority but the journal has unlinked votes elsewhere', () => {
  const dir = tmpStore()
  const finding = { severity: 'High', title: 'unwrap panics', file: 'a.rs', line: 1, why: 'w', source: 'safety' }
  const verifyPrompt = 'You are skeptic trying to REFUTE a code review finding.\n\nFINDING: [High] unwrap panics\n  at a.rs:1\n  why: w\n  source: safety\n\nReturn {refuted, citedLineMatches, reachable, premiseSupported, reason}.'
  fakeJournal(dir, [
    { type: 'result', agentId: 'lens1', result: { lens: 'safety', findings: [finding] } },
    { type: 'result', agentId: 'v1', result: { refuted: true, citedLineMatches: true, reachable: true, premiseSupported: true } },
    // v2 and v3 upheld this finding but their transcripts never made it to disk — exactly what a
    // renamed/moved agent-<id>.jsonl looks like from this reader's side.
    { type: 'result', agentId: 'v2', result: { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true } },
    { type: 'result', agentId: 'v3', result: { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true } },
  ])
  fakeAgentTranscript(dir, 'v1', verifyPrompt) // only v1's transcript survives
  const findings = findingsFromJournal(dir)
  assert.equal(findings.length, 1, 'a tally of {refuted:1, upheld:0} must not disconfirm this finding when the journal has unlinked votes elsewhere')
  assert.equal(findings[0].tier, 'suspected')
  assert.match(findings[0].why, /demoted, not dropped/)
})

test('findingsFromJournal keeps a finding a 3-vote panel split 1 refuted / 2 upheld — not a majority against it', () => {
  const dir = tmpStore()
  const finding = { severity: 'High', title: 'unwrap panics', file: 'a.rs', line: 1, why: 'w', source: 'safety' }
  const verifyPrompt = 'You are skeptic trying to REFUTE a code review finding.\n\nFINDING: [High] unwrap panics\n  at a.rs:1\n  why: w\n  source: safety\n\nReturn {refuted, citedLineMatches, reachable, premiseSupported, reason}.'
  fakeJournal(dir, [
    { type: 'result', agentId: 'lens1', result: { lens: 'safety', findings: [finding] } },
    { type: 'result', agentId: 'v1', result: { refuted: true, citedLineMatches: true, reachable: true, premiseSupported: true } },
    { type: 'result', agentId: 'v2', result: { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true } },
    { type: 'result', agentId: 'v3', result: { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true } },
  ])
  fakeAgentTranscript(dir, 'v1', verifyPrompt)
  fakeAgentTranscript(dir, 'v2', verifyPrompt)
  fakeAgentTranscript(dir, 'v3', verifyPrompt)
  const findings = findingsFromJournal(dir)
  assert.equal(findings.length, 1, '1 refuted out of 3 is not a majority — the finding must survive')
  assert.equal(findings[0].tier, 'suspected')
})

test('findingsFromJournal leaves a finding untouched when no verify entry names it', () => {
  const dir = tmpStore()
  const finding = { severity: 'Low', title: 'style nit', file: 'c.rs', line: 9, why: 'w', source: 'idioms' }
  fakeJournal(dir, [{ type: 'result', agentId: 'lens1', result: { lens: 'idioms', findings: [finding] } }])
  const findings = findingsFromJournal(dir)
  // dedupJournalFindings tags every survivor with its contributing `sources`, even a singleton.
  assert.deepEqual(findings, [{ ...finding, sources: ['idioms'] }])
})

// The journal holds RAW per-lens/per-gate output across every internal round with no dedup at all —
// unlike the live engine, which dedups its own pool (dedupPool in review.js) before persisting a
// ledger. Two lenses reporting the same defect (same file, same title, same word-set order) must
// collapse to ONE candidate, or each duplicate costs one adjudicator agent downstream (plus a
// red-team pass on High/Critical). fingerprint() (lib/run-record.mjs) is line-TOLERANT — its basis
// is file+symbol+ruleId+title-shingle, not the line number — so a one-line-off citation from a
// second lens still collapses; exercised here by giving the two duplicates different line numbers.
test('findingsFromJournal collapses the same defect reported by two lenses into one candidate', () => {
  const dir = tmpStore()
  fakeJournal(dir, [
    { type: 'result', agentId: 'a1', result: { lens: 'safety', findings: [
      { severity: 'High', title: 'unwrap panics on empty input', file: 'a.rs', line: 10, why: 'w1', source: 'safety' },
    ] } },
    { type: 'result', agentId: 'a2', result: { lens: 'idioms', findings: [
      // Same defect, same title, one line off — a fresh lens citing the same spot.
      { severity: 'Medium', title: 'unwrap panics on empty input', file: 'a.rs', line: 11, why: 'w2', source: 'idioms' },
    ] } },
  ])
  const findings = findingsFromJournal(dir)
  assert.equal(findings.length, 1, 'two lenses reporting the same defect must collapse to one candidate')
  assert.deepEqual(new Set(findings[0].sources), new Set(['safety', 'idioms']), 'both contributing sources are carried')
  assert.equal(findings[0].severity, 'High', 'the higher-severity member wins as the base')
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

// `repoKey` used to key a linked worktree's runs to the WORKTREE's own toplevel, a different string
// from the main checkout's — measured live in ~/.craft/runs, rows keyed to
// `.../.claude/worktrees/agent-...` and `.../scratchpad/wt-1254`, neither reachable from the main
// checkout `findPriorRound` searches under. `--git-common-dir` is the fix: it names the ONE `.git` a
// worktree and its main checkout share, so both collapse onto the same key.
test('repoKey collapses a linked worktree onto its main checkout, not the worktree\'s own toplevel', () => {
  const main = tmpStore()
  execFileSync('git', ['init', '-q', main])
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main })
  const wt = path.join(tmpStore(), 'wt')
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, 'HEAD'], { cwd: main })
  try {
    assert.equal(repoKey(wt), repoKey(main), 'the worktree and the main checkout must resolve to the same project key')
    assert.equal(repoKey(main), fs.realpathSync(main), 'and it is the main checkout\'s own (real, symlink-resolved) toplevel')
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: main })
  }
})

// "parent of the common dir" is wrong for a submodule: its common dir is
// `<super>/.git/modules/<name>`, whose parent (`.../modules`) is neither a work tree nor unique per
// submodule — every submodule of one superproject would collapse onto that ONE key. Built with real
// git (submodule added from a local path) rather than reasoned about.
test('repoKey gives a submodule its own key, distinct from its superproject and from a sibling submodule', () => {
  const super_ = tmpStore()
  execFileSync('git', ['init', '-q', super_])
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: super_ })
  const libRepo = tmpStore()
  execFileSync('git', ['init', '-q', libRepo])
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: libRepo })
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.email=t@t', '-c', 'user.name=t',
    'submodule', 'add', '-q', libRepo, 'sub'], { cwd: super_ })
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.email=t@t', '-c', 'user.name=t',
    'submodule', 'add', '-q', libRepo, 'sub2'], { cwd: super_ })
  const subKey = repoKey(path.join(super_, 'sub'))
  const sub2Key = repoKey(path.join(super_, 'sub2'))
  const superKey = repoKey(super_)
  assert.notEqual(subKey, superKey, 'a submodule must not collapse onto its superproject\'s key')
  assert.notEqual(subKey, sub2Key, 'two submodules of the same superproject must not collapse onto each other')
  assert.equal(subKey, fs.realpathSync(path.join(super_, 'sub')), 'the submodule keys to its own work tree')
})

// A bare repo has no work tree, so `--show-toplevel` fails — but its common dir is `bare.git` itself,
// not a `.git` subdirectory, so the "parent of `.git`" shortcut must not fire (that would collapse
// every bare repo beside another the same way). Built with a real bare clone.
test('repoKey keys a bare repo to itself, distinct from a sibling bare repo', () => {
  const root = tmpStore()
  const src = path.join(root, 'src')
  execFileSync('git', ['init', '-q', src])
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: src })
  const bareA = path.join(root, 'a.git')
  const bareB = path.join(root, 'b.git')
  execFileSync('git', ['clone', '-q', '--bare', src, bareA])
  execFileSync('git', ['clone', '-q', '--bare', src, bareB])
  const keyA = repoKey(bareA)
  const keyB = repoKey(bareB)
  assert.notEqual(keyA, keyB, 'two distinct bare repos must not collapse onto one key')
  assert.equal(keyA, fs.realpathSync(bareA), 'a bare repo keys to itself')
})

// git < 2.31 has no `--path-format` flag; `git rev-parse` on those versions ECHOES an unrecognised
// flag to stdout and exits 0 rather than failing — `--git-common-dir` output on such a checkout is a
// two-line string whose `dirname` is `.`. Simulated with a fake `git` shim so this is exercised without
// depending on an old git binary being installed; falsified by removing the shape-guard from `repoKey`.
test('repoKey ignores an echoed-unknown-flag response and falls back to --show-toplevel', () => {
  const real = tmpStore()
  execFileSync('git', ['init', '-q', real])
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: real })
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const binDir = tmpStore()
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh
if [ "$3" = "--git-common-dir" ]; then
  echo "--path-format=absolute"
  echo ".git"
  exit 0
fi
exec ${realGit} "$@"
`, { mode: 0o755 })
  const prevPath = process.env.PATH
  process.env.PATH = `${binDir}:${prevPath}`
  try {
    assert.equal(repoKey(real), fs.realpathSync(real), 'must resolve via --show-toplevel, not "." from the echoed flag')
  } finally {
    process.env.PATH = prevPath
  }
})

// The blocking hole this closes: `findJournalForRun`'s project-slug fallback matches on uniqueness,
// which a NEIGHBOURING run's journal satisfies exactly when the run under recovery's own journal is
// missing — the measured common case. A KNOWN session id that misses is positive evidence the run's
// journal is not findable this way at all, so it must be a FINAL answer, not a reason to fall through
// to that same unreliable fallback. This plants a neighbour's journal (agreeing branch and all) under
// the project slug and proves it is never adopted when the run's own (known, valid) session id comes
// up empty.
test('recoverPartials: a known session id that finds no journal is a final miss, not a fallback to a neighbour\'s journal', () => {
  const store = tmpStore()
  const claudeHome = tmpStore()
  const project = store
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date() })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head: 'origin/main' }, { project, session: 'sess-known' })
  // A neighbouring run's journal, filed under the same project slug but a DIFFERENT session, with a
  // branch that agrees — exactly the candidate the project-slug fallback would (wrongly) adopt.
  const slug = slugifyProjectPath(path.resolve(project))
  const wfDir = path.join(claudeHome, 'projects', slug, 'sess-other', 'subagents', 'workflows', 'wf1')
  fs.mkdirSync(wfDir, { recursive: true })
  fs.writeFileSync(path.join(wfDir, 'journal.jsonl'), JSON.stringify({
    type: 'result', result: { baseRef: 'origin/main', branch: 'feat/x', head: 'cafefeed', files: ['a.txt'] },
  }) + '\n')
  const out = recoverPartials({ store, project, claudeHome })
  assert.equal(out.length, 1)
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.equal(rec.ledgerSource, undefined, 'a known session id that missed must not resurrect a neighbouring journal via the project-slug fallback')
  assert.equal(rec.partialReason, 'run ended before it could write a final record — reconstructed from phase checkpoints (journal not used: session-miss)')
})

test('a recovered dead run is attributed too — an outage record is still an engine record', () => {
  const store = tmpStore()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store })
  writeCheckpoint(dir, 'scout', { verdict: 'Block' })
  const [out] = recoverPartials({ store, claudeHome: tmpStore() })
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

// The primary scenario this branch exists for: a run stalls, the human resumes work in a NEW
// harness session, and the second checkpoint lands under a different $CLAUDE_CODE_SESSION_ID in the
// SAME .partial directory. `session` is recorded on dirIdentity but must play no part in
// identityAgrees — comparing it would poison dirIdentity's session field to null the moment the two
// checkpoints disagreed, and the rejoin would refuse forever.
test('a directory whose checkpoints carry two different session ids still rejoins and folds', () => {
  const store = tmpStore()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/repos/mine', now: new Date('2026-08-02T14:26:15Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/mine', head: 'main' }, { project: '/repos/mine', session: 'session-A' })
  // The harness session changed; the workflow's own runDir survives (it was returned from the first
  // checkpoint and threaded through), so this checkpoint still targets `dir` directly rather than
  // going through the rejoin search — exactly what a `--dir <dir>` call from the resumed workflow
  // would do.
  writeCheckpoint(dir, 'rust-lenses', { branch: 'feat/mine', head: 'main' }, { project: '/repos/mine', session: 'session-B' })

  const identity = dirIdentity(readCheckpoints(dir))
  assert.equal(identity.session, null, 'two disagreeing session ids poison the merged field, as documented')

  // Now simulate the case identityAgrees actually has to answer: the FIRST checkpoint of THIS run
  // failed to return a runDir (so this call has no --dir) and the workflow resumed in session-B,
  // asking the rejoin to find its own already-started directory.
  const found = findRejoinableDir({ kind: 'workflow', name: 'review', branch: 'feat/mine', head: 'main' },
    { store, project: '/repos/mine', now: new Date('2026-08-02T14:31:00Z') })
  assert.equal(found, dir, 'a resumed run in a new session must still rejoin its own directory')

  const res = finalizeRun({ ...RECORD, branch: 'feat/mine', head: 'main' },
    { store, project: '/repos/mine', rejoin: true, now: new Date('2026-08-02T14:40:00Z') })
  assert.equal(res.dir, dir, 'finalize locates the same directory')
  assert.equal(res.folded, 2, 'both checkpoints — from both sessions — are folded into one record')
  assert.equal(fs.existsSync(dir), false, 'the directory is cleaned up, not orphaned')
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
  assert.equal(recoverPartials({ store, project: '/repos/other', claudeHome: tmpStore() }).length, 1)
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
  const recovered = recoverPartials({ store, project: '/repos/b', claudeHome: tmpStore() })
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

test('writeRecord claims the filename exclusively, not by probing first', () => {
  // The concurrent test below exercises the real thing, but a race is a race: reverting `wx` to an
  // existsSync probe makes it fail most runs, not every run, so on its own it would let a revert
  // through about a third of the time. This one is deterministic and pins the mechanism instead of
  // the symptom — an O_EXCL create is the only way two processes cannot both believe they won.
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const body = src.slice(src.indexOf('export function writeRecord'), src.indexOf('// ---- checkpoints'))
  assert.match(body, /flag: 'wx'/, 'the record write must be exclusive')
  assert.ok(!/fs\.existsSync\(file\)/.test(body), 'and must not decide the name by probing for it first')
})

test('concurrent writers each keep their record — the name is claimed, not probed', async () => {
  // The sequential test above passes against a check-then-write implementation too: existsSync sees
  // the first file and the second write steps the stamp. The loss only appears when two processes
  // pass the probe before either writes — which is exactly what rust-audit's per-crate fan-out and
  // review.js's fixed kind+name put in flight. So: real processes, one store, one frozen `now`.
  const store = tmpStore()
  const writers = 'abcdefghijkl'.split('')
  const each = 1
  // Two things make the collision reliable rather than lucky: every child does its module loading
  // BEFORE it is allowed to write, then spins on a start file the parent drops — so the writes are
  // released together instead of staggered by twelve interpreter startups.
  const src = `
    import fs from 'node:fs'
    import { writeRecord } from ${JSON.stringify(SCRIPT)}
    const [store, who, gate, each] = process.argv.slice(2)
    while (!fs.existsSync(gate)) {}
    for (let i = 0; i < Number(each); i++) {
      writeRecord({ schemaVersion: 1, kind: 'workflow', name: 'review', verdict: who + ':' + i },
        { store, project: '/repos/' + who, now: new Date('2026-08-02T14:26:15Z') })
    }
  `
  const runner = path.join(store, 'writer.mjs')
  fs.writeFileSync(runner, src)
  // All five are started before any is awaited: that overlap is the whole point of the test.
  const gate = path.join(store, 'go')
  const kids = writers.map(who => spawn(process.execPath, [runner, store, who, gate, String(each)], { stdio: 'ignore' }))
  await new Promise(r => setTimeout(r, 300))
  fs.writeFileSync(gate, '')
  const codes = await Promise.all(kids.map(k => new Promise(res => k.on('exit', res))))
  assert.deepEqual(codes, writers.map(() => 0), 'every writer must exit clean')

  const want = writers.length * each
  const files = fs.readdirSync(store).filter(f => f.endsWith('.json') && f !== 'writer.mjs')
  assert.equal(files.length, want, 'one record per write — a lost record is a lost run')
  const verdicts = files.map(f => JSON.parse(fs.readFileSync(path.join(store, f), 'utf8')).verdict).sort()
  const expected = writers.flatMap(who => Array.from({ length: each }, (_, i) => `${who}:${i}`)).sort()
  assert.deepEqual(verdicts, expected, 'and every writer\'s own records, not copies of one')
  const index = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n')
  assert.equal(index.length, want)
  // The index must point at files that exist: two lines naming one file is the shape the loss took.
  const named = new Set(index.map(l => path.basename(JSON.parse(l).file ?? '')))
  if (named.size && !named.has('')) assert.equal(named.size, want, 'no two index lines may name one file')
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

test('a run directory that could not be READ is kept, not deleted', () => {
  // `mine` short-circuits to true when phases is empty, and a failed read yields exactly that — so
  // the destructive path ran on the strength of a read that never happened. readCheckpoints swallows
  // per-file errors, so the only way to fail it is to fail the ENUMERATION: a --dir naming a FILE
  // throws ENOTDIR there while rmSync deletes it happily. That is the shape the guard is for — the
  // comment promises the fold is merely deferred to `recover`, and deleting the leftover makes it a
  // lie.
  const store = tmpStore()
  const target = path.join(store, PARTIAL, 'not-a-directory')
  fs.mkdirSync(path.join(store, PARTIAL), { recursive: true })
  fs.writeFileSync(target, 'leftover the reader could not enumerate\n')
  const out = finalizeRun({ schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Block' }, { store, project: '/repos/mine', dir: target })
  assert.ok(fs.existsSync(out.file), 'the record still lands')
  assert.ok(out.unreadable, 'the failed read must be reported')
  assert.ok(fs.existsSync(target), 'and what could not be read must survive for recover')
})

test('the ENOENT recreate is bounded, so a vanishing .partial cannot spin forever', () => {
  // The bug this replaced did `bump -= 1; continue`, which returns to the same stamp: while the
  // ENOENT persisted the loop never advanced and never reached the 60 bound. It span until the
  // harness killed the logger's shell. The bound is what makes it a reported miss instead of a hang.
  const body = fs.readFileSync(SCRIPT, 'utf8')
  const loop = body.slice(body.indexOf('let remakes = 0'), body.indexOf('// `project` is written into EVERY checkpoint'))
  assert.match(loop, /remakes\+\+ < \d/, 'the recreate must be counted against a bound')
  assert.ok(!/code === 'ENOENT'\) \{/.test(loop), 'and must not be an unconditional recreate')
})

// ---- journal-linked recovery (recoverPartials reconnecting to journal.jsonl) ------------------
function plantWorkflowJournal(claudeHome, project, entries, { session = 's1', wf = 'wf1' } = {}) {
  const slug = slugifyProjectPath(path.resolve(project))
  const dir = path.join(claudeHome, 'projects', slug, session, 'subagents', 'workflows', wf)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'journal.jsonl')
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return file
}

test('a stalled run WITH a matching journal recovers a real ledger, ledgerSource journal, and findings from the journal', () => {
  const store = tmpStore()
  const claudeHome = tmpStore()
  const project = tmpStore()
  const now = new Date()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now })
  // The checkpoint's own findings total (1) must NOT be what the recovered record reports once a
  // journal is found — the summary has to come from the journal's findings (2), not the checkpoint.
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head: 'abc1234', gate: { status: 'pass' } }, { project })
  writeCheckpoint(dir, 'rust-lenses', { ranLenses: ['safety'], findings: { total: 1, bySeverity: { Critical: 0, High: 1, Medium: 0, Low: 0, Info: 0 } } }, { project })
  const hi = (source, title) => ({ severity: 'High', title, file: 'a.rs', line: 1, why: 'w', source })
  plantWorkflowJournal(claudeHome, project, [
    { type: 'result', result: { baseRef: 'origin/main', branch: 'feat/x', head: 'deadbeef', files: ['a.rs'] } },
    { type: 'result', agentId: 'a1', result: { lens: 'safety', findings: [hi('safety', 'unwrap panics')] } },
    { type: 'result', agentId: 'a2', result: { status: 'pass', seedFindings: [hi('clippy', 'seed defect')] } },
  ])

  const out = recoverPartials({ store, project, now: new Date(now.getTime() + 1000), claudeHome })
  assert.equal(out.length, 1)
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.equal(rec.partial, true)
  assert.equal(rec.ledgerSource, 'journal')
  assert.equal(Array.isArray(rec.ledger), true)
  assert.equal(rec.ledger.length, 2, 'a real per-finding ledger, not checkpoint counts')
  assert.equal(rec.findings.total, 2, 'the findings summary is computed from the journal, not the checkpoint (which said 1)')
})

// The motivating scenario from the live measurement: 27 of 49 stalled runs executed inside a
// throwaway agent worktree while the harness recorded the session under the REAL repo's slug — the
// checkpoint's `project` and the journal's own directory then name DIFFERENT paths, and the
// project-slug+time search (used when no session id is known) cannot find it. With a session id on
// the checkpoint, the lookup no longer depends on the project string matching at all.
test('a stalled run recovers its journal via session id even when the checkpoint project and the journal directory disagree (the worktree case)', () => {
  const store = tmpStore()
  const claudeHome = tmpStore()
  const project = tmpStore()          // the checkpoint's own `project` (the "real repo" path)
  const worktreePath = tmpStore()     // where the journal actually got written (a throwaway worktree)
  const now = new Date()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head: 'abc1234' }, { project, session: 'aaaaaaaa-0000-4000-8000-000000000001' })
  const hi = (source, title) => ({ severity: 'High', title, file: 'a.rs', line: 1, why: 'w', source })
  plantWorkflowJournal(claudeHome, worktreePath, [
    { type: 'result', result: { baseRef: 'origin/main', branch: 'feat/x', head: 'deadbeef', files: ['a.rs'] } },
    { type: 'result', agentId: 'a1', result: { lens: 'safety', findings: [hi('safety', 'unwrap panics')] } },
  ], { session: 'aaaaaaaa-0000-4000-8000-000000000001' })

  const out = recoverPartials({ store, project, now: new Date(now.getTime() + 1000), claudeHome })
  assert.equal(out.length, 1)
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.equal(rec.session, 'aaaaaaaa-0000-4000-8000-000000000001', 'the session id is carried from the checkpoint onto the recovered record')
  assert.equal(rec.ledgerSource, 'journal', 'found via the session id despite the project mismatch')
  assert.equal(rec.ledger.length, 1)
})

// A checkpoint that never carried a session id (every run written before this field existed, or one
// where $CLAUDE_CODE_SESSION_ID was unset) must degrade to the old project-slug+time search rather
// than fail the lookup outright.
test('a stalled run with no session id on its checkpoint still recovers via the project-slug fallback', () => {
  const store = tmpStore()
  const claudeHome = tmpStore()
  const project = tmpStore()
  const now = new Date()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head: 'abc1234' }, { project }) // no session
  const hi = (source, title) => ({ severity: 'High', title, file: 'a.rs', line: 1, why: 'w', source })
  plantWorkflowJournal(claudeHome, project, [
    { type: 'result', result: { baseRef: 'origin/main', branch: 'feat/x', head: 'deadbeef', files: ['a.rs'] } },
    { type: 'result', agentId: 'a1', result: { lens: 'safety', findings: [hi('safety', 'unwrap panics')] } },
  ])

  const out = recoverPartials({ store, project, now: new Date(now.getTime() + 1000), claudeHome })
  assert.equal(out.length, 1)
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.equal(rec.session, null, 'no session id was recorded — degrades to absent, not the empty string')
  assert.equal(rec.ledgerSource, 'journal', 'still found through the project-slug+time fallback')
})

// The resumed-run scenario end to end: a run stalls, is resumed in a NEW harness session, and its
// second checkpoint lands under a DIFFERENT session id in the same `.partial` directory —
// `dirIdentity(phases).session` poisons to `null` (pinned separately above). Before this fix,
// `recoverPartials` turned that poisoned value into "no session id" and fell back to the
// project-slug+time path, which finds nothing when the journal lives under a worktree slug the
// checkpoint's `project` does not match (the same mismatch the single-session test above covers).
// `dirSessionIds` recovers the set instead, and only one of the two ids actually has a journal.
test('a stalled run resumed under a SECOND session id still recovers its journal, trying each id it saw', () => {
  const store = tmpStore()
  const claudeHome = tmpStore()
  const project = tmpStore()          // the checkpoint's own `project`
  const worktreePath = tmpStore()     // where the journal actually got written (a throwaway worktree)
  const now = new Date()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head: 'abc1234' }, { project, session: 'session-A' })
  writeCheckpoint(dir, 'rust-lenses', { ranLenses: ['safety'] }, { project, session: 'session-B' })
  assert.equal(dirIdentity(readCheckpoints(dir)).session, null, 'the two checkpoints disagree — session is poisoned, as documented')

  const hi = (source, title) => ({ severity: 'High', title, file: 'a.rs', line: 1, why: 'w', source })
  // Only session-B (the one the resumed harness actually used to run the workflow) has a journal —
  // and it lives under a DIFFERENT project path (the worktree case), so the project-slug fallback
  // the poisoned-session code path used to take cannot find it either: only trying session-B by id
  // succeeds.
  plantWorkflowJournal(claudeHome, worktreePath, [
    { type: 'result', result: { baseRef: 'origin/main', branch: 'feat/x', head: 'deadbeef', files: ['a.rs'] } },
    { type: 'result', agentId: 'a1', result: { lens: 'safety', findings: [hi('safety', 'unwrap panics')] } },
  ], { session: 'session-B' })

  const out = recoverPartials({ store, project, now: new Date(now.getTime() + 1000), claudeHome })
  assert.equal(out.length, 1)
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.equal(rec.ledgerSource, 'journal', 'found by trying session-B after session-A yielded nothing')
  assert.equal(rec.ledger.length, 1)
})

// The sweep-wide default `project` (recoverPartials's own parameter) must never override a
// directory's OWN identity: `recover` promotes every unfinalized directory in one pass, and those
// can belong to different repositories than whichever one the sweep happened to be invoked with.
test('a recovered record is filed under the DIRECTORY\'s own project, not the sweep\'s default', () => {
  const store = tmpStore()
  const claudeHome = tmpStore()
  const theirs = tmpStore() // the directory's own, real repository
  const now = new Date()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: theirs, now })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head: 'abc1234' }, { project: theirs })

  // The sweep is invoked with a DIFFERENT default project (as `recover` does scanning the whole
  // store in one pass) — the wrong one must not end up on the record.
  const wrongDefault = tmpStore()
  const out = recoverPartials({ store, project: wrongDefault, now: new Date(now.getTime() + 1000), claudeHome })
  assert.equal(out.length, 1)
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.equal(rec.project, theirs, 'filed under the directory\'s own project, not the sweep default')
  assert.notEqual(rec.project, wrongDefault)
})

// Falsifies the silent-revert this branch fixed: a journal that recorded a verify verdict but whose
// agent-<id>.jsonl transcript is missing (renamed/moved by the harness, or never written) used to
// come back from `findingsFromJournal` as an unfiltered candidate list — indistinguishable from a
// genuinely unverified one — and `recoverPartials` handed it out as `ledgerSource: 'journal'`
// regardless, letting a REFUTED finding seed the next round's carry/adjudicate track as if it had
// never been checked. The fix: `verifySeen > 0 && verifyLinked === 0` refuses the ledger entirely.
test('a stalled run whose verify verdict could not be linked to a transcript refuses ledgerSource:journal', (t) => {
  const store = tmpStore()
  const claudeHome = tmpStore()
  const { dir: project, head } = tinyRepo()
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  const now = new Date()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head, gate: { status: 'pass' } }, { project })
  const hi = (source, title) => ({ severity: 'High', title, file: 'a.rs', line: 1, why: 'w', source })
  // A 'verify' result with an agentId, but NO agent-<id>.jsonl transcript planted next to the
  // journal — exactly what a renamed/moved transcript file looks like from this reader's side.
  plantWorkflowJournal(claudeHome, project, [
    { type: 'result', result: { baseRef: 'origin/main', branch: 'feat/x', head: 'deadbeef', files: ['a.rs'] } },
    { type: 'result', agentId: 'lens1', result: { lens: 'safety', findings: [hi('safety', 'unwrap panics')] } },
    { type: 'result', agentId: 'verifier1', result: { refuted: true, citedLineMatches: true, reachable: true, premiseSupported: true } },
  ])

  const out = recoverPartials({ store, project, now: new Date(now.getTime() + 1000), claudeHome })
  assert.equal(out.length, 1)
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.equal(rec.partial, true)
  assert.equal('ledgerSource' in rec, false, 'a link-broken journal must never be presented as a trustworthy ledger')
  assert.equal('ledger' in rec, false)
  assert.equal(rec.verifySeen, 1)
  assert.equal(rec.verifyLinked, 0)
  assert.match(rec.partialReason, /could not be linked/)
  // findPriorRound must then reject it exactly like a partial with no ledger at all.
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: path.basename(out[0].file).replace(/-workflow-review\.json$/, ''), kind: 'workflow', name: 'review', project, branch: 'feat/x', head }) + '\n')
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'partial-only')
})

test('a stalled run with NO journal still recovers, unchanged, to the checkpoint-only record', () => {
  const store = tmpStore()
  const claudeHome = tmpStore() // exists, but no journal planted anywhere under it
  const project = tmpStore()
  const now = new Date()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now })
  writeCheckpoint(dir, 'rust-plan', {
    branch: 'feat/x', findings: { total: 5, bySeverity: { Critical: 0, High: 5, Medium: 0, Low: 0, Info: 0 } },
  }, { project })

  const out = recoverPartials({ store, project, now, claudeHome })
  assert.equal(out.length, 1)
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.equal(rec.partial, true)
  assert.equal('ledgerSource' in rec, false, 'no journal was found — no ledger must be fabricated')
  assert.equal('ledger' in rec, false)
  assert.equal(rec.findings.total, 5, 'degrades to the checkpoint\'s own findings count, unchanged')
})

test('ambiguity resolves to nothing: two candidate journals leave the recovered record with no ledger', () => {
  const store = tmpStore()
  const claudeHome = tmpStore()
  const project = tmpStore()
  const now = new Date()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now })
  writeCheckpoint(dir, 'rust-plan', {
    branch: 'feat/x', findings: { total: 3, bySeverity: { Critical: 0, High: 3, Medium: 0, Low: 0, Info: 0 } },
  }, { project })
  const hi = (source, title) => ({ severity: 'High', title, file: 'a.rs', line: 1, why: 'w', source })
  // Two journals born in the same window is exactly the ambiguity findJournalForRun refuses.
  plantWorkflowJournal(claudeHome, project, [{ type: 'result', agentId: 'a1', result: { lens: 'safety', findings: [hi('safety', 'x')] } }], { session: 'aaaaaaaa-0000-4000-8000-000000000011', wf: 'wf1' })
  plantWorkflowJournal(claudeHome, project, [{ type: 'result', agentId: 'a1', result: { lens: 'safety', findings: [hi('safety', 'y')] } }], { session: 'aaaaaaaa-0000-4000-8000-000000000022', wf: 'wf2' })

  const out = recoverPartials({ store, project, now: new Date(now.getTime() + 1000), claudeHome })
  assert.equal(out.length, 1)
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.equal('ledgerSource' in rec, false, 'ambiguity must never seed the next review with a guessed ledger')
  assert.equal('ledger' in rec, false)
  assert.equal(rec.findings.total, 3, 'falls back to the checkpoint count')
})

test('recoverPartials survives a journal reconnection that throws — best-effort must not abort recovery', () => {
  const store = tmpStore()
  const project = tmpStore()
  const now = new Date()
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now })
  writeCheckpoint(dir, 'rust-plan', {
    branch: 'feat/x', findings: { total: 3, bySeverity: { Critical: 0, High: 3, Medium: 0, Low: 0, Info: 0 } },
  }, { project })
  // A malformed claudeHome (not a string) makes findJournalForRun's own path.join throw — recovery
  // of the partial run itself must not be sacrificed to a broken journal lookup.
  const out = recoverPartials({ store, project, now, claudeHome: 12345 })
  assert.equal(out.length, 1)
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.equal('ledgerSource' in rec, false)
  assert.equal(rec.findings.total, 3)
})

// ---- findPriorRound and a journal-sourced partial ledger ---------------------------------------
function tinyRepo(branch = 'feat/x') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior-repo-'))
  const g = a => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  g(['init', '-q', '-b', branch])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a'), '1'); g(['add', 'a']); g(['commit', '-qm', 'one'])
  return { dir, head: g(['rev-parse', '--short', 'HEAD']) }
}

test('findPriorRound accepts a partial record whose ledger came from the journal', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tinyRepo()
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  const ts = '2026-07-10T00-00-00Z'
  fs.writeFileSync(path.join(store, `${ts}-workflow-review.json`), JSON.stringify({
    partial: true, ledgerSource: 'journal', ledger: [{ fp: 'aaaa' }], findings: { total: 1 }, round: 0,
  }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts, kind: 'workflow', name: 'review', project, branch: 'feat/x', head }) + '\n')

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.equal(hit.ledger.length, 1)
  assert.equal(hit.ledger[0].fp, 'aaaa')
})

test('findPriorRound still rejects a partial record with no journal ledger — reason partial-only', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tinyRepo()
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  const ts = '2026-07-10T00-00-00Z'
  // partial, but the ordinary checkpoint-only recovery — no ledgerSource, no ledger.
  fs.writeFileSync(path.join(store, `${ts}-workflow-review.json`), JSON.stringify({
    partial: true, findings: { total: 1 }, round: 0,
  }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts, kind: 'workflow', name: 'review', project, branch: 'feat/x', head }) + '\n')

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'partial-only')
})

test('findPriorRound never exposes a verdict at all, so a partial record\'s verdict can never leak as the round\'s conclusion', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tinyRepo()
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  const ts = '2026-07-10T00-00-00Z'
  fs.writeFileSync(path.join(store, `${ts}-workflow-review.json`), JSON.stringify({
    partial: true, ledgerSource: 'journal', ledger: [{ fp: 'aaaa' }], findings: { total: 1 }, round: 0,
    verdict: 'INCOMPLETE',
  }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts, kind: 'workflow', name: 'review', project, branch: 'feat/x', head }) + '\n')

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.equal('verdict' in hit, false, 'findPriorRound returns no verdict field at all')
})

test('findingsFromJournal and recordFromJournal agree on what counts as a finding', () => {
  const dir = tmpStore()
  const hi = (source, title) => ({ severity: 'High', title, file: 'a.rs', line: 1, why: 'w', source })
  fakeJournal(dir, [
    { type: 'result', agentId: 'a1', result: { lens: 'safety', findings: [hi('safety', 'unwrap panics')] } },
    { type: 'result', agentId: 'a2', result: { status: 'pass', seedFindings: [hi('clippy', 'seed defect')] } },
    { type: 'result', agentId: 'a3', result: { refuted: true, citedLineMatches: true, reachable: true, premiseSupported: true } },
  ])
  const direct = findingsFromJournal(dir)
  const rec = recordFromJournal(dir)
  // findingsFromJournal stays best-effort here (a3's verify verdict never links to a transcript, so
  // it cannot tell confirmed from refuted and returns both candidates unfiltered) — that best-effort
  // behaviour is unchanged. What changed is that this ambiguity is no longer swallowed: the record
  // now SAYS a verify verdict was seen and none of it linked, which is what `recoverPartials` reads
  // to refuse presenting this as a trustworthy `ledgerSource: 'journal'` ledger (see the dedicated
  // recoverPartials test above) — the silent revert this branch fixed was never in this function's
  // return value, it was in a caller trusting an ambiguous one.
  assert.equal(direct.length, 2)
  assert.equal(rec.findings.total, direct.length, 'the summary record must count exactly what findingsFromJournal counts')
  assert.deepEqual(rec.candidatesBySource, { safety: 1, clippy: 1 })
  assert.equal(rec.verifySeen, 1, 'a3\'s verify result was seen')
  assert.equal(rec.verifyLinked, 0, 'but never linked — no agent-a3.jsonl transcript was planted')
})

// Tripwire: parseIndividualVerifyTarget/parseBatchVerifyTargets (above) exist ONLY to reverse-engineer
// the finding identity back out of the exact prompt text verifyPrompt/batchVerifyPrompt (workflows/review.js)
// build. The tests above feed those parsers HAND-WRITTEN prompt strings — which proves the regexes parse
// what we typed, not what review.js actually sends. If someone rewords either prompt template, that
// coupling breaks silently: every refuted finding comes back as an open candidate, and the hand-written
// fixtures above stay green because they never re-derive from the source.
//
// review.js can't be imported (top-level export/await/return — see lib/review-coverage.test.mjs's header
// for the same constraint on `shq`), so this pulls the REAL template text out of the source file by slicing
// between stable markers, then evaluates it: verifyPrompt/batchVerifyPrompt call promptFields/flattenField
// (also sliced from the source, since they are private helpers) and sanitizeAttack, which IS extracted to
// lib/review-adjudicate.mjs and is imported here directly rather than re-sliced.
//
// This only works because verifyPrompt/batchVerifyPrompt are self-contained (no closure over other
// workflow-local state) — if that stops being true, the slice would need to grow with them, and the
// failure would be a sliced-source ReferenceError, not a silent pass.
test('parseIndividualVerifyTarget/parseBatchVerifyTargets are bound to review.js\'s REAL prompt templates, not a hand-typed copy', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../workflows/review.js', import.meta.url)), 'utf8')
  const slice = (startMarker, endMarker) => {
    const s = src.indexOf(startMarker)
    const e = src.indexOf(endMarker, s)
    assert.ok(s >= 0, `expected to find "${startMarker}" in workflows/review.js — the prompt was moved or renamed; update this test's markers`)
    assert.ok(e > s, `expected to find "${endMarker}" after "${startMarker}" in workflows/review.js — update this test's markers`)
    return src.slice(s, e)
  }
  const fieldsSrc = slice('function flattenField(v)', '\n// POSIX single-quote')
  const verifySrc = slice('function verifyPrompt(f, idx', '\n// Cross-lens dedup')
  const batchSrc = slice('function batchVerifyPrompt(group', '\nasync function verifyPool')
  const combined = `${fieldsSrc}\n${verifySrc}\n${batchSrc}\nreturn { verifyPrompt, batchVerifyPrompt }`
  let verifyPrompt, batchVerifyPrompt
  try {
    ;({ verifyPrompt, batchVerifyPrompt } = new Function('sanitizeAttack', 'ATTACK_MAX', combined)(sanitizeAttack, ATTACK_MAX))
  } catch (err) {
    assert.fail(`could not evaluate verifyPrompt/batchVerifyPrompt sliced from workflows/review.js — the prompt in review.js changed shape (e.g. it now closes over more workflow-local state); update this test's slice markers or extract the functions to lib/. Underlying error: ${err.message}`)
  }

  const findingA = { severity: 'High', title: 'unwrap panics', file: 'a.rs', line: 42, why: 'w', source: 'safety' }
  const findingB = { severity: 'Medium', title: 'unused import', file: 'b.rs', line: 5, why: 'w', source: 'idioms' }
  const profile = { lang: 'Rust', fpRules: null }

  const individualPrompt = verifyPrompt(findingA, 0, false, '', profile)
  const individualTarget = parseIndividualVerifyTarget(individualPrompt)
  assert.ok(individualTarget,
    'parseIndividualVerifyTarget found nothing in the REAL verifyPrompt() output — the prompt in workflows/review.js changed and lib/craft-log-run.mjs\'s parser must be updated to match, or every verify verdict silently stops linking to its finding')
  assert.deepEqual(individualTarget, { title: 'unwrap panics', file: 'a.rs', line: 42 })

  const batchPrompt = batchVerifyPrompt([findingA, findingB], profile)
  const batchTargets = parseBatchVerifyTargets(batchPrompt)
  assert.equal(batchTargets.size, 2,
    'parseBatchVerifyTargets recovered the wrong number of findings from the REAL batchVerifyPrompt() output — the prompt in workflows/review.js changed and lib/craft-log-run.mjs\'s parser must be updated to match, or verify-batch verdicts silently stop linking to their findings')
  assert.deepEqual(batchTargets.get(0), { title: 'unwrap panics', file: 'a.rs', line: 42 })
  assert.deepEqual(batchTargets.get(1), { title: 'unused import', file: 'b.rs', line: 5 })
})

// ---- branch/head are read by the SCRIPT, not carried by the model ---------------------------
// Measured on the live store on 2026-09-17: of 115 `kind:"workflow"` rows, only 47 carried a
// `branch` and 60 a `head`, because both arrived from the `detect` agent's answer. `findPriorRound`
// selects on `e.branch === branch`, so a row without one does not exist for it — a real run's
// prior-round read came back `found:false, ledgerCount:0`, `unattributable-rows-only`. The
// re-review memory could not START. These tests pin the source of those two fields, not their shape.

function initRepo(files = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'feat/measured', dir])
  if (files) {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'a.txt'], { cwd: dir })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  }
  return dir
}

test('a record whose branch/head are empty on the model side still gets them, and findPriorRound then finds it', () => {
  const store = tmpStore()
  const repo = initRepo()
  const cli = (args, stdin) => execFileSync('node', [SCRIPT, ...args, '--store', store, '--project', repo],
    { cwd: repo, input: stdin, encoding: 'utf8' })

  // Exactly what a dead or partial `detect` agent produces: the fields are present and empty.
  cli(['write'], JSON.stringify({ ...RECORD, branch: null, head: null }))

  const rec = JSON.parse(fs.readFileSync(path.join(store, fs.readdirSync(store).find(f => f.endsWith('.json'))), 'utf8'))
  assert.equal(rec.branch, 'feat/measured', 'the branch comes off git, not off the payload')
  assert.match(rec.head, /^[0-9a-f]{40}$/, 'and so does the head')

  const row = JSON.parse(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim())
  assert.equal(row.branch, 'feat/measured', 'the INDEX row is what findPriorRound selects on')
  assert.equal(row.head, rec.head)

  // The consequence the whole fix exists for: the next round can read the previous one.
  // `repoKey` (and so the row) resolves symlinks — on macOS the tmpdir is one.
  const prior = findPriorRound({ store, project: fs.realpathSync(repo), branch: 'feat/measured' })
  assert.equal(prior.found, true, `prior round must be findable; got ${JSON.stringify(prior)}`)

  // And the read side no longer depends on a model supplying --branch at all.
  const viaCli = JSON.parse(cli(['prior-round']).trim())
  assert.equal(viaCli.found, true, 'prior-round derives the branch itself when --branch is absent')
})

test('a detached HEAD is recorded as NO branch, never as the literal "HEAD"', () => {
  const repo = initRepo()
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  execFileSync('git', ['checkout', '-q', '--detach', sha], { cwd: repo })
  const id = gitIdentity(repo)
  assert.equal(id.branch, '', 'git prints the literal "HEAD" here; filing that as a branch would pool every detached run under one key')
  assert.equal(id.head, sha, 'the head is still known and still recorded')

  // Empty means "unknown", and unknown must not erase what the caller did know.
  assert.deepEqual(applyGitIdentity({ branch: 'known/from-elsewhere', head: null }, id),
    { branch: 'known/from-elsewhere', head: sha })

  const store = tmpStore()
  execFileSync('node', [SCRIPT, 'write', '--store', store, '--project', repo],
    { cwd: repo, input: JSON.stringify({ ...RECORD, branch: null, head: null }), encoding: 'utf8' })
  const row = JSON.parse(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim())
  assert.equal(row.branch, null, 'no branch is the honest answer; findPriorRound reports no-branch for it')
  assert.equal(row.head, sha)
})

test('no git, an empty repository and a bare one cost a field, never the record', () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-plain-'))
  assert.deepEqual(gitIdentity(notARepo), { branch: '', head: '' })

  const empty = initRepo(false)               // initialised, not one commit
  assert.equal(gitIdentity(empty).head, '', 'rev-parse HEAD has nothing to resolve')

  const src = initRepo()
  const bare = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-bare-')), 'b.git')
  execFileSync('git', ['clone', '-q', '--bare', src, bare])
  assert.doesNotThrow(() => gitIdentity(bare), 'a bare repo has no work tree; probing it must not throw')

  // The record lands in every one of those directories.
  for (const dir of [notARepo, empty, bare]) {
    const store = tmpStore()
    execFileSync('node', [SCRIPT, 'write', '--store', store, '--project', dir],
      { cwd: dir, input: JSON.stringify({ ...RECORD, branch: null, head: null }), encoding: 'utf8' })
    assert.equal(fs.readdirSync(store).filter(f => f.endsWith('.json')).length, 1, `a record must still be written for ${dir}`)
  }
})

// The ownership proof in `finalizeRun` reads branch/head off the PAYLOAD to compare against what the
// run's own checkpoints attest. review.js writes `head: baseRef` into its checkpoints and the real
// HEAD into its final record, so filling the payload from git BEFORE that comparison would make a
// run disagree with itself and stop its checkpoints being folded in. Hence gitId is applied in
// writeRecord and merely forwarded by finalizeRun — pinned here because nothing else would notice.
test('git-derived identity does not poison the fold: checkpoints are still folded into the record', () => {
  const store = tmpStore()
  const repo = initRepo()
  const cli = (args, stdin) => execFileSync('node', [SCRIPT, ...args, '--store', store, '--project', repo],
    { cwd: repo, input: stdin, encoding: 'utf8' })
  const ck = JSON.parse(cli(['checkpoint', '--phase', 'Scout'], JSON.stringify({
    kind: 'workflow', name: 'review', phase: 'Scout', branch: 'feat/measured', head: 'origin/main',
  })).trim())
  const out = cli(['finalize', '--dir', ck.runDir], JSON.stringify({ ...RECORD, branch: null, head: null }))
  assert.match(out, /folded 1 checkpoint/, 'the checkpoint must still be folded in')
  const rec = JSON.parse(fs.readFileSync(path.join(store, fs.readdirSync(store).find(f => f.endsWith('.json'))), 'utf8'))
  assert.equal(rec.branch, 'feat/measured')
  assert.match(rec.head, /^[0-9a-f]{40}$/, 'the record carries the real HEAD, not the checkpoint\'s baseRef')
})

// ---- the identity is read off the WORKING COPY, not off the collapsed project key -------------
// `repoKey` deliberately folds a linked worktree onto its main checkout so the two share one round
// chain. Reading `gitIdentity` from that folded key answers with the MAIN checkout's branch and
// head — and since git now WINS over the caller's `--branch`, the correct value the engine passes is
// overwritten rather than merely missing. Built with a real worktree pair rather than reasoned about.
test('a run in a linked worktree records the WORKTREE\'s branch, not the main checkout\'s', () => {
  const store = tmpStore()
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-main-'))
  execFileSync('git', ['init', '-q', '-b', 'main', main])
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n')
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'a.txt'], { cwd: main })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: main })
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-wtp-')), 'wt')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/in-worktree', wt, 'HEAD'], { cwd: main })
  try {
    // The worktree moves ahead, exactly as a review branch does — so `main`'s head is an ANCESTOR of
    // it, which is what makes the prior-round confusion below pass `merge-base --is-ancestor`.
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n')
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'b.txt'], { cwd: wt })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work'], { cwd: wt })
    const wtHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim()
    const mainHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: main, encoding: 'utf8' }).trim()
    assert.notEqual(wtHead, mainHead, 'the fixture only means anything if the two checkouts differ')

    // Precondition, stated as an assertion: the project KEY is still the shared one. The fix must not
    // split the round chain to get the branch right.
    assert.equal(repoKey(wt), fs.realpathSync(main), 'repoKey must still collapse the worktree onto the main checkout')

    // 1. A run filed from the main checkout, on `main`. This is the chain a worktree run must NOT join.
    execFileSync('node', [SCRIPT, 'write', '--store', store, '--project', main],
      { cwd: main, input: JSON.stringify({ ...RECORD, round: 1, branch: null, head: null }), encoding: 'utf8' })

    // 2. A run filed from the worktree, which the engine correctly tells is on `feat/in-worktree`.
    execFileSync('node', [SCRIPT, 'write', '--store', store, '--project', wt],
      { cwd: wt, input: JSON.stringify({ ...RECORD, round: 1, branch: 'feat/in-worktree', head: null }), encoding: 'utf8' })

    const rows = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].branch, 'main')
    assert.equal(rows[1].branch, 'feat/in-worktree', 'the worktree run must be filed under the worktree\'s branch')
    assert.equal(rows[1].head, wtHead, 'and under the worktree\'s head, not the main checkout\'s')
    assert.equal(rows[0].project, rows[1].project, 'both still key to the one shared project — the chain is not split')

    // 3. The heavy consequence: the reader must not hand the worktree run the main checkout's chain.
    const prior = JSON.parse(execFileSync('node', [SCRIPT, 'prior-round', '--store', store, '--project', wt],
      { cwd: wt, encoding: 'utf8' }).trim())
    assert.equal(prior.found, true, `the worktree's OWN prior round must be findable; got ${JSON.stringify(prior)}`)
    assert.equal(prior.head, wtHead, 'and it is the worktree run, not the main checkout\'s row whose head is an ancestor')
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: main })
  }
})

// ---- the ownership proof must survive the two payload shapes the engine really writes ---------
// `workflows/review.js` writes `head: baseRef` (the diff base, a ref NAME) into every checkpoint and
// the run's real HEAD into the final record. Measured before the fix: `finalizeRun` returned
// `folded: 0, kept: true`, the `.partial` directory survived and the record carried no `phases` at
// all — so the fold never happened on any review that reported a head, and `recover` later promoted
// the leftover as a second, `partial: true` run of the same review.
test('finalize folds its own checkpoints when the checkpoints spell `head` as the diff base', () => {
  const store = tmpStore()
  const repo = initRepo()
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const cli = (args, stdin) => execFileSync('node', [SCRIPT, ...args, '--store', store, '--project', repo],
    { cwd: repo, input: stdin, encoding: 'utf8' })
  const ck = JSON.parse(cli(['checkpoint', '--phase', 'Gate'], JSON.stringify({
    kind: 'workflow', name: 'review', phase: 'Gate', branch: 'feat/measured', head: 'origin/main',
  })).trim())
  // The final payload as review.js assembles it: the SAME run, a head spelled the other way.
  const out = cli(['finalize', '--dir', ck.runDir], JSON.stringify({
    ...RECORD, branch: 'feat/measured', head,
  }))
  assert.match(out, /folded 1 checkpoint/, 'the run\'s own checkpoint must be folded in')
  assert.equal(fs.existsSync(ck.runDir), false, 'and the directory removed, not stranded for `recover`')
  const rec = JSON.parse(fs.readFileSync(path.join(store, fs.readdirSync(store).find(f => f.endsWith('.json'))), 'utf8'))
  assert.equal(Array.isArray(rec.phases), true, 'the record must carry its phases')
  assert.equal(rec.phases.length, 1)
  assert.equal(rec.phases[0].phase, 'Gate')
})

// The same at the function level, and the other direction too: a directory whose checkpoints
// DISAGREE with each other about `head` is no longer disqualified by that alone, because `head` is
// not what proves ownership. `branch` still is.
test('identityAgrees: `head` does not decide ownership, `branch` and `project` do', () => {
  const mine = { project: '/repos/mine', branch: 'feat/x', head: 'abc1234' }
  assert.equal(identityAgrees(mine, { project: '/repos/mine', branch: 'feat/x', head: 'origin/main' }), true,
    'the two writers spell `head` differently; that is not a different run')
  assert.equal(identityAgrees(mine, { project: '/repos/mine', branch: 'feat/x', head: null }), true,
    'nor is a directory that disagrees with itself about a field that proves nothing')
  assert.equal(identityAgrees(mine, { project: '/repos/mine', branch: 'feat/other', head: 'abc1234' }), false,
    'a different branch IS a different run')
  assert.equal(identityAgrees(mine, { project: '/repos/mine', branch: null, head: 'abc1234' }), false,
    'and a directory that cannot agree with itself about the branch is nobody\'s')
  assert.equal(identityAgrees(mine, { project: '/repos/theirs', branch: 'feat/x', head: 'abc1234' }), false)
})
