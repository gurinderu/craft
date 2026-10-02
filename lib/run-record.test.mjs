import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  isCount, costProblem, costTotal,
  countBySeverity, summarizeFindings, worstVerdict, reviewVerdict, refuteRate, indexProjection, selectPriorRounds, branchFromAbbrevRef,
  tallyVerdicts, titleShingle, normalizeSymbol, fingerprint, shingleOverlap, matchesPrior,
  rereviewVerdict, reReviewMemory, ENGINE_REVISION, engineKey, engineRevisionToken, isEngineAttributed, GREEN_VERDICT,
  fpBasisOf, sameFpBasis, FP_BASIS_SINCE, fpBasisEstablished, basisVerdictFromRevisions,
} from './run-record.mjs'
import { GREEN_VERDICT as GREEN_VERDICT_AE } from './audit-evidence.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isMainThread } from 'node:worker_threads'
import { findPriorRound, readJsonlCounted, PRIOR_ROUND_NONE } from './craft-log-run.mjs'
import { extractDeclaration } from './inline-regions.mjs'

const CLI = fileURLToPath(new URL('./craft-log-run.mjs', import.meta.url))

// A throwaway git repo with one commit. Every prior-round test needs real ancestry, and none of
// them may depend on the ambient checkout — outside one, an ambient test ERRORS instead of failing.
function tempRepo(branch = 'feat/x') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-repo-')))
  /** @param {string[]} a */
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

test('greenness is decided by the ONE authority — a canonical word plus a trailing clause is not green', () => {
  // worstVerdict once tested greenness with a private SUBSTRING (/Approve|Healthy|Clean|Pass/i) that
  // was LOOSER than GREEN_VERDICT (whole-string): an off-vocabulary green that leads with a canonical
  // word but carries extra text — "Approve — all clean", "Clean, no UB detected" — passed the gate's
  // demote step ungated (GREEN_VERDICT said not-green, so no evidence was required) yet aggregated
  // here AS green. The two authorities are now one. This is the RED before worstVerdict adopts
  // GREEN_VERDICT: the old substring returned 'Approve'.
  assert.equal(worstVerdict(['Approve — all clean']), 'Warning')
  assert.equal(worstVerdict(['Clean, no UB detected']), 'Warning')
  assert.equal(worstVerdict(['Approve (with minor nits)']), 'Warning')
  // ...while the bare canonical greens the whole-string authority DOES recognise still aggregate green.
  assert.equal(worstVerdict(['Approve', 'Healthy', 'Clean', 'Pass']), 'Approve')
})

test('GREEN_VERDICT is byte-identical across the two closure-free inline modules that read it', () => {
  // worstVerdict (this module) and demoteUnsupportedGreen/normalizeDimensionVerdict (audit-evidence)
  // must classify green identically. They live in separate craft-inline sources, and no inline source
  // has an import, so the regex cannot be shared by reference — it is copied and PINNED here, the same
  // stitch discipline as EVIDENCE_MARKER. If either copy is edited alone, this fails.
  assert.equal(GREEN_VERDICT.source, GREEN_VERDICT_AE.source, 'the green regex bodies must match')
  assert.equal(GREEN_VERDICT.flags, GREEN_VERDICT_AE.flags, 'the green regex flags must match')
})

test('a dimension whose tool never ran does not aggregate to green', () => {
  // `INCOMPLETE (not run)` is the verdict a rust-audit dimension returns when the tool it depends
  // on is absent — cargo-semver-checks, cargo-hack, cargo-tree, the security toolchain, Miri.
  // Those prompts used to say "return Approve", so an audit that checked nothing read as clean.
  assert.equal(worstVerdict(['INCOMPLETE (not run)']), 'Warning')
  assert.equal(worstVerdict(['Approve', 'Healthy', 'Clean', 'INCOMPLETE (not run)']), 'Warning')
  // ...and it must not mask a real finding either way round.
  assert.equal(worstVerdict(['INCOMPLETE (not run)', 'Block']), 'Block')
  assert.equal(worstVerdict(['INCOMPLETE (not run)', 'UB-found']), 'Block')
  // The other direction stays intact: a tool that RAN and found nothing is still green.
  assert.equal(worstVerdict(['Approve', 'Clean', 'Healthy']), 'Approve')
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

test('refuteRate is the refuted fraction of the candidates, 2-dp, 0 when nothing was judged', () => {
  assert.equal(refuteRate(3, 4), 0.75)
  assert.equal(refuteRate(0, 2), 0)
  assert.equal(refuteRate(0, 0), 0)
  assert.equal(refuteRate(3, 3), 1)
  assert.equal(refuteRate(2, 3), 0.67)
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

test('normalizeSymbol folds case, the fn/impl keyword, and generic parameters to one key', () => {
  assert.equal(normalizeSymbol('Foo::Bar'), 'foo::bar')
  assert.equal(normalizeSymbol('fn parse'), 'parse')
  assert.equal(normalizeSymbol('impl Parser'), 'parser')
  assert.equal(normalizeSymbol('Parser::parse<T>'), 'parser::parse')
  assert.equal(normalizeSymbol('fn Parser::parse<T, U>'), 'parser::parse')
  assert.equal(normalizeSymbol(null), '')
  assert.equal(normalizeSymbol('  Foo::bar  '), 'foo::bar')
})

test('normalizeSymbol strips NESTED generics, leaving no stray >', () => {
  // A single /<[^>]*>/g pass stops its class at the first `>`, so a nested generic kept the inner and
  // trailing `>`: `Vec<Map<K,V>>` folded to `vec>`, which defeats the helper's whole purpose (folding
  // two spellings of one symbol to one key) whenever agents give different nesting depths. Strip all
  // levels, innermost-first, leaving no dangling character.
  assert.equal(normalizeSymbol('Vec<Map<K,V>>'), 'vec')
  assert.equal(normalizeSymbol('Foo<Bar<Baz>>'), 'foo')
  assert.equal(normalizeSymbol('parse<T>'), 'parse')
  assert.equal(normalizeSymbol('fn foo'), 'foo')
  assert.equal(normalizeSymbol('HashMap<String, Vec<u8>>::insert'), 'hashmap::insert')
  // and the point of the fold: a fully-parameterized nested form and the bare form hash to one key.
  assert.equal(normalizeSymbol('Cache<Vec<Entry>>'), normalizeSymbol('Cache'))
})

test('fingerprint no longer depends on the title at all — that is the re-anchor', () => {
  // Before revision 3 the basis carried a title shingle, so two lens agents wording the same defect
  // differently hashed apart (matchesPrior recognised 2 of 59). Now the title is out of the basis:
  // same file+symbol+ruleId, completely different titles, one identity.
  const a = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'lock held across await' }
  const b = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'a totally unrelated wording of the same defect' }
  assert.equal(fingerprint(a), fingerprint(b))
})

test('fingerprint absorbs symbol case and decoration through normalizeSymbol', () => {
  // Two agents naming the same enclosing symbol differently must produce ONE fingerprint.
  const base = { file: 'src/foo.rs', ruleId: 'SAF-002', title: 'x' }
  assert.equal(fingerprint({ ...base, symbol: 'fn parse' }), fingerprint({ ...base, symbol: 'parse' }))
  assert.equal(fingerprint({ ...base, symbol: 'Parser::parse<T>' }), fingerprint({ ...base, symbol: 'parser::parse' }))
  // A genuine rename is still a different symbol — the intended, rare identity loss.
  assert.notEqual(fingerprint({ ...base, symbol: 'parse' }), fingerprint({ ...base, symbol: 'parse_line' }))
})

test('fingerprint keeps the title for a finding with NO ruleId, so distinct ad-hoc findings do not collapse', () => {
  // The re-anchor drops the title only where a ruleId supplies a stable identity. An ad-hoc finding
  // has none, so its title stays in the basis — otherwise two distinct defects at one file (no symbol,
  // no ruleId) would hash to a single file-only value and a fingerprint-keyed dedup
  // (dedupJournalFindings) would merge them, losing one. The tombstone check never keys these.
  const a = { file: 'a.rs', line: 1, symbol: '', ruleId: '', title: 'seed defect' }
  const b = { file: 'a.rs', line: 1, symbol: '', ruleId: '', title: 'unwrap panics' }
  assert.notEqual(fingerprint(a), fingerprint(b), 'distinct ad-hoc defects at one file stay distinct')
  assert.equal(fingerprint(a), fingerprint({ ...a, title: 'defect seed' }), 'but the same defect, reworded, still matches (title shingle is word-order free)')
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
  assert.ok(matchesPrior(/** @type {import('./run-record.mjs').FindingKey} */ ({ ...prior, line: 99, title: 'lock across await held' }), prior))
  assert.ok(!matchesPrior({ ...prior, file: 'src/other.rs' }, prior))
  assert.ok(!matchesPrior({ ...prior, ruleId: 'CON-004' }, prior))
  assert.ok(!matchesPrior({ ...prior, title: 'completely different unrelated defect here' }, prior))
})

test('matchesPrior treats a moved symbol as the same finding when file+ruleId+title hold', () => {
  const prior = { file: 'src/foo.rs', symbol: '', ruleId: 'SAF-002', title: 'unwrap on reachable path' }
  assert.ok(matchesPrior({ file: 'src/foo.rs', symbol: 'Foo::run', ruleId: 'SAF-002', title: 'unwrap on reachable path' }, prior))
})

test('rereviewVerdict weighs only still-open, regressed, and new findings', () => {
  assert.equal(rereviewVerdict({ stillOpen: [], regressed: [], neu: [] }), 'Approve')
  assert.equal(rereviewVerdict({ stillOpen: [{ severity: 'Medium' }] }), 'Warning')
  assert.equal(rereviewVerdict({ regressed: [{ severity: 'High' }] }), 'Block')
  assert.equal(rereviewVerdict({ neu: [{ severity: 'Critical' }], stillOpen: [{ severity: 'Low' }] }), 'Block')
})

test('reReviewMemory: a detached HEAD is a visible loss, not a silent one', () => {
  // findPriorRound returns 'no-branch' on a detached HEAD, and the run then becomes round 1 with no
  // chaining. This is the ONE reason that earns a user-facing note (realm @nick/craft #104).
  const r = reReviewMemory('no-branch')
  assert.equal(r.chained, false)
  assert.equal(r.reason, 'no-branch')
  assert.ok(r.note, 'the detached-HEAD case must carry a note')
  assert.match(r.note, /detached|branch/i, 'the note names the branch/detached-HEAD cause')
})

test('reReviewMemory: a run that chained a prior round carries no note', () => {
  // An empty/undefined reason means a prior round WAS found — the run chained normally.
  for (const found of [null, '', undefined]) {
    const r = reReviewMemory(found)
    assert.deepEqual(r, { chained: true, reason: null, note: null })
  }
})

test('reReviewMemory: an ordinary first review is normal, not a footgun — no note', () => {
  // A genuine first review on a branch (or any non-detached miss) must NOT produce a note, or the
  // note fires on every first review and stops being read.
  for (const reason of ['no-candidate-rows', 'no-store', 'unattributable-rows-only', 'ancestry-rejected']) {
    const r = reReviewMemory(reason)
    assert.equal(r.chained, false)
    assert.equal(r.reason, reason)
    assert.equal(r.note, null, `${reason} must not carry a note`)
  }
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

// Reads lib/ source as text, which Stryker rewrites with its mutant switches: skipped under mutation testing only.
test.skipIf(process.env['STRYKER_MUTATOR_WORKER'] !== undefined)('indexProjection does NOT carry engineRevision, and the note saying so is not mirrored', () => {
  // The projection is filterable by VERSION only. This is deliberate, not an oversight: the same
  // function is pasted verbatim into three workflow scripts that stamp no engineRevision, so the
  // column would land there as a permanent `null` beside real values. Whoever adds it must also
  // teach those writers to stamp — this assertion is what makes them notice.
  const p = indexProjection(/** @type {Parameters<typeof indexProjection>[0]} */ ({ schemaVersion: 1, ts: 't', kind: 'workflow', name: 'review', project: '/p', verdict: 'Approve', engineRevision: 2 }))
  assert.ok(!('engineRevision' in p), 'adding this column means updating the workflow writers too — read the note above indexProjection')

  // ...and the note must stay OUT of the craft-inline region, or `node lib/check-workflows.mjs`
  // demands three off-limits workflow files be regenerated for a comment. The extractor takes only
  // the CONTIGUOUS leading `//` block, so the blank line between the note and the declaration is
  // load-bearing.
  const src = fs.readFileSync(new URL('./run-record.mjs', import.meta.url), 'utf8')
  const region = extractDeclaration(src, 'indexProjection')
  assert.ok(!/NOT MIRRORED/.test(region), 'the blank line separating the note from the declaration was removed')
  assert.ok(/craftVersion: r\.craftVersion/.test(region), 'sanity: the extractor did find the declaration')
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

test('branchFromAbbrevRef maps a detached HEAD to no branch and passes real names through', () => {
  // `git rev-parse --abbrev-ref HEAD` prints the literal "HEAD" when detached; filed as a branch it
  // would pool every unrelated detached run under one key and let selectPriorRounds chain them.
  assert.equal(branchFromAbbrevRef('HEAD'), '', 'detached HEAD resolves to no branch')
  assert.equal(branchFromAbbrevRef('feat/x'), 'feat/x', 'a real branch name is untouched')
  assert.equal(branchFromAbbrevRef('main'), 'main')
  assert.equal(branchFromAbbrevRef(''), '', 'an unresolved ref (git failed) stays empty')
})

test('findPriorRound: newest wins, malformed index lines are skipped, mismatches reject', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-proj-'))
  /** @param {string[]} a */
  const g = a => execFileSync('git', a, { cwd: project, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  g(['init', '-q', '-b', 'feat/x'])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(project, 'a'), '1'); g(['add', 'a']); g(['commit', '-qm', 'one'])
  const old = g(['rev-parse', '--short', 'HEAD'])
  fs.writeFileSync(path.join(project, 'a'), '2'); g(['commit', '-qam', 'two'])
  t.onTestFinished(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })

  /** @param {string} ts @param {Record<string, unknown>} [extra] */
  const row = (ts, extra = {}) => ({ ts, kind: 'workflow', name: 'review', project, branch: 'feat/x', head: old, round: 1, ...extra })
  /** @param {string} ts @param {unknown} rec */
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
  assert.match(findPriorRound({ store, project, branch: 'nope' }).reason, /^no-candidate-rows\b/, 'branch mismatch')
  assert.equal(findPriorRound({ store, project, branch: '' }).reason, 'no-branch', 'absent branch')
  assert.match(findPriorRound({ store, project: '/not/this/repo', branch: 'feat/x' }).reason, /^no-candidate-rows\b/, 'project mismatch')
  assert.equal(findPriorRound({ store: path.join(store, 'gone'), project, branch: 'feat/x' }).reason, 'no-store', 'no store at all')
  assert.equal(findPriorRound({ store, project, branch: 'nope' }).found, false)

  // ...and a miss must SAY that lines were skipped. A chain broken by a corrupt index reads exactly
  // like a branch nobody ever reviewed, and only one of those means starting from scratch is right.
  // The real ~/.craft/runs/index.jsonl holds 29 such lines out of 268.
  assert.match(findPriorRound({ store, project, branch: 'nope' }).reason,
    /index\.jsonl: 4 unreadable line\(s\) skipped/,
    'a partial read of the index must not be reported as a complete one')
})

test('findPriorRound: a clean index qualifies nothing — the note appears only when lines were lost', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior3-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-proj3-'))
  /** @param {string[]} a */
  const g = a => execFileSync('git', a, { cwd: project, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  g(['init', '-q', '-b', 'feat/x'])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(project, 'a'), '1'); g(['add', 'a']); g(['commit', '-qm', 'one'])
  t.onTestFinished(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'other', head: 'abc' }) + '\n')
  assert.equal(findPriorRound({ store, project, branch: 'feat/x' }).reason, 'no-candidate-rows')
})

test('readJsonlCounted returns the entries AND what it could not read', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-jsonl-'))
  t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const f = path.join(dir, 'index.jsonl')
  fs.writeFileSync(f, ['{"a":1}', '', '{\n  "b": 2', '}', '{"c":3}'].join('\n') + '\n')
  const r = readJsonlCounted(f)
  assert.deepEqual(r.entries, [{ a: 1 }, { c: 3 }])
  // 3, not 1: a pretty-printed record spans several lines and EVERY one of them is unreadable as
  // JSONL. The count is of lost lines, which is the honest thing to report about a line-based file.
  assert.equal(r.malformed, 3, 'blank lines are not damage; unparsable ones are, and they are counted')
  assert.deepEqual(readJsonlCounted(path.join(dir, 'absent.jsonl')), { entries: [], malformed: 0 })
})

// The two conditions this whole read path exists for — a legacy row that names no repository, and a
// head that a rebase/force-push left off this history — plus the fallback that keeps either from
// blanking a valid round.
test('findPriorRound: skips `.` rows, walks past non-ancestor and unreadable candidates, normalizes the ledger', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior2-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-proj2-'))
  /** @param {string[]} a */
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
  t.onTestFinished(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })

  /** @param {string} ts @param {Record<string, unknown>} [extra] */
  const row = (ts, extra = {}) => ({ ts, kind: 'workflow', name: 'review', project, branch: 'feat/x', head: good, round: 1, ...extra })
  /** @param {string} ts @param {unknown} rec */
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
  t.onTestFinished(() => fs.rmSync(store2, { recursive: true, force: true }))
  fs.writeFileSync(path.join(store2, 'index.jsonl'), JSON.stringify(row('2026-07-14T00-00-00Z', { project: '.' })) + '\n')
  fs.writeFileSync(path.join(store2, '2026-07-14T00-00-00Z-workflow-review.json'), JSON.stringify({ round: 7, head: good, ledger: [], findings: { total: 99 } }))
  const miss = findPriorRound({ store: store2, project, branch: 'feat/x' })
  assert.equal(miss.found, false, 'a `.` row is never attributed to this repo')
  assert.equal(miss.reason, 'unattributable-rows-only',
    'and the drop is REPORTED — this is the first re-review of every branch whose rows predate the absolute key')
  assert.deepEqual({ ...miss, reason: '' }, PRIOR_ROUND_NONE, 'otherwise the empty shape is unchanged')
})

// The recidivism/tombstone check compares a stored fingerprint to a freshly computed one, and that is
// sound ONLY within one fingerprint basis (FP_BASIS_SINCE). The loader reports whether the prior round
// is comparable so the workflow can skip the check across a basis change instead of missing a
// regression silently.
test('findPriorRound reports sameFpBasis true only when the prior record shares this engine\'s fp basis', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-rev-'))
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  /** @param {string} ts */
  const row = ts => JSON.stringify({ ts, kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 2 })
  /** @param {string} ts @param {unknown} rec */
  const detail = (ts, rec) => fs.writeFileSync(path.join(store, `${ts}-workflow-review.json`), JSON.stringify(rec))

  // Same revision as this engine → comparable.
  detail('2026-07-10T00-00-00Z', { round: 2, head, engineRevision: ENGINE_REVISION, ledger: [{ fp: 'aaaa' }], findings: { total: 1 } })
  fs.writeFileSync(path.join(store, 'index.jsonl'), row('2026-07-10T00-00-00Z') + '\n')
  assert.equal(findPriorRound({ store, project, branch: 'feat/x' }).sameFpBasis, true)

  // A revision on an OLDER basis → not comparable: the fingerprints were computed under another basis.
  detail('2026-07-11T00-00-00Z', { round: 2, head, engineRevision: 2, ledger: [{ fp: 'aaaa' }], findings: { total: 1 } })
  fs.writeFileSync(path.join(store, 'index.jsonl'), [row('2026-07-10T00-00-00Z'), row('2026-07-11T00-00-00Z')].join('\n') + '\n')
  assert.equal(findPriorRound({ store, project, branch: 'feat/x' }).sameFpBasis, false, 'the newest wins, and it is on an older basis')

  // A legacy record with NO revision → not comparable: it used the old, title-anchored fp basis.
  detail('2026-07-12T00-00-00Z', { round: 3, head, ledger: [{ fp: 'aaaa' }], findings: { total: 1 } })
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    [row('2026-07-10T00-00-00Z'), row('2026-07-11T00-00-00Z'),
      JSON.stringify({ ts: '2026-07-12T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 3 })].join('\n') + '\n')
  assert.equal(findPriorRound({ store, project, branch: 'feat/x' }).sameFpBasis, false, 'a pre-revision record is not comparable')
  assert.equal(findPriorRound({ store, project, branch: 'feat/x' }).fpBasisKnown, false, 'and its basis cannot be established (realm @nick/craft #110)')
})

// realm @nick/craft #108: the fingerprint basis is not the engine revision. A telemetry-only bump of
// ENGINE_REVISION must leave a prior round of the SAME fp basis comparable, or every in-flight review
// loop drops its tombstones on the first re-review after an upgrade. Asserted through the loader,
// with the engine on a revision past the r3 basis boundary — so the bump this guards is real.
test('findPriorRound keeps a prior round comparable across a telemetry-only revision bump', (t) => {
  assert.ok(ENGINE_REVISION > 3, 'premise: this engine is past the revision that began the current fp basis')
  assert.equal(fpBasisOf(ENGINE_REVISION), fpBasisOf(3), 'premise: and still on that basis')
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-fpb-'))
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  /** @param {string} ts */
  const row = ts => JSON.stringify({ ts, kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 2 })
  /** @param {string} ts @param {unknown} rec */
  const detail = (ts, rec) => fs.writeFileSync(path.join(store, `${ts}-workflow-review.json`), JSON.stringify(rec))

  detail('2026-07-10T00-00-00Z', { round: 2, head, engineRevision: 3, ledger: [{ fp: 'aaaa' }], findings: { total: 1 } })
  fs.writeFileSync(path.join(store, 'index.jsonl'), row('2026-07-10T00-00-00Z') + '\n')
  assert.equal(findPriorRound({ store, project, branch: 'feat/x' }).sameFpBasis, true, 'an r3 prior shares the basis — its tombstones survive the bump')

  detail('2026-07-11T00-00-00Z', { round: 2, head, engineRevision: 2, ledger: [{ fp: 'aaaa' }], findings: { total: 1 } })
  fs.writeFileSync(path.join(store, 'index.jsonl'), [row('2026-07-10T00-00-00Z'), row('2026-07-11T00-00-00Z')].join('\n') + '\n')
  assert.equal(findPriorRound({ store, project, branch: 'feat/x' }).sameFpBasis, false, 'an r2 prior used the title-anchored basis — not comparable')
  assert.equal(findPriorRound({ store, project, branch: 'feat/x' }).fpBasisKnown, true, 'but its basis IS known — a real basis change')
})

test('fpBasisOf maps a revision to the basis it was stamped under; sameFpBasis compares bases, not revisions', () => {
  assert.equal(fpBasisOf(1), fpBasisOf(2), 'r1 and r2 share the title-anchored basis')
  assert.notEqual(fpBasisOf(2), fpBasisOf(3), 'r3 re-anchored the fingerprint')
  assert.equal(fpBasisOf(3), fpBasisOf(4))
  for (const bad of [undefined, null, 0, -1, 2.5, '3']) assert.equal(fpBasisOf(bad), null, `${String(bad)} is no revision`)
  assert.equal(sameFpBasis(3, 4), true)
  assert.equal(sameFpBasis(2, 3), false)
  assert.equal(sameFpBasis(undefined, 4), false, 'a record with no revision is never comparable')
  // A prior from a NEWER engine may have begun a basis this engine's table does not know.
  assert.equal(sameFpBasis(ENGINE_REVISION + 1), false, 'a future revision fails closed')
  assert.equal(sameFpBasis(5, 4), false)
})

// The table's shape is what makes fpBasisOf sound: a basis begins at r1, bases are ordered, and no
// basis can begin at a revision this engine has not reached — an entry above ENGINE_REVISION would
// leave records written under the new basis reading as the old one.
test('FP_BASIS_SINCE starts at 1, ascends strictly, and ends at or below ENGINE_REVISION', () => {
  assert.equal(FP_BASIS_SINCE[0], 1)
  for (let i = 1; i < FP_BASIS_SINCE.length; i++) assert.ok(/** @type {number} */ (FP_BASIS_SINCE[i]) > /** @type {number} */ (FP_BASIS_SINCE[i - 1]), `entry ${i} ascends`)
  assert.ok(/** @type {number} */ (FP_BASIS_SINCE.at(-1)) <= ENGINE_REVISION,
    'a new fp basis begins at a revision the engine has reached: bump ENGINE_REVISION with the entry')
})

test('fpBasisEstablished: a known revision at or below this engine, never a missing or newer one', () => {
  assert.equal(fpBasisEstablished(2), true, 'an older basis is still an ESTABLISHED one')
  assert.equal(fpBasisEstablished(ENGINE_REVISION), true)
  for (const bad of [undefined, null, 0, 2.5, '3']) assert.equal(fpBasisEstablished(bad), false, `${String(bad)}`)
  assert.equal(fpBasisEstablished(ENGINE_REVISION + 1), false, 'a newer engine may have begun a basis this one does not know')
})

// The fingerprint VALUES, pinned. Every other fingerprint test is relational (a === b), so a change to
// fingerprint()/normalizeSymbol()/titleShingle() that alters what an fp means would pass them all —
// and with the basis no longer implied by the engine revision, nothing else would notice that the
// re-review memory now compares old-basis fps to new-basis ones (realm @nick/craft #108).
test('fingerprint values are pinned to the current fp basis', () => {
  assert.equal(fpBasisOf(ENGINE_REVISION), 3, 'these literals belong to the basis that began at r3')
  const hint = 'fingerprint() changed what an fp means: add an FP_BASIS_SINCE entry at the new ENGINE_REVISION, then update these literals'
  assert.equal(fingerprint({ file: 'src/api/vm.rs', symbol: 'VmApi::create', ruleId: 'ERR-001', title: 'unwrap on a fallible path' }), '8bed6a47', hint)
  assert.equal(fingerprint({ file: 'src/api/vm.rs', symbol: 'VmApi::create', title: 'unwrap on a fallible path' }), '1f3d0c63', hint)
})

// The CLI resolves `--project` to the repository root before calling in, so the end-to-end tests
// above can never exercise a relative project. A DIRECT library call can — and that is the path
// that regressed. `project: '.'` must not become a candidate that matches legacy `project: "."`
// rows. Hermetic: it builds its own repo and runs from inside it, so it FAILS rather than errors
// when the tests are run outside a git checkout. Skipped only inside a worker thread, where
// process.chdir() throws: Stryker's Vitest runner forces the `threads` pool; `npm test` runs on forks.
test.skipIf(!isMainThread)('findPriorRound: a direct library call with a relative project never matches a `.` row', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior4-'))
  const { dir: project, head } = tempRepo('feat/x')
  const cwd0 = process.cwd()
  process.chdir(project)
  t.onTestFinished(() => {
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
test('findPriorRound: a partial record never supplies the round, but never blanks the chain either', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior5-'))
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })
  /** @param {string} ts @param {number} round */
  const row = (ts, round) => JSON.stringify({ ts, kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round })
  /** @param {string} ts @param {unknown} rec */
  const detail = (ts, rec) => fs.writeFileSync(path.join(store, `${ts}-workflow-review.json`), JSON.stringify(rec))
  detail('2026-07-10T00-00-00Z', { round: 2, head, ledger: [{ fp: 'aaaa' }], findings: { total: 5 } })
  detail('2026-07-12T00-00-00Z', { round: 9, head, partial: true, ledger: [{ fp: 'zzzz' }], findings: { total: 1 } })
  fs.writeFileSync(path.join(store, 'index.jsonl'), [row('2026-07-10T00-00-00Z', 2), row('2026-07-12T00-00-00Z', 9)].join('\n') + '\n')

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.round, 2, 'the newer PARTIAL round is skipped in favour of the older complete one')
  assert.equal(hit.ledger[0].fp, 'aaaa')

  // With ONLY a partial record its ledger is still refused — but the round HAPPENED, and answering
  // `found:false` is what renders the next run as a blank first review. It comes back as a DEGRADED
  // round: the number and head the row proves, an empty ledger, and the finding count that makes the
  // break loud downstream (review.js's ledgerDegraded forces a full base...HEAD re-scan on it).
  fs.writeFileSync(path.join(store, 'index.jsonl'), row('2026-07-12T00-00-00Z', 9) + '\n')
  const miss = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(miss.found, true)
  assert.equal(miss.round, 9)
  assert.equal(miss.ledger.length, 0, 'the dead run\'s own ledger is not trusted')
  assert.equal(miss.priorFindings, 1)
})

// ---- the CLI contract ------------------------------------------------------------------------
// "One line of JSON, always exit 0, never aborts the review" is the promise the workflow leans on:
// the loader agent runs the subcommand and returns its bytes. Exercised as a SUBPROCESS, because
// the library-level tests above cannot see the exit code, the stdout framing, or the CLI's own
// project resolution.
/** @param {string[]} args @param {Omit<import('node:child_process').SpawnSyncOptionsWithStringEncoding, 'encoding'>} [opts] */
function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

test('prior-round CLI: one line of JSON on stdout, exit 0, and the repo root as the key', (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prior6-'))
  const { dir: project, head } = tempRepo('feat/x')
  const sub = path.join(project, 'nested', 'deep')
  fs.mkdirSync(sub, { recursive: true })
  t.onTestFinished(() => { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })

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

test('engineKey: a record without a revision is its own unknown engine, never the current one', () => {
  const old = { runtime: 'claude-code', craftVersion: '0.16.0' }
  const now = { runtime: 'claude-code', craftVersion: '0.16.0', engineRevision: ENGINE_REVISION }
  // THE defect this exists for: two engines shipped under one version string. Same key would mean
  // an aggregate filtered by version silently averages both.
  assert.notEqual(engineKey(old), engineKey(now))
  assert.equal(engineKey(old), 'claude-code 0.16.0 r?')
  assert.equal(engineKey(now), `claude-code 0.16.0 r${ENGINE_REVISION}`)
  assert.equal(isEngineAttributed(old), false)
  assert.equal(isEngineAttributed(now), true)
})

test('engineKey: the runtime is part of the identity, and nothing is guessed', () => {
  // opencode writes into the same store and stamps no craftVersion — a different engine, not an
  // unversioned run of this one.
  assert.notEqual(engineKey({ runtime: 'opencode' }), engineKey({ runtime: 'claude-code' }))
  assert.equal(engineKey({ runtime: 'opencode' }), 'opencode unversioned r?')
  assert.equal(engineKey(null), 'unknown-runtime unversioned r?')
  // A non-integer revision is not a revision: a hand-edited '2' must not read as r2.
  assert.equal(engineKey({ runtime: 'claude-code', craftVersion: '1.0.0', engineRevision: '2' }), 'claude-code 1.0.0 r?')
  assert.equal(isEngineAttributed({ engineRevision: '2' }), false)
})

test('ENGINE_REVISION is a positive integer — it is ordered and compared', () => {
  assert.ok(Number.isInteger(ENGINE_REVISION) && ENGINE_REVISION > 0)
})

// Tripwire: `engineRevisionToken` is the ONE authority for the `r…` token shape, shared by
// `engineKey` here and by the analyzer's collision buckets (`revToken` in lib/analyze-runs.mjs). If
// the token format ever drifts on one side, the collision buckets silently stop matching the engine
// buckets — so pin the token to the last space-separated segment of `engineKey` for both an
// attributed and an unattributed record. (realm @nick/craft, #95)
test('engineRevisionToken equals the r… segment of engineKey — collision and engine buckets stay in lockstep', () => {
  const attributed = { runtime: 'claude-code', craftVersion: '0.18.1', engineRevision: 3 }
  const unattributed = { runtime: 'claude-code', craftVersion: '0.18.1' }
  assert.equal(engineRevisionToken(attributed), 'r3')
  assert.equal(engineRevisionToken(unattributed), 'r?')
  assert.equal(engineKey(attributed).split(' ').pop(), engineRevisionToken(attributed))
  assert.equal(engineKey(unattributed).split(' ').pop(), engineRevisionToken(unattributed))
})

// A per-crate child of a `rust-audit` fan-out files a `nested: true` review row under the SAME
// (project, branch) as its parent and its siblings. It is one slice of a single pass, not a round of
// its own, so it is not a candidate predecessor for anyone: picked up by a later top-level review it
// hands the whole repository a ledger scoped to one crate, and picked up by a concurrent sibling it
// is not even finished. The reader half of the same decision lives in workflows/review.js.
test('selectPriorRounds ignores nested child runs — a crate slice is not a round', () => {
  /** @param {Record<string, unknown>} [extra] */
  const row = (extra) => ({ kind: 'workflow', name: 'review', project: '/r', branch: 'feat/x', ts: '2026-01-01T00-00-00Z', ...extra })
  const entries = [
    row({ ts: '2026-01-03T00-00-00Z', nested: true, via: 'rust-audit' }),
    row({ ts: '2026-01-02T00-00-00Z', nested: false }),
  ]
  const hits = selectPriorRounds(entries, { project: '/r', branch: 'feat/x' })
  assert.equal(hits.length, 1, 'the nested row is not a candidate')
  assert.equal(hits[0]?.ts, '2026-01-02T00-00-00Z', 'and the newest TOP-LEVEL row is the predecessor')
})

// realm @nick/craft #111: the verdict from the RAW revisions a prior round's fingerprints were minted
// under — decided by whoever holds the table (the engine, which computes the fingerprints).
test('basisVerdictFromRevisions: known only when every revision is established and all share one basis', () => {
  const R = ENGINE_REVISION
  assert.deepEqual(basisVerdictFromRevisions([3], R), { sameFpBasis: true, fpBasisKnown: true })
  assert.deepEqual(basisVerdictFromRevisions([3, R], R), { sameFpBasis: true, fpBasisKnown: true }, 'one basis across a telemetry-only bump')
  assert.deepEqual(basisVerdictFromRevisions([2], R), { sameFpBasis: false, fpBasisKnown: true }, 'a known different basis')
  assert.deepEqual(basisVerdictFromRevisions([2, 3], R), { sameFpBasis: false, fpBasisKnown: false }, 'two bases')
  assert.deepEqual(basisVerdictFromRevisions([R + 1], R), { sameFpBasis: false, fpBasisKnown: false }, 'newer than this engine')
  assert.deepEqual(basisVerdictFromRevisions([], R), { sameFpBasis: false, fpBasisKnown: false }, 'nothing established')
  assert.deepEqual(basisVerdictFromRevisions([5], 5), { sameFpBasis: true, fpBasisKnown: true }, 'decided against the CALLER\'s revision')
})

// realm @nick/craft #111: a record's telemetry means the ENGINE's behaviour, so the analyzer labels it by
// the engine's own revision when the engine stamped one, not by the logger's.
test('engineRevisionToken prefers the engine\'s own revision over the logger\'s stamp', () => {
  assert.equal(engineRevisionToken({ engineRevision: 9, workflowEngineRevision: 4 }), 'r4')
  assert.equal(engineRevisionToken({ engineRevision: 3 }), 'r3', 'an engine that stamped none: the logger\'s')
  assert.equal(engineRevisionToken({}), 'r?')
  assert.equal(isEngineAttributed({ workflowEngineRevision: 4 }), true)
})

test('isCount takes only finite non-negative numbers; costProblem judges a stored cost by it', () => {
  for (const v of [0, 1, 2.5]) assert.equal(isCount(v), true, String(v))
  for (const v of [-1, Number.NaN, Infinity, '7', '', [], true, null, undefined, {}]) assert.equal(isCount(v), false, JSON.stringify(v))
  assert.equal(costProblem(undefined), 'missing')
  assert.equal(costProblem(null), 'missing')
  assert.equal(costProblem({ total: 4, output: 4 }), null)
  assert.equal(costProblem({ output: 4, input: 1 }), null, 'no total: the parts are summed')
  assert.equal(costTotal({ output: 4, input: 1 }), 5)
  assert.equal(costProblem({ total: null, cacheRead: 1000 }), null, 'a null total is absent, not zero')
  assert.equal(costTotal({ total: null, cacheRead: 1000 }), 1000)
  assert.equal(costProblem({}), 'malformed', 'enrich-cost never writes a cost without its measured fields')
  assert.equal(costProblem({ source: 'x' }), 'malformed')
  assert.equal(costProblem({ total: 0, cacheRead: 0, agents: 3 }), 'empty', 'the enrich-cost schema-drift flag (#98) stays visible')
  assert.equal(costProblem({ total: 0, cacheRead: 1000 }), 'malformed', 'a total that contradicts its parts')
  assert.equal(costProblem({ total: 0, output: 0, skipped: 2 }), 'empty', 'a lower bound of 0 bounds nothing')
  assert.equal(costProblem({ total: 10, cacheRead: 1000 }), 'malformed', 'a total that is not the sum of its parts')
  assert.equal(costProblem({ total: 1000, cacheRead: 1000, source: {} }), 'malformed', 'a source that is not a string')
  assert.equal(costProblem({ total: 1000, cacheRead: 1000, source: 'wf-1' }), null)
  assert.equal(costProblem('garbage'), 'malformed', 'present but not an object is corrupt, not missing')
  assert.equal(costProblem([1, 2]), 'malformed')
  assert.equal(costProblem({ total: '10' }), 'malformed')
  assert.equal(costProblem({ total: 10, cacheRead: true }), 'malformed')
  assert.equal(costProblem({ total: 10, skipped: 'x' }), 'malformed')
  assert.equal(costProblem({ total: 10, skipped: 2 }), 'partial')
  assert.equal(costProblem({ total: 10, skipped: 0 }), null)
})
