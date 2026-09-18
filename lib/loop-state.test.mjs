// The loop state must outlive the telemetry record it used to ride on.
//
// Every test here is written against the measured failure, not against the code: a run files its
// record once, at the end, through a model, and two consecutive runs lost that record entirely (a
// network error; a 196KB payload). The chain then restarted at "round 1" with no sign of a refusal.
// So each case below asks the same question — the record is GONE or CORRUPT: does the next round
// still know a round happened, and does it say so?
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { reconcileChain, provesRound, ROUND_PROVING_REJECTIONS } from './loop-state.mjs'
import { findPriorRound, partialChainEvidence, checkpointDir, writeCheckpoint, stampMs, recoverPartials } from './craft-log-run.mjs'

// THE SEAM. `reconcileChain` decides; `workflows/review.js` is what has to be LOUD about it, and the
// two were never tested together — the decision's own tests passed while the flags the engine reads
// off the result were false. So the engine's real guards are loaded out of the real workflow script
// (it cannot be imported: top-level export + await + return) and run against reconcileChain's own
// output, exactly as they run at runtime. The same wrapper lib/review-adjudicate.test.mjs uses.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function engineGuards() {
  const src = fs.readFileSync(path.join(root, 'workflows', 'review.js'), 'utf8')
  const cut = src.indexOf("phase('Scout')")
  assert.ok(cut > 0, "expected a top-level phase('Scout') to mark the end of the declarations prefix")
  const prefix = src.slice(0, cut).replace(/^export const meta/m, 'const meta')
  const stub = () => {}
  const budget = { total: null, spent: () => 0, remaining: () => 0 }
  const factory = new Function(
    'args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow',
    `${prefix}\n;return { ledgerDegraded, ledgerTruncated, shouldFullRescan };`,
  )
  return factory({}, stub, stub, stub, stub, stub, budget, stub)
}
const { ledgerDegraded, ledgerTruncated, shouldFullRescan } = engineGuards()

function tempRepo(branch = 'feat/x') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-loop-repo-')))
  const g = a => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  g(['init', '-q', '-b', branch])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a'), '1'); g(['add', 'a']); g(['commit', '-qm', 'one'])
  return { dir, head: g(['rev-parse', '--short', 'HEAD']) }
}

function tmpStore() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-loop-store-')))
}

// ---- the rule, on its own ----------------------------------------------------------------------

test('reconcileChain: nothing knows anything — only then may it render as a first review', () => {
  assert.equal(reconcileChain({}), null)
})

test('reconcileChain: a proven-but-unmaterializable round is a DEGRADED round, never found:false', () => {
  const out = reconcileChain({ proven: { round: 4, head: 'abc1234', findingsTotal: 7 } })
  assert.equal(out.found, true)
  assert.equal(out.round, 4)
  assert.equal(out.head, 'abc1234')
  assert.deepEqual(out.ledger, [], 'a record we could not read supplies no findings')
  assert.equal(out.ledgerCount, 0)
  // The pair (ledger empty, priorFindings > 0) is exactly what review.js's ledgerDegraded reads to
  // log the break and force a full base...HEAD re-scan. Without it the same facts render as silence.
  assert.equal(out.priorFindings, 7)
})

test('reconcileChain: a complete round wins over a proven-only one', () => {
  const complete = { found: true, round: 2, head: 'h', ledger: [{ fp: 'a' }], ledgerCount: 1, priorFindings: 3, journalSourced: false, reason: '' }
  assert.equal(reconcileChain({ complete, completeAt: 100, proven: { round: 9 } }), complete)
})

test('reconcileChain: a checkpoint directory NEWER than the newest complete round advances the round and carries NO ledger it did not write', () => {
  const complete = { found: true, round: 2, head: 'old', ledger: [{ fp: 'a' }], ledgerCount: 1, priorFindings: 3, journalSourced: false, reason: '' }
  const out = reconcileChain({ complete, completeAt: 100, evidence: { at: 200, head: 'newhead', findingsTotal: 6 } })
  assert.equal(out.round, 3, 'the run that died was round 3 — it read the same chain we just did')
  assert.equal(out.head, 'newhead')
  // The older shape carried round 2's ledger under round 3's number, and that is what made the
  // degradation invisible: a non-empty ledger beside a non-zero count reads as a healthy round.
  assert.deepEqual(out.ledger, [], 'a round that sharded no ledger carries none — not its predecessor\'s')
  assert.equal(out.ledgerCount, 0)
  assert.equal(out.priorFindings, 6, 'the DEAD run\'s own count, so the loss is legible rather than merely survived')
})

test('reconcileChain: an OLDER checkpoint directory does not displace the complete round', () => {
  const complete = { found: true, round: 2, head: 'h', ledger: [], ledgerCount: 0, priorFindings: 0, journalSourced: false, reason: '' }
  assert.equal(reconcileChain({ complete, completeAt: 500, evidence: { at: 100, head: 'x', findingsTotal: 9 } }), complete)
})

test('reconcileChain: a round read off a STOPPED run\'s checkpoints is journalSourced; a proven-but-unreadable record is not', () => {
  // `proven` is a round that genuinely completed — its head is its own, and a delta off it is sound.
  assert.equal(reconcileChain({ proven: { round: 1, head: 'h', findingsTotal: 1 } }).journalSourced, false)
  // Evidence is the opposite: the head is where a run STOPPED and may equal the caller's HEAD.
  assert.equal(reconcileChain({ evidence: { at: 1, head: 'h', findingsTotal: 1 } }).journalSourced, true)
})

// ---- the seam: what the engine actually READS off that decision ---------------------------------

test('SEAM: a round read off checkpoints with no sharded ledger is DEGRADED in the engine, and forces a full re-scan', () => {
  const complete = { found: true, round: 2, head: 'old', ledger: [{ fp: 'a' }], ledgerCount: 1, priorFindings: 3, journalSourced: false, reason: '' }
  const out = reconcileChain({ complete, completeAt: 100, evidence: { at: 200, head: 'newhead', findingsTotal: 6 } })
  assert.equal(ledgerDegraded(out), true, 'the engine must read this as a degraded round — that is the whole loudness')
  assert.equal(shouldFullRescan({ priorRound: out, thisRound: out.round + 1, fullEvery: 0, degraded: ledgerDegraded(out), journalSourced: out.journalSourced }), true,
    'and re-scan the full base...HEAD diff rather than a delta off a dead run\'s head')
})

test('SEAM: even a COMPLETE sharded carry still forces a full re-scan — the head belongs to the run that stopped', () => {
  const ledger = [{ fp: 'a' }, { fp: 'b' }]
  const out = reconcileChain({ complete: null, completeAt: NaN, evidence: { at: 200, head: 'h', findingsTotal: 2, ledger, ledgerTotal: 2 } })
  assert.equal(ledgerTruncated(out), false, 'a complete carry is not a truncated one')
  assert.equal(ledgerDegraded(out), false, 'nor a degraded one — the round\'s own memory survived')
  // The head is still the stopped run's. A re-run on the same commit before any fix makes
  // head...HEAD empty, so an incremental round here would review nothing at all.
  assert.equal(shouldFullRescan({ priorRound: out, thisRound: out.round + 1, fullEvery: 0, degraded: false, journalSourced: out.journalSourced }), true)
})

test('SEAM: a SHORT sharded carry is read as truncated, so the shortfall is loud', () => {
  const out = reconcileChain({ evidence: { at: 200, head: 'h', findingsTotal: 5, ledger: [{ fp: 'a' }], ledgerTotal: 4 } })
  assert.equal(out.ledgerCount, 4, 'the count the dead run DECLARED, not the array that survived')
  assert.equal(ledgerTruncated(out), true)
  assert.equal(ledgerDegraded(out), true)
})

test('SEAM: control — an ordinary complete round stays incremental, so the guards above are not always-on', () => {
  const complete = { found: true, round: 2, head: 'old', ledger: [{ fp: 'a' }], ledgerCount: 1, priorFindings: 1, journalSourced: false, reason: '' }
  const out = reconcileChain({ complete, completeAt: 500, evidence: { at: 100, head: 'x', findingsTotal: 9 } })
  assert.equal(ledgerDegraded(out), false)
  assert.equal(shouldFullRescan({ priorRound: out, thisRound: 3, fullEvery: 0, degraded: false, journalSourced: out.journalSourced }), false)
})

test('only a record that could not be READ proves a round; a rebase does not', () => {
  assert.deepEqual(ROUND_PROVING_REJECTIONS, ['detail-unreadable', 'partial-only'])
  assert.equal(provesRound('ancestry-rejected'), false)
  assert.equal(provesRound('no-candidate-rows'), false)
  assert.equal(provesRound(''), false)
})

// ---- against a store on disk -------------------------------------------------------------------

test('REQUIREMENT: the telemetry record is DELETED — the next round still knows the round happened, and says so', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  // An index line survives; its detail file does not. This is the shape a lost/destroyed record
  // leaves behind, and the shape the old read path answered `found:false, reason:detail-unreadable`.
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 3, findingsTotal: 11 }) + '\n')

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true, 'a lost record must not render the next run as a first review')
  assert.equal(hit.round, 3)
  assert.equal(hit.head, head)
  assert.equal(hit.ledger.length, 0)
  assert.equal(hit.priorFindings, 11, 'the count the row still carries is what makes the break loud')
})

test('REQUIREMENT: the telemetry record is CORRUPT — same answer, for the same reason', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'), '{"round": 3, "ledger": [{"fp":')
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 3, findingsTotal: 11 }) + '\n')

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.equal(hit.round, 3)
  assert.equal(hit.priorFindings, 11)
})

test('REQUIREMENT: a run that filed NO record at all leaves its checkpoints — the chain reads them and advances', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  // Round 2 completed and filed a record with a ledger.
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
    JSON.stringify({ round: 2, head, ledger: [{ fp: 'aaaa', file: 'a.rs', line: 1, title: 't', why: 'w', severity: 'High', tier: 'confirmed', disposition: 'open', source: 's', symbol: '' }], findings: { total: 1 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 2, findingsTotal: 1 }) + '\n')
  // Round 3 ran afterwards and died before finalizing: only its phase checkpoints exist.
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head }, { project })
  writeCheckpoint(dir, 'rust-verify', { branch: 'feat/x', head, findings: { total: 6 } }, { project })

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.equal(hit.round, 3, 'the round that died still counted')
  assert.equal(hit.priorFindings, 6, 'what the dead run had found by the time it stopped')
  assert.deepEqual(hit.ledger, [], 'round 2\'s ledger is NOT carried under round 3\'s number')
  assert.equal(hit.ledgerCount, 0)
  assert.equal(hit.journalSourced, true, 'the head is where a run stopped — the engine must not diff off it')
})

test('a checkpoint directory belonging to ANOTHER project is not this chain\'s evidence', (t) => {
  const store = tmpStore()
  const { dir: project } = tempRepo('feat/x')
  const { dir: other } = tempRepo('feat/x')
  t.after(() => { [store, project, other].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: other, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x' }, { project: other })
  assert.deepEqual(partialChainEvidence({ store, project, branch: 'feat/x' }), [])
  assert.equal(findPriorRound({ store, project, branch: 'feat/x' }).found, false)
})

test('a checkpoint directory on ANOTHER branch is not this chain\'s evidence', (t) => {
  const store = tmpStore()
  const { dir: project } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'other' }, { project })
  assert.deepEqual(partialChainEvidence({ store, project, branch: 'feat/x' }), [])
})

test('BACK-COMPAT: a legacy checkpoint directory that predates the identity fields is skipped, never guessed at', (t) => {
  const store = tmpStore()
  const { dir: project } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  // 13 of the 57 directories in the live store look exactly like this: checkpoints with no `project`.
  const dir = path.join(store, '.partial', '2026-07-11T00-00-00Z-workflow-review')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '00-rust-plan.json'), JSON.stringify({ phase: 'rust-plan', branch: 'feat/x', head: 'main' }))
  assert.deepEqual(partialChainEvidence({ store, project, branch: 'feat/x' }), [])
})

test('BACK-COMPAT: an accumulated store of ordinary completed rounds still reads exactly as before', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const ledger = [{ fp: 'aaaa', file: 'a.rs', line: 3, title: 't', why: 'w', severity: 'High', tier: 'confirmed', disposition: 'open', source: 's', symbol: '' }]
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'), JSON.stringify({ round: 1, head, ledger, findings: { total: 1 } }))
  fs.writeFileSync(path.join(store, '2026-07-12T00-00-00Z-workflow-review.json'), JSON.stringify({ round: 2, head, ledger, findings: { total: 1 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'), [
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 1 }),
    JSON.stringify({ ts: '2026-07-12T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 2 }),
  ].join('\n') + '\n')
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.equal(hit.round, 2)
  assert.equal(hit.ledgerCount, 1)
  assert.equal(hit.reason, '')
  assert.equal(hit.journalSourced, false)
})

test('BACK-COMPAT: a branch that was genuinely never reviewed is still a first review', (t) => {
  const store = tmpStore()
  const { dir: project } = tempRepo('feat/new')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  fs.writeFileSync(path.join(store, 'index.jsonl'), '')
  const hit = findPriorRound({ store, project, branch: 'feat/new' })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'no-candidate-rows')
})

test('BACK-COMPAT: a rebased-away round is still rejected, not resurrected as degraded', (t) => {
  const store = tmpStore()
  const { dir: project } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'), JSON.stringify({ round: 1, ledger: [], findings: { total: 4 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head: '0123456789abcdef0123456789abcdef01234567', round: 1 }) + '\n')
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, false, 'a history that no longer carries the round is a genuinely ended chain')
  assert.equal(hit.reason, 'ancestry-rejected')
})

test('a RESUMED run does not read its OWN unfinalized directory as a dead predecessor', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  // Round 2 completed. Round 3 is THIS run: it checkpointed, the harness session was resumed, and it
  // now re-reads the chain while its own directory sits in the store under the same project/branch.
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
    JSON.stringify({ round: 2, head, ledger: [], findings: { total: 0 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 2 }) + '\n')
  const mine = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(mine, 'rust-plan', { branch: 'feat/x', head }, { project, session: 'sess-me' })
  // Without the exclusion this run counts itself: round 3 becomes round 4 and the chain is read off
  // its own head — and from there the whole degraded-round path runs against a delta of nothing.
  assert.deepEqual(partialChainEvidence({ store, project, branch: 'feat/x', session: 'sess-me' }), [],
    'my own directory is not evidence of a round before mine')
  assert.equal(findPriorRound({ store, project, branch: 'feat/x', session: 'sess-me' }).round, 2)
  // Control: the same directory IS evidence for a different session — a genuinely dead predecessor.
  assert.equal(partialChainEvidence({ store, project, branch: 'feat/x', session: 'other' }).length, 1)
  assert.equal(findPriorRound({ store, project, branch: 'feat/x', session: 'other' }).round, 3)
})

test('a RESUMED run recognises itself under ANY session id its own checkpoints carry', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  // The scenario the rejoin exists for: later checkpoints land under a NEW session id in the SAME
  // directory. `dirIdentity` poisons `session` to null there, so the check reads every id seen.
  const mine = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(mine, 'rust-plan', { branch: 'feat/x', head }, { project, session: 'sess-1' })
  writeCheckpoint(mine, 'rust-lenses', { branch: 'feat/x', head }, { project, session: 'sess-2' })
  assert.deepEqual(partialChainEvidence({ store, project, branch: 'feat/x', session: 'sess-1' }), [])
  assert.deepEqual(partialChainEvidence({ store, project, branch: 'feat/x', session: 'sess-2' }), [])
})

test('a checkpoint directory whose own checkpoints DISAGREE about the head is not evidence for a round number', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
    JSON.stringify({ round: 2, head, ledger: [], findings: { total: 0 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 2 }) + '\n')
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head: 'aaaaaaa' }, { project })
  writeCheckpoint(dir, 'rust-lenses', { branch: 'feat/x', head: 'bbbbbbb' }, { project })
  const ev = partialChainEvidence({ store, project, branch: 'feat/x' })
  assert.equal(ev.length, 1)
  assert.equal(ev[0].head, '', 'the contested field is poisoned — the directory cannot say where it stood')
  // An empty head passes the ancestry probe as "unverifiable". Adopted, it would advance the round to
  // 3 and hand it round 2's HEAD: a round number tied to a commit that is not where anything stopped.
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.round, 2, 'the complete round answers instead')
  assert.equal(hit.head, head)
})

// ---- the repair tool must not be the thing that breaks the chain -------------------------------

test('recover promotes a dead round WITH its round number — one repair must not reset the chain', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head, round: 7 }, { project })
  const out = recoverPartials({ store, project })
  assert.equal(out.length, 1)
  assert.equal(out[0].round, 7)
  const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
  assert.equal(rec.round, 7, 'the record carries the round; indexProjection writes `r.round ?? 0`')
  const row = JSON.parse(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim())
  assert.equal(row.round, 7, 'and so does the index row the chain is read from')
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.equal(hit.round, 7, 'after the repair the chain continues from 7, not from scratch')
})

test('recover KEEPS a directory whose round it cannot read, and does not re-file it on a second sweep', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  // A directory written before `round` rode on the checkpoints. Promoting it files a row indexed as
  // round 0 — which reads as no round at all — so deleting the directory would destroy the only
  // witness left (partialChainEvidence reads exactly these) and leave the chain worse than the loss.
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head, findings: { total: 4 } }, { project })
  const first = recoverPartials({ store, project })
  assert.equal(first.length, 1)
  assert.equal(first[0].kept, true)
  assert.ok(fs.existsSync(dir), 'the surviving witness is still there')
  assert.equal(partialChainEvidence({ store, project, branch: 'feat/x' }).length, 1, 'and still reads as evidence')
  const second = recoverPartials({ store, project })
  assert.deepEqual(second, [], 'a kept directory is not promoted twice')
  const rows = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n')
  assert.equal(rows.length, 1, 'exactly one row, however many times recover runs')
})

test('stampMs reads both the filename stamp and ordinary ISO, so the two populations compare on one clock', () => {
  assert.equal(stampMs('2026-07-10T00-00-00Z'), Date.parse('2026-07-10T00:00:00Z'))
  assert.equal(stampMs('2026-07-10T00:00:00Z'), Date.parse('2026-07-10T00:00:00Z'))
  assert.equal(stampMs('2026-07-10T00:00:00.123Z'), Date.parse('2026-07-10T00:00:00Z'))
  assert.ok(Number.isNaN(stampMs('nonsense')))
})
