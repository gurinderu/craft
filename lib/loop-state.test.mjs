// The loop state must outlive the telemetry record it used to ride on.
//
// Every test here is written against the measured failure, not against the code: a run files its
// record once, at the end, through a model, and two consecutive runs lost that record entirely (a
// network error; a 196KB payload). The chain then restarted at "round 1" with no sign of a refusal.
// So each case below asks the same question — the record is GONE or CORRUPT: does the next round
// still know a round happened, and does it say so?
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { reconcileChain, provesRound, ROUND_PROVING_REJECTIONS } from './loop-state.mjs'
import { findPriorRound, PRIOR_ROUND_NONE, checkpointRevision, partialChainEvidence, checkpointDir, writeCheckpoint, stampMs, recoverPartials } from './craft-log-run.mjs'
import { ENGINE_REVISION } from './run-record.mjs'

/**
 * What reconcileChain hands back once a test has established it is non-null: the engine-facing round.
 * @typedef {object} Decided
 * @property {boolean} found
 * @property {number} round
 * @property {string} head
 * @property {any[]} ledger
 * @property {number} ledgerCount
 * @property {number} priorFindings
 * @property {boolean} journalSourced
 * @property {boolean} sameFpBasis
 * @property {boolean} fpBasisKnown
 */

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
    `${prefix}\n;return { ledgerDegraded, ledgerTruncated, shouldFullRescan, PRIOR_ROUND_SCHEMA };`,
  )
  return factory({}, stub, stub, stub, stub, stub, budget, stub)
}
const { ledgerDegraded, ledgerTruncated, shouldFullRescan, PRIOR_ROUND_SCHEMA } = engineGuards()

// ---- tripwires: the two wirings in workflows/review.js that nothing can execute ----------------
//
// SAY IT PLAINLY: these are string matches, and a string match catches a DELETION, not a defect.
// They earn their place because the two things they watch are the runtime arms of everything above
// and neither is reachable from a test: both sit inside `reviewProfile`, a phase body of a script
// that cannot be imported (top-level export + await + return), and neither is extractable — one is
// an argument to the harness's own `checkpoint`, the other is shell text inside an agent prompt.
// Measured: removing either leaves the whole suite green.

test('TRIPWIRE: review.js stamps the round on every phase checkpoint', () => {
  const src = fs.readFileSync(path.join(root, 'workflows', 'review.js'), 'utf8')
  for (const phase of ['plan', 'lenses', 'verify']) {
    const at = src.indexOf('await checkpoint(`${profile.id}-' + phase + '`, {')
    assert.ok(at > 0, `expected a ${phase} checkpoint`)
    // The payload's first lines, where the identity fields sit.
    const head = src.slice(at, at + 400)
    assert.match(head, /round: thisRound/,
      `the ${phase} checkpoint must carry the round: recoverPartials reads it off the checkpoints and ` +
      'indexProjection writes `r.round ?? 0`, so without it one repair indexes the round as 0 and ' +
      'resets the chain to a first review. Nothing downstream can reconstruct it.')
  }
})

test('TRIPWIRE: review.js passes its own session id to the prior-round loader', () => {
  const src = fs.readFileSync(path.join(root, 'workflows', 'review.js'), 'utf8')
  const at = src.indexOf('prior-round --branch')
  assert.ok(at > 0, 'expected the prior-round dispatch')
  const line = src.slice(at, src.indexOf('\n', at))
  assert.match(line, /CLAUDE_CODE_SESSION_ID:\+--session/,
    'without --session, partialChainEvidence never learns who is asking and a RESUMED run reads its ' +
    'own unfinalized directory as a dead predecessor — the exclusion above is then dead at runtime. ' +
    'The `:+` form is load-bearing too: an unset id must pass NO flag, not an empty one.')
})

function tempRepo(branch = 'feat/x') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-loop-repo-')))
  /** @param {string[]} a */
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
  const out = /** @type {Decided} */ (reconcileChain({ proven: { round: 4, head: 'abc1234', findingsTotal: 7 } }))
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
  const out = /** @type {Decided} */ (reconcileChain({ complete, completeAt: 100, evidence: { at: 200, head: 'newhead', findingsTotal: 6 } }))
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
  assert.equal(/** @type {Decided} */ (reconcileChain({ proven: { round: 1, head: 'h', findingsTotal: 1 } })).journalSourced, false)
  // Evidence is the opposite: the head is where a run STOPPED and may equal the caller's HEAD.
  assert.equal(/** @type {Decided} */ (reconcileChain({ evidence: { at: 1, head: 'h', findingsTotal: 1 } })).journalSourced, true)
})

// ---- the seam: what the engine actually READS off that decision ---------------------------------

test('SEAM: a round read off checkpoints with no sharded ledger is DEGRADED in the engine, and forces a full re-scan', () => {
  const complete = { found: true, round: 2, head: 'old', ledger: [{ fp: 'a' }], ledgerCount: 1, priorFindings: 3, journalSourced: false, reason: '' }
  const out = /** @type {Decided} */ (reconcileChain({ complete, completeAt: 100, evidence: { at: 200, head: 'newhead', findingsTotal: 6 } }))
  assert.equal(ledgerDegraded(out), true, 'the engine must read this as a degraded round — that is the whole loudness')
  assert.equal(shouldFullRescan({ priorRound: out, thisRound: out.round + 1, fullEvery: 0, degraded: ledgerDegraded(out), journalSourced: out.journalSourced }), true,
    'and re-scan the full base...HEAD diff rather than a delta off a dead run\'s head')
})

test('SEAM: even a COMPLETE sharded carry still forces a full re-scan — the head belongs to the run that stopped', () => {
  const ledger = [{ fp: 'a' }, { fp: 'b' }]
  const out = /** @type {Decided} */ (reconcileChain({ complete: null, completeAt: NaN, evidence: { at: 200, head: 'h', findingsTotal: 2, ledger, ledgerTotal: 2 } }))
  assert.equal(ledgerTruncated(out), false, 'a complete carry is not a truncated one')
  assert.equal(ledgerDegraded(out), false, 'nor a degraded one — the round\'s own memory survived')
  // The head is still the stopped run's. A re-run on the same commit before any fix makes
  // head...HEAD empty, so an incremental round here would review nothing at all.
  assert.equal(shouldFullRescan({ priorRound: out, thisRound: out.round + 1, fullEvery: 0, degraded: false, journalSourced: out.journalSourced }), true)
})

test('SEAM: a SHORT sharded carry is read as truncated, so the shortfall is loud', () => {
  const out = /** @type {Decided} */ (reconcileChain({ evidence: { at: 200, head: 'h', findingsTotal: 5, ledger: [{ fp: 'a' }], ledgerTotal: 4 } }))
  assert.equal(out.ledgerCount, 4, 'the count the dead run DECLARED, not the array that survived')
  assert.equal(ledgerTruncated(out), true)
  assert.equal(ledgerDegraded(out), true)
})

test('SEAM: a lost TOMBSTONE row is caught by the same count check — a regression memory gap forces a re-scan, not a false novelty', () => {
  // The recidivism memory rides the ordinary ledger: a resolved/retired prior is a `disposition:'closed'`
  // row like any other, so it is COUNTED in ledgerTotal and its loss is visible for free. Here two live
  // rows and one tombstone were declared (ledgerTotal 3) but the tombstone did not survive transport
  // (array length 2). If that shortfall were not caught, the returning defect the tombstone remembered
  // would be re-discovered next round and reported as brand new. The count check catches it instead and
  // degrades the round to a full base...HEAD re-scan.
  const ledger = [
    { fp: 'a', disposition: 'open' },
    { fp: 'b', disposition: 'open' },
    // the tombstone that should have been here (fp 'c', disposition 'closed') was lost in transport
  ]
  const out = /** @type {Decided} */ (reconcileChain({ evidence: { at: 200, head: 'h', findingsTotal: 3, ledger, ledgerTotal: 3 } }))
  assert.equal(out.ledgerCount, 3, 'the count the dead run DECLARED, tombstone included')
  assert.equal(out.ledger.length, 2, 'but the tombstone row did not arrive')
  assert.equal(ledgerTruncated(out), true, 'so the ledger reads as truncated — a lost tombstone is a lost row like any other')
  assert.equal(ledgerDegraded(out), true)
  assert.equal(shouldFullRescan({ priorRound: out, thisRound: out.round + 1, fullEvery: 0, degraded: ledgerDegraded(out), journalSourced: out.journalSourced }), true,
    'the memory gap degrades to a full re-scan rather than silently reporting the returning defect as novel')
})

test('SEAM: control — an ordinary complete round stays incremental, so the guards above are not always-on', () => {
  const complete = { found: true, round: 2, head: 'old', ledger: [{ fp: 'a' }], ledgerCount: 1, priorFindings: 1, journalSourced: false, reason: '' }
  const out = /** @type {Decided} */ (reconcileChain({ complete, completeAt: 500, evidence: { at: 100, head: 'x', findingsTotal: 9 } }))
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
  t.onTestFinished(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
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
  t.onTestFinished(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
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
  t.onTestFinished(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
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
  // Checkpoints carry the revision of the logger that wrote them (realm @nick/craft #112), and these
  // were written by this engine — so the round's basis is established and the same. A directory from a
  // craft that stamped none stays unknown (see the #112 tests below).
  assert.deepEqual([hit.sameFpBasis, hit.fpBasisKnown], [true, true],
    'checkpoints written by this engine establish its basis — the recovered round keeps its memory')
})

test('a checkpoint directory belonging to ANOTHER project is not this chain\'s evidence', (t) => {
  const store = tmpStore()
  const { dir: project } = tempRepo('feat/x')
  const { dir: other } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project, other].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: other, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x' }, { project: other })
  assert.deepEqual(partialChainEvidence({ store, project, branch: 'feat/x' }), [])
  assert.equal(findPriorRound({ store, project, branch: 'feat/x' }).found, false)
})

test('a checkpoint directory on ANOTHER branch is not this chain\'s evidence', (t) => {
  const store = tmpStore()
  const { dir: project } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'other' }, { project })
  assert.deepEqual(partialChainEvidence({ store, project, branch: 'feat/x' }), [])
})

test('BACK-COMPAT: a legacy checkpoint directory that predates the identity fields is skipped, never guessed at', (t) => {
  const store = tmpStore()
  const { dir: project } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  // 13 of the 57 directories in the live store look exactly like this: checkpoints with no `project`.
  const dir = path.join(store, '.partial', '2026-07-11T00-00-00Z-workflow-review')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '00-rust-plan.json'), JSON.stringify({ phase: 'rust-plan', branch: 'feat/x', head: 'main' }))
  assert.deepEqual(partialChainEvidence({ store, project, branch: 'feat/x' }), [])
})

test('BACK-COMPAT: an accumulated store of ordinary completed rounds still reads exactly as before', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
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
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  fs.writeFileSync(path.join(store, 'index.jsonl'), '')
  const hit = findPriorRound({ store, project, branch: 'feat/new' })
  assert.equal(hit.found, false)
  assert.equal(hit.reason, 'no-candidate-rows')
})

test('BACK-COMPAT: a rebased-away round is still rejected, not resurrected as degraded', (t) => {
  const store = tmpStore()
  const { dir: project } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
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
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
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
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
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
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
    JSON.stringify({ round: 2, head, ledger: [], findings: { total: 0 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 2 }) + '\n')
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head: 'aaaaaaa' }, { project })
  writeCheckpoint(dir, 'rust-lenses', { branch: 'feat/x', head: 'bbbbbbb' }, { project })
  const ev = partialChainEvidence({ store, project, branch: 'feat/x' })
  assert.equal(ev.length, 1)
  assert.ok(ev[0])
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
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head, round: 7 }, { project })
  const out = recoverPartials({ store, project })
  assert.equal(out.length, 1)
  assert.ok(out[0])
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
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  // A directory written before `round` rode on the checkpoints. Promoting it files a row indexed as
  // round 0 — which reads as no round at all — so deleting the directory would destroy the only
  // witness left (partialChainEvidence reads exactly these) and leave the chain worse than the loss.
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head, findings: { total: 4 } }, { project })
  const first = recoverPartials({ store, project })
  assert.equal(first.length, 1)
  assert.ok(first[0])
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

// A dead run that `recover` already promoted is the case the seam tests above do not reach: the
// directory is gone, so there is no evidence, and the chain is proved by the `partial: true` record
// alone. A run that died before its first findings-bearing checkpoint files `findings.total: 0` —
// and a zero count is the one shape `ledgerDegraded` cannot see, because the only form it reads is
// "findings present, ledger empty". The live store holds 57 such directories.
test('SEAM: a partial-only round with ZERO findings is still not diffed off the head where the run stopped', () => {
  const out = /** @type {Decided} */ (reconcileChain({ proven: { reason: 'partial-only', round: 4, head: 'deadhead', findingsTotal: 0 } }))
  assert.equal(out.found, true)
  assert.equal(ledgerDegraded(out), false, 'a zero count beside an empty ledger is invisible to this guard — that is the premise, not the defect')
  assert.equal(out.journalSourced, true, 'so the OTHER flag has to carry it: this head is where the run halted')
  assert.equal(shouldFullRescan({ priorRound: out, thisRound: out.round + 1, fullEvery: 0, degraded: ledgerDegraded(out), journalSourced: out.journalSourced }), true,
    'without this the round diffs off a stopped head, and on a re-run at the same commit that delta is EMPTY — zero lenses, reported as an ordinary incremental round')
})

test('SEAM: a detail-unreadable round MAY be diffed off its head — that round finished', () => {
  const out = /** @type {Decided} */ (reconcileChain({ proven: { reason: 'detail-unreadable', round: 4, head: 'completedhead', findingsTotal: 0 } }))
  assert.equal(out.journalSourced, false, 'only the damaged detail is missing; the round itself completed at this head')
  assert.equal(shouldFullRescan({ priorRound: out, thisRound: out.round + 1, fullEvery: 0, degraded: ledgerDegraded(out), journalSourced: out.journalSourced }), false,
    'forcing a full re-scan here would pay the whole diff for a damaged file, which is the over-correction')
})

test('a partial-only round carries the ledger its shards left INSIDE the record, and says how much', () => {
  const ledger = [{ fp: 'a' }, { fp: 'b' }]
  const out = /** @type {Decided} */ (reconcileChain({ proven: { reason: 'partial-only', round: 5, head: 'h', findingsTotal: 9, ledger, ledgerTotal: 2 } }))
  assert.equal(out.ledger.length, 2, 'recover consumed the directory, but the shards it copied into the record are still readable')
  assert.equal(out.ledgerCount, 2)
  assert.equal(ledgerTruncated(out), false, 'a complete carry does not read as a shortfall')
})

test('a partial-only round whose shards are SHORT reads as truncated, not as a whole one', () => {
  const out = /** @type {Decided} */ (reconcileChain({ proven: { reason: 'partial-only', round: 5, head: 'h', findingsTotal: 9, ledger: [{ fp: 'a' }], ledgerTotal: 7 } }))
  assert.equal(ledgerTruncated(out), true, 'six entries never landed and the engine has to be told')
})

// ---- finding 4: the fingerprint-basis guard must act on the RECOVERY paths too ------------------
//
// `priorFpComparable = priorRound.sameFpBasis === true` (workflows/review.js): only an explicit true is
// comparable, and an absent field fails closed. A round RECONSTRUCTED from a dead run (evidence
// checkpoints, or a proven partial/detail-unreadable record) carries a ledger — tombstones —
// fingerprinted under whatever basis the dead run used; if the operator upgraded across a basis change
// between the stall and the recovery, comparing those hashes to this round's silently misses a
// regression. So every construction path must DETERMINE the field: compute it from the record's
// revision where the record is in hand (sameFpBasis in run-record.mjs), and set it false where the
// revision cannot be established.

test('reconcileChain: a recovered round DETERMINES sameFpBasis on every branch, defaulting false (finding 4)', () => {
  // Evidence that does not carry a basis verdict (checkpoints that stamped no revision) cannot establish
  // comparability: present and false, not absent. `undefined` would read as comparable in the guard;
  // `false` makes it skip.
  const ev = /** @type {Decided} */ (reconcileChain({ evidence: { at: 200, head: 'h', findingsTotal: 1 } }))
  assert.equal(ev.sameFpBasis, false, 'checkpoints establish no revision → not comparable, and it SAYS so')
  assert.equal(/** @type {boolean} */ (ev.sameFpBasis) === true, false, 'so priorFpComparable derives false: the guard skips, it is not bypassed')
  // Proven propagates whatever comparability craft-log-run computed from the record it still had.
  const pOld = /** @type {Decided} */ (reconcileChain({ proven: { reason: 'partial-only', round: 4, head: 'h', findingsTotal: 1, sameFpBasis: false } }))
  assert.equal(pOld.sameFpBasis, false)
  const pSame = /** @type {Decided} */ (reconcileChain({ proven: { reason: 'partial-only', round: 4, head: 'h', findingsTotal: 1, sameFpBasis: true } }))
  assert.equal(pSame.sameFpBasis, true, 'a recovery that CAN prove the revision stays comparable — the guard does not over-skip')
})

test('findPriorRound: a partial-only round recovered ACROSS a fingerprint-basis change is not comparable (finding 4)', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  // A dead run's record: partial, no journal ledger → the partial-only recovery path. Its engineRevision
  // (2) predates this engine's fp basis: the operator upgraded across a basis change between the stall
  // and this recovery re-review.
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
    JSON.stringify({ partial: true, round: 3, head, engineRevision: 2, findings: { total: 2 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 3, findingsTotal: 2 }) + '\n')
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true, 'the round is recovered, not lost')
  assert.equal(hit.sameFpBasis, false, 'the dead run used an older fp basis — its fingerprints are not comparable to this round\'s')
  assert.equal(/** @type {boolean} */ (hit.sameFpBasis) === true, false, 'so priorFpComparable is false: the recidivism check is skipped, not run across incompatible bases')
})



// realm @nick/craft #110: the loader says not only whether the basis matches but whether it could be
// established at all — the engine reports the second as lost memory rather than a basis change.
test('reconcileChain: an evidence-recovered round says its basis could not be established', () => {
  const ev = /** @type {Decided} */ (reconcileChain({ evidence: { at: 200, head: 'h', findingsTotal: 1 } }))
  assert.equal(ev.fpBasisKnown, false)
  const p = /** @type {Decided} */ (reconcileChain({ proven: { reason: 'partial-only', round: 4, head: 'h', findingsTotal: 1, sameFpBasis: false, fpBasisKnown: true } }))
  assert.equal(p.fpBasisKnown, true, 'a proven round that had its record passes the loader\'s answer through')
})


// The other two directions of the partial-only branch, and the detail-unreadable branch: each must
// say its basis could NOT be established, or the engine logs a stall-and-recover as an expected reset
// and #110's silent loss is back behind a green suite.
test('findPriorRound: a partial-only round with no revision, or a newer one, cannot establish its basis', (t) => {
  for (const [label, rev] of /** @type {[string, number | undefined][]} */ ([['no revision', undefined], ['a newer revision', ENGINE_REVISION + 1]])) {
    const store = tmpStore()
    const { dir: project, head } = tempRepo('feat/x')
    t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
    /** @type {Record<string, any>} */
    const rec = { partial: true, round: 3, head, findings: { total: 2 } }
    if (rev !== undefined) rec['engineRevision'] = rev
    fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'), JSON.stringify(rec))
    fs.writeFileSync(path.join(store, 'index.jsonl'),
      JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 3, findingsTotal: 2 }) + '\n')
    const hit = findPriorRound({ store, project, branch: 'feat/x' })
    assert.equal(hit.found, true, `${label}: premise — the round is recovered`)
    assert.deepEqual([hit.sameFpBasis, hit.fpBasisKnown], [false, false], label)
  }
})

test('findPriorRound: a round proven only by its index row (detail unreadable) cannot establish its basis', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'), '{ not json')
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 3, findingsTotal: 2 }) + '\n')
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true, 'premise: the round is proven by its row')
  assert.deepEqual([hit.sameFpBasis, hit.fpBasisKnown], [false, false])
})

// realm @nick/craft #110: a `partial: true` record is written by `recover` / `from-journal`, which
// stamp the RECOVERING craft's engineRevision — the fingerprints inside were written by the run that
// stopped. So whatever revision the record carries, the basis of its fingerprints is unknown: stall,
// upgrade, recover would otherwise claim the new basis for old fingerprints and miss a regression.
test('findPriorRound: a recovered (partial) round without its run\'s revision never claims a basis, whatever revision stamped the record', (t) => {
  for (const rev of [2, 3, ENGINE_REVISION]) {
    const store = tmpStore()
    const { dir: project, head } = tempRepo('feat/x')
    t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
    fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
      JSON.stringify({ partial: true, round: 3, head, engineRevision: rev, findings: { total: 2 } }))
    fs.writeFileSync(path.join(store, 'index.jsonl'),
      JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 3, findingsTotal: 2 }) + '\n')
    const hit = findPriorRound({ store, project, branch: 'feat/x' })
    assert.equal(hit.found, true, `r${rev}: premise — the round is recovered`)
    assert.deepEqual([hit.sameFpBasis, hit.fpBasisKnown], [false, false], `r${rev}: the stamp is the recoverer's, not the basis`)
  }
})

test('findPriorRound: a journal-recovered partial round never claims a fingerprint basis either', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const ledger = [{ fp: 'aaaa', title: 't', file: 'f', symbol: 's', ruleId: '', severity: 'High', disposition: 'open', round: 1, why: 'w' }]
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
    JSON.stringify({ partial: true, ledgerSource: 'journal', ledger, round: 3, head, engineRevision: ENGINE_REVISION, findings: { total: 1 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 3, findingsTotal: 1 }) + '\n')
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.journalSourced, true, 'premise: the journal-ledger path was taken')
  assert.deepEqual([hit.sameFpBasis, hit.fpBasisKnown], [false, false])
})

// The loader's answer crosses a model under PRIOR_ROUND_SCHEMA (additionalProperties: false). A key the
// loader emits that the schema does not declare cannot survive the relay — it is silently dropped, and
// for the basis fields that turns every real basis change into reported lost memory. So every key the
// loader can emit must be a declared property (realm @nick/craft #110).
test('SEAM: every key the prior-round loader emits is declared in the engine\'s transport schema', (t) => {
  const declared = new Set(Object.keys(PRIOR_ROUND_SCHEMA.properties))
  for (const k of Object.keys(PRIOR_ROUND_NONE)) assert.ok(declared.has(k), `PRIOR_ROUND_NONE.${k} is declared`)
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
    JSON.stringify({ round: 2, head, engineRevision: ENGINE_REVISION, ledger: [], findings: { total: 0 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 2 }) + '\n')
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true, 'premise: a found answer')
  for (const k of Object.keys(hit)) assert.ok(declared.has(k), `found answer .${k} is declared`)
})

// ---- realm @nick/craft #112: a recovered round keeps its memory when its basis is known ----------
// Each checkpoint is stamped with the engine revision of the logger that wrote it — the same logger,
// and so the same source of truth, that stamps a run's final record. Recovery keeps that revision
// apart from its own stamp, and the loader decides the recovered round's basis by it.
/**
 * @param {string} dir
 * @param {number | undefined} rev
 */
const restamp = (dir, rev) => {
  for (const f of fs.readdirSync(dir).filter(f => /^\d\d-.*\.json$/.test(f))) {
    const p = path.join(dir, f)
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (rev === undefined) delete j.engineRevision
    else j.engineRevision = rev
    fs.writeFileSync(p, JSON.stringify(j))
  }
}

test('writeCheckpoint stamps the engine revision, and a payload cannot shadow it', (t) => {
  const store = tmpStore()
  t.onTestFinished(() => fs.rmSync(store, { recursive: true, force: true }))
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project: '/p', now: new Date('2026-07-11T00:00:00Z') })
  const file = writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', engineRevision: 1 }, { project: '/p' })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).engineRevision, ENGINE_REVISION)
})

test('recover keeps the run\'s own revision apart from its stamp, and the round keeps a same-basis memory', (t) => {
  for (const [label, rev, expect] of /** @type {[string, number | undefined, boolean[]][]} */ ([
    ['same basis, older revision', 3, [true, true]],
    ['an older basis', 2, [false, true]],
    ['checkpoints from a craft that stamped none', undefined, [false, false]],
  ])) {
    const store = tmpStore()
    const { dir: project, head } = tempRepo('feat/x')
    t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
    const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
    writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head, round: 3 }, { project })
    restamp(dir, rev)   // the run that stopped was this revision (or stamped none)
    const out = recoverPartials({ store, project })   // recovered by THIS engine
    assert.ok(out[0])
    const rec = JSON.parse(fs.readFileSync(out[0].file, 'utf8'))
    assert.equal(rec.engineRevision, ENGINE_REVISION, `${label}: premise — the record carries the recoverer's stamp`)
    assert.equal(rec.runEngineRevision, rev, `${label}: and the run's own revision, apart`)
    const hit = findPriorRound({ store, project, branch: 'feat/x' })
    assert.equal(hit.found, true, `${label}: premise — the round is recovered`)
    assert.deepEqual([hit.sameFpBasis, hit.fpBasisKnown], expect, label)
  }
})

test('recover does not claim a run revision its checkpoints disagree about', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head, round: 3 }, { project })
  writeCheckpoint(dir, 'rust-lenses', { branch: 'feat/x', head, round: 3 }, { project })
  const files = fs.readdirSync(dir).filter(f => /^\d\d-.*\.json$/.test(f)).sort()
  const p = path.join(dir, /** @type {string} */ (files[0])); const j = JSON.parse(fs.readFileSync(p, 'utf8')); j.engineRevision = 2; fs.writeFileSync(p, JSON.stringify(j))
  const out = recoverPartials({ store, project })
  assert.ok(out[0])
  assert.equal(JSON.parse(fs.readFileSync(out[0].file, 'utf8')).runEngineRevision, undefined, 'a disagreement is no revision')
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.deepEqual([hit.sameFpBasis, hit.fpBasisKnown], [false, false])
})

test('an unrecovered checkpoint directory (evidence) decides its basis by its checkpoints too', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head, round: 3 }, { project })
  restamp(dir, 3)
  const ev = partialChainEvidence({ store, project, branch: 'feat/x' })
  assert.ok(ev[0])
  assert.deepEqual([ev[0].sameFpBasis, ev[0].fpBasisKnown], [true, true])
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true, 'premise: the evidence round is adopted')
  assert.deepEqual([hit.sameFpBasis, hit.fpBasisKnown], [true, true])
})

// Per-checkpoint revisions, for directories a run wrote under more than one engine.
/**
 * @param {string} dir
 * @param {(number | undefined)[]} revs
 */
const restampEach = (dir, revs) => {
  const files = fs.readdirSync(dir).filter(f => /^\d\d-.*\.json$/.test(f)).sort()
  files.forEach((f, i) => {
    const p = path.join(dir, f)
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (revs[i] === undefined) delete j.engineRevision
    else j.engineRevision = revs[i]
    fs.writeFileSync(p, JSON.stringify(j))
  })
}

// The fail-closed side of the evidence path, and the case a revision-agreement rule gets wrong: a run
// resumed after a telemetry-only bump (r3 then r4, one basis) keeps its memory; a directory whose
// checkpoints span two BASES, or stamp none, does not.
test('evidence and recovery agree on the BASIS the checkpoints attest to, not the raw revision', (t) => {
  for (const [label, revs, expect] of /** @type {[string, (number | undefined)[], boolean[]][]} */ ([
    ['resumed across a telemetry-only bump (r3, r4)', [3, 4], [true, true]],
    ['an older basis throughout (r2, r2)', [2, 2], [false, true]],
    ['two bases (r2, r3)', [2, 3], [false, false]],
    ['no revision stamped', [undefined, undefined], [false, false]],
    ['a newer engine wrote one of them (r4, r5)', [ENGINE_REVISION, ENGINE_REVISION + 1], [false, false]],
    ['a newer engine wrote them all', [ENGINE_REVISION + 1, ENGINE_REVISION + 1], [false, false]],
  ])) {
    for (const via of ['evidence', 'recover']) {
      const store = tmpStore()
      const { dir: project, head } = tempRepo('feat/x')
      t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
      const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
      writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head, round: 3 }, { project })
      writeCheckpoint(dir, 'rust-lenses', { branch: 'feat/x', head, round: 3 }, { project })
      restampEach(dir, revs)
      if (via === 'recover') recoverPartials({ store, project })
      const hit = findPriorRound({ store, project, branch: 'feat/x' })
      assert.equal(hit.found, true, `${label} via ${via}: premise — the round is found`)
      assert.deepEqual([hit.sameFpBasis, hit.fpBasisKnown], expect, `${label} via ${via}`)
    }
  }
})

// The contract itself, so that what keeps a downgrade fail-closed is the rule and not which member of
// an agreeing set happens to be returned.
test('checkpointRevision: null unless every checkpoint is readable, stamped with a known revision, on one basis', () => {
  const R = ENGINE_REVISION
  assert.equal(checkpointRevision([{ engineRevision: 3 }, { engineRevision: R }]), R, 'one basis across a telemetry-only bump: the highest')
  assert.equal(checkpointRevision([{ engineRevision: 2 }, { engineRevision: 2 }]), 2, 'an older basis is still a known one')
  assert.equal(checkpointRevision([{ engineRevision: R }, { engineRevision: R + 1 }]), null, 'a newer revision is a basis this engine cannot place')
  assert.equal(checkpointRevision([{ engineRevision: 2 }, { engineRevision: 3 }]), null, 'two bases')
  assert.equal(checkpointRevision([{ engineRevision: R }, {}]), null, 'a slice with no stamp')
  assert.equal(checkpointRevision([{ engineRevision: R }, { phase: 'x', unreadable: 'torn' }]), null, 'a slice that cannot be read cannot attest')
  assert.equal(checkpointRevision([/** @type {any} */ (null), { engineRevision: R }]), null, 'a checkpoint whose JSON is null does not throw')
  assert.equal(checkpointRevision([]), null)
})

test('findPriorRound: a journal-recovered partial round decides its basis by runEngineRevision too', (t) => {
  for (const [label, run, expect] of /** @type {[string, number | undefined, boolean[]][]} */ ([['same basis', 3, [true, true]], ['older basis', 2, [false, true]], ['none', undefined, [false, false]]])) {
    const store = tmpStore()
    const { dir: project, head } = tempRepo('feat/x')
    t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
    const ledger = [{ fp: '', title: 't', file: 'f', symbol: 's', ruleId: '', severity: 'High', disposition: 'open', round: 1, why: 'w' }]
    /** @type {Record<string, any>} */
    const rec = { partial: true, ledgerSource: 'journal', ledger, round: 3, head, engineRevision: ENGINE_REVISION, findings: { total: 1 } }
    if (run !== undefined) rec['runEngineRevision'] = run
    fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'), JSON.stringify(rec))
    fs.writeFileSync(path.join(store, 'index.jsonl'),
      JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 3, findingsTotal: 1 }) + '\n')
    const hit = findPriorRound({ store, project, branch: 'feat/x' })
    assert.equal(hit.journalSourced, true, `${label}: premise — the journal-ledger path`)
    assert.deepEqual([hit.sameFpBasis, hit.fpBasisKnown], expect, label)
  }
})

// Recovery judged the checkpoints under the RECOVERING craft's table; a reader that knows more must be
// able to re-decide from the record's own phases rather than inherit the recoverer's ceiling.
test('findPriorRound: a partial record without runEngineRevision is re-decided from its own checkpoints', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const phases = [{ phase: 'rust-plan', engineRevision: 3, branch: 'feat/x', head }, { phase: 'rust-lenses', engineRevision: ENGINE_REVISION, branch: 'feat/x', head }]
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
    JSON.stringify({ partial: true, phases, round: 3, head, engineRevision: 2, findings: { total: 2 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 3, findingsTotal: 2 }) + '\n')
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.deepEqual([hit.sameFpBasis, hit.fpBasisKnown], [true, true], 'the phases attest to this basis, whatever an older recoverer could judge')
})

// ---- realm @nick/craft #111: the loader hands over RAW revisions; the engine decides ----------------
test('findPriorRound: priorFpRevisions prefers the engine\'s own revision over the logger\'s stamp', (t) => {
  for (const [label, rec, expect] of /** @type {[string, Record<string, number>, number[]][]} */ ([
    ['engine and logger differ', { engineRevision: 9, workflowEngineRevision: 3 }, [3]],
    ['an engine that stamped none', { engineRevision: 3 }, [3]],
    ['no revision at all', {}, []],
  ])) {
    const store = tmpStore()
    const { dir: project, head } = tempRepo('feat/x')
    t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
    fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
      JSON.stringify({ round: 2, head, ledger: [], findings: { total: 0 }, ...rec }))
    fs.writeFileSync(path.join(store, 'index.jsonl'),
      JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 2 }) + '\n')
    const hit = findPriorRound({ store, project, branch: 'feat/x' })
    assert.deepEqual(hit.priorFpRevisions, expect, label)
    assert.equal(hit.priorFpRevisionsCheck, expect.join(','), `${label}: and its transport check`)
  }
})

test('findPriorRound: a recovered round hands over its checkpoints\' raw revisions, the engine\'s first', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const phases = [
    { phase: 'a', engineRevision: 9, workflowEngineRevision: 3, branch: 'feat/x', head },
    { phase: 'b', engineRevision: 9, workflowEngineRevision: 3, branch: 'feat/x', head },
  ]
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
    JSON.stringify({ partial: true, phases, round: 3, head, engineRevision: 9, findings: { total: 1 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 3, findingsTotal: 1 }) + '\n')
  assert.deepEqual(findPriorRound({ store, project, branch: 'feat/x' }).priorFpRevisions, [3])
})

test('findPriorRound: a live checkpoint directory hands over the engine\'s raw revisions too', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head, round: 3, workflowEngineRevision: 3 }, { project })
  writeCheckpoint(dir, 'rust-lenses', { branch: 'feat/x', head, round: 3, workflowEngineRevision: 3 }, { project })
  restampEach(dir, [9, 9])   // a logger from another install stamped these
  const ev = partialChainEvidence({ store, project, branch: 'feat/x' })
  assert.ok(ev[0])
  assert.deepEqual(ev[0].priorFpRevisions, [3], 'the evidence carries the engine\'s revision, not the logger\'s')
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true, 'premise: the evidence round is adopted')
  assert.deepEqual(hit.priorFpRevisions, [3], 'and reconcileChain passes it through to the engine')
  assert.equal(hit.priorFpRevisionsCheck, '3', 'with its transport check')
})
