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
import { reconcileChain, provesRound, ROUND_PROVING_REJECTIONS } from './loop-state.mjs'
import { findPriorRound, partialChainEvidence, checkpointDir, writeCheckpoint, stampMs } from './craft-log-run.mjs'

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

test('reconcileChain: a checkpoint directory NEWER than the newest complete round advances the round and carries the ledger we still have', () => {
  const complete = { found: true, round: 2, head: 'old', ledger: [{ fp: 'a' }], ledgerCount: 1, priorFindings: 3, journalSourced: false, reason: '' }
  const out = reconcileChain({ complete, completeAt: 100, evidence: { at: 200, head: 'newhead', findingsTotal: 6 } })
  assert.equal(out.round, 3, 'the run that died was round 3 — it read the same chain we just did')
  assert.equal(out.head, 'newhead')
  assert.equal(out.ledgerCount, 1, 'the lost round\'s ledger is gone; the one we still have is carried')
  assert.equal(out.priorFindings, 6, 'the DEAD run\'s own count, so the loss is legible rather than merely survived')
})

test('reconcileChain: an OLDER checkpoint directory does not displace the complete round', () => {
  const complete = { found: true, round: 2, head: 'h', ledger: [], ledgerCount: 0, priorFindings: 0, journalSourced: false, reason: '' }
  assert.equal(reconcileChain({ complete, completeAt: 500, evidence: { at: 100, head: 'x', findingsTotal: 9 } }), complete)
})

test('reconcileChain: a degraded round is never marked journalSourced — it carries no reconstructed findings', () => {
  assert.equal(reconcileChain({ proven: { round: 1, head: 'h', findingsTotal: 1 } }).journalSourced, false)
  assert.equal(reconcileChain({ evidence: { at: 1, head: 'h', findingsTotal: 1 } }).journalSourced, false)
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
  assert.equal(hit.ledger.length, 1, 'and the newest ledger that does survive is still carried forward')
  assert.equal(hit.ledger[0].fp, 'aaaa')
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

test('stampMs reads both the filename stamp and ordinary ISO, so the two populations compare on one clock', () => {
  assert.equal(stampMs('2026-07-10T00-00-00Z'), Date.parse('2026-07-10T00:00:00Z'))
  assert.equal(stampMs('2026-07-10T00:00:00Z'), Date.parse('2026-07-10T00:00:00Z'))
  assert.equal(stampMs('2026-07-10T00:00:00.123Z'), Date.parse('2026-07-10T00:00:00Z'))
  assert.ok(Number.isNaN(stampMs('nonsense')))
})
