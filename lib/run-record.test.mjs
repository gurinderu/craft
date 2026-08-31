import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  countBySeverity, summarizeFindings, worstVerdict, reviewVerdict, refuteRate, indexProjection, selectPriorRounds,
  tallyVerdicts, titleShingle, fingerprint, shingleOverlap, matchesPrior,
  dispositionFromTriage, rereviewVerdict,
} from './run-record.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findPriorRound, PRIOR_ROUND_NONE } from './craft-log-run.mjs'

const CLI = fileURLToPath(new URL('./craft-log-run.mjs', import.meta.url))

// A throwaway git repo with one commit. Every prior-round test needs real ancestry, and none of
// them may depend on the ambient checkout — outside one, an ambient test ERRORS instead of failing.
function tempRepo(branch = 'feat/x') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-repo-')))
  const g = a => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  g(['init', '-q', '-b', branch])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a'), '1'); g(['add', 'a']); g(['commit', '-qm', 'one'])
  return { dir, head: g(['rev-parse', '--short', 'HEAD']) }
}

test('countBySeverity tallies known severities, ignores unknown and malformed', () => {
  assert.deepEqual(
    countBySeverity([{ severity: 'Critical' }, { severity: 'Critical' }, { severity: 'Low' }, { severity: 'Bogus' }, {}]),
    { Critical: 2, High: 0, Medium: 0, Low: 1, Info: 0 },
  )
})

test('countBySeverity tolerates non-array input', () => {
  assert.deepEqual(countBySeverity(null), { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 })
})

test('summarizeFindings totals across severities', () => {
  const got = summarizeFindings([{ severity: 'High' }, { severity: 'Info' }, { severity: 'High' }])
  assert.equal(got.total, 3)
  assert.equal(got.bySeverity.High, 2)
})

test('worstVerdict picks the worst across mixed vocabularies', () => {
  assert.equal(worstVerdict(['Approve', 'Concerns', 'At-risk']), 'Block')
  assert.equal(worstVerdict(['Approve', 'Warning']), 'Warning')
  assert.equal(worstVerdict(['Approve', 'Healthy', 'Clean']), 'Approve')
  assert.equal(worstVerdict(['UB-found']), 'Block')
  // An unrecognised verdict must never aggregate into the most permissive outcome: a persisted
  // `INCOMPLETE (...)` folded back into `Approve` would rebuild the overclaim one layer up.
  assert.equal(worstVerdict(['Approve', 'INCOMPLETE (no language profile)']), 'Warning')
  assert.equal(worstVerdict(['Approve (INCOMPLETE)']), 'Warning')
  assert.equal(worstVerdict(['Approve', 'wat']), 'Warning')
  assert.equal(worstVerdict(['Approve', null]), 'Warning')
})

test('worstVerdict over an empty set is INCOMPLETE, never Approve', () => {
  // Zero verdicts means every dimension died or nothing ran — the absence of evidence, not consensus.
  // Approve here would render a total outage as a pass.
  assert.match(worstVerdict([]), /INCOMPLETE/)
  assert.match(worstVerdict(null), /INCOMPLETE/)
  assert.match(worstVerdict('not an array'), /INCOMPLETE/)
  // and it must not fold back into green one layer up
  assert.equal(worstVerdict([worstVerdict([])]), 'Warning')
})

test('reviewVerdict is driven by confirmed severities', () => {
  assert.equal(reviewVerdict([{ severity: 'High' }]), 'Block')
  assert.equal(reviewVerdict([{ severity: 'Medium' }]), 'Warning')
  assert.equal(reviewVerdict([{ severity: 'Low' }, { severity: 'Info' }]), 'Approve')
  assert.equal(reviewVerdict([]), 'Approve')
})

test('refuteRate is the dropped fraction, 2-dp, safe at zero', () => {
  assert.equal(refuteRate(4, 1), 0.75)
  assert.equal(refuteRate(2, 2), 0)
  assert.equal(refuteRate(0, 0), 0)
  assert.equal(refuteRate(3, 0), 1)
})

test('tallyVerdicts buckets dispositions, ignores unknown and malformed', () => {
  assert.deepEqual(
    tallyVerdicts([
      { verdict: 'accept' }, { verdict: 'accept' }, { verdict: 'reject' },
      { verdict: 'defer' }, { verdict: 'needs-decision' }, { verdict: 'conflict' },
      { verdict: 'bogus' }, {},
    ]),
    { accept: 2, reject: 1, defer: 1, 'needs-decision': 1, conflict: 1 },
  )
})

test('tallyVerdicts tolerates non-array input', () => {
  assert.deepEqual(tallyVerdicts(null), { accept: 0, reject: 0, defer: 0, 'needs-decision': 0, conflict: 0 })
})

test('indexProjection keeps only summary fields and passes runtime through', () => {
  const rec = {
    schemaVersion: 1, runtime: 'claude-code', ts: 'T', kind: 'workflow', name: 'rust-audit',
    project: '/p', commit: 'abc', dirty: false,
    verdict: 'Warning', findings: { total: 5, bySeverity: {} }, nested: true, via: 'rust-audit',
    outputTokens: 1234, dimensions: [{ dimension: 'security' }], scout: { x: 1 },
  }
  assert.deepEqual(indexProjection(rec), {
    schemaVersion: 1, runtime: 'claude-code', ts: 'T', kind: 'workflow', name: 'rust-audit',
    craftVersion: null, craftCommit: null,
    project: '/p', commit: 'abc', dirty: false,
    branch: null, head: null, round: 0,
    verdict: 'Warning', findingsTotal: 5, nested: true, via: 'rust-audit', outputTokens: 1234,
  })
})

test('titleShingle normalizes, sorts, and is word-order independent', () => {
  assert.equal(titleShingle('Lock held across .await'), 'across await held lock')
  assert.equal(titleShingle('await held lock across'), 'across await held lock')
  assert.equal(titleShingle(null), '')
})

test('fingerprint is deterministic and ignores title word order', () => {
  const a = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'Lock held across await' }
  const b = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'await across held Lock' }
  assert.equal(fingerprint(a), fingerprint(b))
  assert.match(fingerprint(a), /^[0-9a-f]{8}$/)
})

test('fingerprint separates on file, symbol, and ruleId', () => {
  const base = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'x' }
  assert.notEqual(fingerprint(base), fingerprint({ ...base, file: 'src/other.rs' }))
  assert.notEqual(fingerprint(base), fingerprint({ ...base, symbol: 'Foo::baz' }))
  assert.notEqual(fingerprint(base), fingerprint({ ...base, ruleId: 'CON-004' }))
})

test('shingleOverlap is 1 for identical, 0 for disjoint, fractional for partial', () => {
  assert.equal(shingleOverlap('lock across await', 'await across lock'), 1)
  assert.equal(shingleOverlap('lock across await', 'unrelated other words'), 0)
  assert.ok(shingleOverlap('lock held across await', 'lock across await') > 0.5)
  assert.equal(shingleOverlap('', 'anything'), 0)
})

test('matchesPrior requires same file+ruleId and a title above threshold', () => {
  const prior = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'Lock held across await' }
  assert.ok(matchesPrior({ ...prior, line: 99, title: 'lock across await held' }, prior))
  assert.ok(!matchesPrior({ ...prior, file: 'src/other.rs' }, prior))
  assert.ok(!matchesPrior({ ...prior, ruleId: 'CON-004' }, prior))
  assert.ok(!matchesPrior({ ...prior, title: 'completely different unrelated defect here' }, prior))
})

test('matchesPrior treats a moved symbol as the same finding when file+ruleId+title hold', () => {
  const prior = { file: 'src/foo.rs', symbol: '', ruleId: 'SAF-002', title: 'unwrap on reachable path' }
  assert.ok(matchesPrior({ file: 'src/foo.rs', symbol: 'Foo::run', ruleId: 'SAF-002', title: 'unwrap on reachable path' }, prior))
})

test('dispositionFromTriage maps triage verdicts to ledger dispositions', () => {
  assert.equal(dispositionFromTriage('reject'), 'rejected')
  assert.equal(dispositionFromTriage('defer'), 'deferred')
  assert.equal(dispositionFromTriage('accept'), 'open')
  assert.equal(dispositionFromTriage('needs-decision'), 'open')
  assert.equal(dispositionFromTriage('conflict'), 'open')
  assert.equal(dispositionFromTriage('garbage'), 'open')
})

test('rereviewVerdict weighs only still-open, regressed, and new findings', () => {
  assert.equal(rereviewVerdict({ stillOpen: [], regressed: [], neu: [] }), 'Approve')
  assert.equal(rereviewVerdict({ stillOpen: [{ severity: 'Medium' }] }), 'Warning')
  assert.equal(rereviewVerdict({ regressed: [{ severity: 'High' }] }), 'Block')
  assert.equal(rereviewVerdict({ neu: [{ severity: 'Critical' }], stillOpen: [{ severity: 'Low' }] }), 'Block')
})

test('indexProjection carries branch/head/round', () => {
  const p = indexProjection({ schemaVersion: 1, ts: 't', kind: 'workflow', name: 'review', project: '/p', branch: 'feat/x', head: 'abc123', round: 2, verdict: 'Approve' })
  assert.equal(p.branch, 'feat/x')
  assert.equal(p.head, 'abc123')
  assert.equal(p.round, 2)
})

test('indexProjection defaults branch/head/round when absent', () => {
  const p = indexProjection({ schemaVersion: 1, ts: 't', kind: 'workflow', name: 'review', project: '/p', verdict: 'Approve' })
  assert.equal(p.branch, null)
  assert.equal(p.head, null)
  assert.equal(p.round, 0)
})

// The engine's own identity has to reach index.jsonl, because that is the file an aggregate is
// filtered on. Without it every comparison silently averages across rubric versions.
test('indexProjection carries craftVersion/craftCommit into the index line', () => {
  const p = indexProjection({ schemaVersion: 1, ts: 't', kind: 'workflow', name: 'review', project: '/p', craftVersion: '0.13.1', craftCommit: 'abc1234', verdict: 'Approve' })
  assert.equal(p.craftVersion, '0.13.1')
  assert.equal(p.craftCommit, 'abc1234')
})

test('indexProjection nulls craftVersion/craftCommit for records that predate them', () => {
  const p = indexProjection({ schemaVersion: 1, ts: 't', kind: 'workflow', name: 'review', project: '/p', verdict: 'Approve' })
  assert.equal(p.craftVersion, null, 'null, not undefined — the key must exist so a filter can see it is unknown')
  assert.equal(p.craftCommit, null)
  assert.ok('craftVersion' in p && 'craftCommit' in p, 'keys present even when unknown')
})

test('selectPriorRounds ranks matching reviews for the branch newest-first', () => {
  const idx = [
    { ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project: '/p', branch: 'feat/x' },
    { ts: '2026-07-12T00-00-00Z', kind: 'workflow', name: 'review', project: '/p', branch: 'feat/x' },
    { ts: '2026-07-13T00-00-00Z', kind: 'workflow', name: 'review', project: '/p', branch: 'other' },
    { ts: '2026-07-11T00-00-00Z', kind: 'workflow', name: 'rust-audit', project: '/p', branch: 'feat/x' },
    { ts: '2026-07-14T00-00-00Z', kind: 'workflow', name: 'review', project: '/OTHER', branch: 'feat/x' },
  ]
  assert.deepEqual(
    selectPriorRounds(idx, { project: '/p', branch: 'feat/x' }).map(e => e.ts),
    ['2026-07-12T00-00-00Z', '2026-07-10T00-00-00Z'],
    'newest first, and the older round stays reachable as a fallback candidate',
  )
  assert.deepEqual(selectPriorRounds(idx, { project: '/p', branch: 'nope' }), [])
  assert.deepEqual(selectPriorRounds([], { project: '/p', branch: 'feat/x' }), [])
})

// ---- prior-round selection, end to end -------------------------------------------------------
// The READ path used to be a prose recipe handed to a model. These pin the conditions the real
// store actually contains — an empty/absent branch, a project that does not match, and blocks of
// pretty-printed (multi-line) JSON inside index.jsonl that a strict reader would throw on.
test('selectPriorRounds rejects an entry with an empty or absent branch', () => {
  const idx = [
    { ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project: '/p', branch: '' },
    { ts: '2026-07-11T00-00-00Z', kind: 'workflow', name: 'review', project: '/p' },
  ]
  assert.deepEqual(selectPriorRounds(idx, { project: '/p', branch: '' }), [])
  assert.deepEqual(selectPriorRounds(idx, { project: '/p', branch: 'feat/x' }), [])
})

test('findPriorRound: newest wins, malformed index lines are skipped, mismatches reject', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-proj-'))
  const g = a => execFileSync('git', a, { cwd: project, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  g(['init', '-q', '-b', 'feat/x'])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(project, 'a'), '1'); g(['add', 'a']); g(['commit', '-qm', 'one'])
  const old = g(['rev-parse', '--short', 'HEAD'])
  fs.writeFileSync(path.join(project, 'a'), '2'); g(['commit', '-qam', 'two'])
  t.after(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })

  const row = (ts, extra = {}) => ({ ts, kind: 'workflow', name: 'review', project, branch: 'feat/x', head: old, round: 1, ...extra })
  const detail = (ts, rec) => fs.writeFileSync(path.join(store, `${ts}-workflow-review.json`), JSON.stringify(rec))
  detail('2026-07-10T00-00-00Z', { round: 1, head: old, ledger: [{ fp: 'aaaa' }], findings: { total: 3 } })
  detail('2026-07-12T00-00-00Z', { round: 4, head: old, ledger: [{ fp: 'bbbb' }, { fp: 'cccc' }], findings: { total: 7 } })
  fs.writeFileSync(path.join(store, 'index.jsonl'), [
    JSON.stringify(row('2026-07-10T00-00-00Z')),
    '{\n  "ts": "2026-07-11T00-00-00Z",',           // pretty-printed JSON split across lines:
    '  "kind": "workflow"\n}',                      // a strict reader throws here, we must not
    JSON.stringify(row('2026-07-12T00-00-00Z')),
    JSON.stringify(row('2026-07-13T00-00-00Z', { project: '/somewhere/else' })),
    JSON.stringify(row('2026-07-14T00-00-00Z', { branch: 'other' })),
  ].join('\n') + '\n')

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.equal(hit.round, 4, 'newest matching ts wins, and the detail record supplies the round')
  assert.equal(hit.head, old)
  assert.equal(hit.ledger.length, 2)
  assert.equal(hit.priorFindings, 7)

  assert.equal(hit.ledgerCount, 2, 'the authoritative count the workflow checks the transported array against')
  assert.equal(hit.reason, '', 'a found round carries no rejection reason')

  // Every miss names ITS OWN cause: collapsing these into one {found:false} is the silent
  // chain-break this command exists to remove.
  assert.equal(findPriorRound({ store, project, branch: 'nope' }).reason, 'no-candidate-rows', 'branch mismatch')
  assert.equal(findPriorRound({ store, project, branch: '' }).reason, 'no-branch', 'absent branch')
  assert.equal(findPriorRound({ store, project: '/not/this/repo', branch: 'feat/x' }).reason, 'no-candidate-rows', 'project mismatch')
  assert.equal(findPriorRound({ store: path.join(store, 'gone'), project, branch: 'feat/x' }).reason, 'no-store', 'no store at all')
  assert.equal(findPriorRound({ store, project, branch: 'nope' }).found, false)
})

// The two conditions this whole read path exists for — a legacy row that names no repository, and a
// head that a rebase/force-push left off this history — plus the fallback that keeps either from
// blanking a valid round.
test('findPriorRound: skips `.` rows, walks past non-ancestor and unreadable candidates, normalizes the ledger', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior2-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-proj2-'))
  const g = a => execFileSync('git', a, { cwd: project, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  g(['init', '-q', '-b', 'feat/x'])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(project, 'a'), '1'); g(['add', 'a']); g(['commit', '-qm', 'one'])
  const good = g(['rev-parse', '--short', 'HEAD'])
  fs.writeFileSync(path.join(project, 'a'), '2'); g(['commit', '-qam', 'two'])
  // An orphan commit: a real object in this repo that is NOT an ancestor of HEAD — exactly what a
  // rebase or force-push leaves behind in an older run record.
  g(['checkout', '-q', '--orphan', 'tmp-orphan'])
  fs.writeFileSync(path.join(project, 'b'), '1'); g(['add', 'b']); g(['commit', '-qm', 'orphan'])
  const orphan = g(['rev-parse', '--short', 'HEAD'])
  g(['checkout', '-q', 'feat/x'])
  t.after(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })

  const row = (ts, extra = {}) => ({ ts, kind: 'workflow', name: 'review', project, branch: 'feat/x', head: good, round: 1, ...extra })
  const detail = (ts, rec) => fs.writeFileSync(path.join(store, `${ts}-workflow-review.json`), JSON.stringify(rec))
  // The only survivor: an older row whose head IS an ancestor and whose detail record is readable.
  detail('2026-07-10T00-00-00Z', {
    round: 2,
    head: good,
    // A persisted entry from an older engine: missing most required keys, carrying an unknown one.
    ledger: [{ fp: 'aaaa', line: '17', junk: 'drop me', sources: ['lens:api', 7] }],
    findings: { total: 5 },
  })
  detail('2026-07-12T00-00-00Z', { round: 9, head: orphan, ledger: [], findings: { total: 1 } })
  // 2026-07-13 deliberately has NO detail file on disk.
  fs.writeFileSync(path.join(store, 'index.jsonl'), [
    JSON.stringify(row('2026-07-10T00-00-00Z', { round: 2 })),
    JSON.stringify(row('2026-07-12T00-00-00Z', { head: orphan, round: 9 })),   // rejected: not an ancestor
    JSON.stringify(row('2026-07-13T00-00-00Z', { round: 8 })),                 // rejected: detail unreadable
    JSON.stringify(row('2026-07-14T00-00-00Z', { project: '.', round: 7 })),   // rejected: unattributable
  ].join('\n') + '\n')
  detail('2026-07-14T00-00-00Z', { round: 7, head: good, ledger: [], findings: { total: 99 } })

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true, 'a rejected newest candidate must not end the search')
  assert.equal(hit.round, 2, 'newest-first with fallback lands on the oldest valid row here')
  assert.equal(hit.priorFindings, 5)

  const item = hit.ledger[0]
  assert.equal(Object.prototype.hasOwnProperty.call(item, 'junk'), false, 'unknown keys are dropped')
  assert.equal(item.line, 17, 'line is coerced to an integer')
  assert.equal(item.fp, 'aaaa')
  for (const k of ['fp', 'file', 'line', 'symbol', 'severity', 'tier', 'disposition', 'source', 'ruleId', 'title', 'why']) {
    assert.equal(Object.prototype.hasOwnProperty.call(item, k), true, `missing required key ${k}`)
  }
  assert.deepEqual(item.sources, ['lens:api'], 'sources is kept, non-strings dropped')

  // And with ONLY a `.` row in the store there is no prior round at all — never a foreign repo's.
  const store2 = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior3-'))
  t.after(() => fs.rmSync(store2, { recursive: true, force: true }))
  fs.writeFileSync(path.join(store2, 'index.jsonl'), JSON.stringify(row('2026-07-14T00-00-00Z', { project: '.' })) + '\n')
  fs.writeFileSync(path.join(store2, '2026-07-14T00-00-00Z-workflow-review.json'), JSON.stringify({ round: 7, head: good, ledger: [], findings: { total: 99 } }))
  const miss = findPriorRound({ store: store2, project, branch: 'feat/x' })
  assert.equal(miss.found, false, 'a `.` row is never attributed to this repo')
  assert.equal(miss.reason, 'unattributable-rows-only',
    'and the drop is REPORTED — this is the first re-review of every branch whose rows predate the absolute key')
  assert.deepEqual({ ...miss, reason: '' }, PRIOR_ROUND_NONE, 'otherwise the empty shape is unchanged')
})

// The CLI resolves `--project` to the repository root before calling in, so the end-to-end tests
// above can never exercise a relative project. A DIRECT library call can — and that is the path
// that regressed. `project: '.'` must not become a candidate that matches legacy `project: "."`
// rows. Hermetic: it builds its own repo and runs from inside it, so it FAILS rather than errors
// when the tests are run outside a git checkout.
test('findPriorRound: a direct library call with a relative project never matches a `.` row', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior4-'))
  const { dir: project, head } = tempRepo('feat/x')
  const cwd0 = process.cwd()
  process.chdir(project)
  t.after(() => {
    process.chdir(cwd0)
    fs.rmSync(store, { recursive: true, force: true })
    fs.rmSync(project, { recursive: true, force: true })
  })
  const branch = 'feat/x'
  const ts = '2026-07-14T00-00-00Z'
  // Everything else about this row is valid: right branch, an ancestor head, a readable detail
  // record. Only the unattributable `project: "."` may keep it from being returned.
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts, kind: 'workflow', name: 'review', project: '.', branch, head, round: 7 }) + '\n')
  fs.writeFileSync(path.join(store, `${ts}-workflow-review.json`),
    JSON.stringify({ round: 7, head, ledger: [{ fp: 'aaaa' }], findings: { total: 99 } }))

  assert.deepEqual(
    { ...findPriorRound({ store, project: '.', branch }), reason: '' },
    PRIOR_ROUND_NONE,
    'a relative project must be dropped as a candidate, not searched as the literal string "."',
  )
})

// A `partial: true` record is a run that DIED. The store's README says never to average one in, and
// its ledger is whatever the last checkpoint held — carrying it as the prior round truncates the
// chain. The search must skip it and keep walking to an older COMPLETE round.
test('findPriorRound: a partial record is never the prior round', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior5-'))
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  const row = (ts, round) => JSON.stringify({ ts, kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round })
  const detail = (ts, rec) => fs.writeFileSync(path.join(store, `${ts}-workflow-review.json`), JSON.stringify(rec))
  detail('2026-07-10T00-00-00Z', { round: 2, head, ledger: [{ fp: 'aaaa' }], findings: { total: 5 } })
  detail('2026-07-12T00-00-00Z', { round: 9, head, partial: true, ledger: [{ fp: 'zzzz' }], findings: { total: 1 } })
  fs.writeFileSync(path.join(store, 'index.jsonl'), [row('2026-07-10T00-00-00Z', 2), row('2026-07-12T00-00-00Z', 9)].join('\n') + '\n')

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.round, 2, 'the newer PARTIAL round is skipped in favour of the older complete one')
  assert.equal(hit.ledger[0].fp, 'aaaa')

  // With ONLY a partial record there is no prior round at all — and the reason says so.
  fs.writeFileSync(path.join(store, 'index.jsonl'), row('2026-07-12T00-00-00Z', 9) + '\n')
  const miss = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(miss.found, false)
  assert.equal(miss.reason, 'partial-only')
})

// ---- the CLI contract ------------------------------------------------------------------------
// "One line of JSON, always exit 0, never aborts the review" is the promise the workflow leans on:
// the loader agent runs the subcommand and returns its bytes. Exercised as a SUBPROCESS, because
// the library-level tests above cannot see the exit code, the stdout framing, or the CLI's own
// project resolution.
function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

test('prior-round CLI: one line of JSON on stdout, exit 0, and the repo root as the key', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior6-'))
  const { dir: project, head } = tempRepo('feat/x')
  const sub = path.join(project, 'nested', 'deep')
  fs.mkdirSync(sub, { recursive: true })
  t.after(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })

  const ts = '2026-07-10T00-00-00Z'
  // The row is keyed to the repository ROOT — what the CLI now writes from anywhere in the repo.
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts, kind: 'workflow', name: 'review', project: fs.realpathSync(project), branch: 'feat/x', head, round: 3 }) + '\n')
  fs.writeFileSync(path.join(store, `${ts}-workflow-review.json`),
    JSON.stringify({ round: 3, head, ledger: [{ fp: 'aaaa' }, { fp: 'bbbb' }], findings: { total: 4 } }))

  // Run from a SUBDIRECTORY: keying by $PWD would miss the row entirely.
  const ok = runCli(['prior-round', '--branch', 'feat/x', '--store', store], { cwd: sub })
  assert.equal(ok.status, 0, 'always exit 0')
  assert.equal(ok.stdout.trimEnd().split('\n').length, 1, 'exactly one line')
  const out = JSON.parse(ok.stdout)
  assert.equal(out.found, true, 'a run from a subdirectory still finds the repo-root-keyed round')
  assert.equal(out.round, 3)
  assert.equal(out.ledgerCount, 2)
  assert.equal(out.ledger.length, out.ledgerCount)

  // The failure case: a store that does not exist. Still one line, still exit 0, and it SAYS why —
  // losing the prior round degrades the review, it never aborts it.
  const miss = runCli(['prior-round', '--branch', 'feat/x', '--store', path.join(store, 'gone')], { cwd: project })
  assert.equal(miss.status, 0, 'a missing store is not an error exit')
  assert.equal(miss.stderr, '', 'and nothing is written to stderr')
  const missOut = JSON.parse(miss.stdout)
  assert.equal(missOut.found, false)
  assert.equal(missOut.reason, 'no-store')

  // An unknown subcommand is still a usage error — the tolerance is scoped to prior-round.
  assert.equal(runCli(['bogus'], { cwd: project }).status, 2)
})
