// A gate tool's seed finding against a remembered decision, through the real review engine
// (lib/engine-harness.mjs; realm @nick/craft, node #236): the decision that rejected one lint does not
// set aside another lint two lines below — its toolRule differs — while the same lint at the same place
// is still set aside without a judge, and a decision recorded without toolRule goes to the judge. Both
// lints share the catalog ruleId MNT-001: it is the tool's own rule name that tells them apart.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const FILE = 'src/cfg.rs'

/** A clippy-pedantic seed the gate returns. @param {Record<string, unknown>} [over] */
const seed = (over = {}) => ({
  severity: 'Medium', title: 'casting u64 to u32 may truncate the value', file: FILE, line: 43, why: 'clippy::cast_possible_truncation fired',
  fix: 'use try_from', blastRadius: '', source: 'clippy-pedantic', ruleId: 'MNT-001', toolRule: 'clippy::cast_possible_truncation', symbol: 'load', whereChecked: '', ...over,
})

// The decision that rejected lint A (needless_pass_by_value) at line 41.
const DECISION = {
  id: 'decision-aaaaaaaaaa', kind: 'decision', title: 'this argument is passed by value, but not consumed in the function body', scope: FILE, status: 'active',
  body: 'Config is Copy-cheap by design', date: '2026-10-02', author: 'alice', commit: 'abc1234', links: ['https://x/pr/9#c1'],
  line: 41, lens: 'clippy-pedantic', toolRule: 'clippy::needless_pass_by_value',
}

/** @param {any[]} seeds @param {unknown[]} records @param {unknown} [judge] */
const review = (seeds, records, judge = null) => runEngine('review', {
  args: { priorDecisions: records },
  script: {
    detect: { baseRef: 'main', files: [FILE], spec: '', branch: 'feat/x', head: 'abc9999' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: seeds, notes: '' },
    lens: (/** @type {{ opts: { label: string } }} */ { opts }) => ({ lens: String(/^lens:[^:]+:([\w-]+)/.exec(opts.label)?.[1]), findings: [] }),
    dedup: { groups: [] },
    verify: () => UPHELD,
    'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
    'decision-scope': (/** @type {{ prompt: string }} */ { prompt }) => ({ unchanged: [...prompt.matchAll(/echo '([^']+)' \$\?/g)].map(m => m[1]), missing: [], reason: '' }),
    'decision-match': judge,
    'memory-recall': null,
    synthesis: null,
    '*': null,
  },
})
/** @param {any} run */
const judgeCalls = run => run.calls.filter((/** @type {{ label: unknown }} */ c) => c.label === 'decision-match')

test('#232: a decision rejecting lint A at line 41 does not set aside lint B (Medium) at line 43', async () => {
  const run = await review([seed()], [DECISION])
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.doesNotMatch(run.report, /✅ Approve/, 'lint B stays in the verdict')
  assert.equal(judgeCalls(run).length, 0, 'another toolRule is no candidate: no judge')
  assert.match(run.report, /\[MNT-001 · tool: clippy::cast_possible_truncation\]/, 'the report prints the tool rule beside the catalog id, labelled')
})

test('review: the same lint at line 43 is set aside without a judge, matched by its toolRule', async () => {
  const run = await review([seed({ toolRule: 'clippy::needless_pass_by_value', title: 'Config passed by value but never consumed' })], [DECISION])
  assert.match(run.report, /## Rejected before \(set aside — not in the verdict\)\n- Medium[^\n]*matched by file:line\+lens\+toolRule/)
  assert.equal(judgeCalls(run).length, 0)
})

test('review: a decision recorded without toolRule is put to the judge for a tool finding', async () => {
  const old = { ...DECISION, toolRule: undefined }
  const run = await review([seed()], [old], { verdicts: [{ pair: 0, same: false, why: 'another lint' }] })
  assert.equal(judgeCalls(run).length, 1)
  assert.doesNotMatch(run.report, /## Rejected before/)
})

test('review: a tool rule without a catalog id is printed labelled, never as a lone bracket a catalog id could be read from', async () => {
  const run = await review([seed({ ruleId: '' })], [])
  assert.match(run.report, / · \[tool: clippy::cast_possible_truncation\] · /)
  assert.doesNotMatch(run.report, /\[clippy::cast_possible_truncation\]/)
})

const NIX = 'flake.nix'
/** A deadnix seed on flake.nix. @param {Record<string, unknown>} over */
const nixSeed = over => seed({ file: NIX, source: 'deadnix', toolRule: undefined, why: 'deadnix reported it', ...over })
/** A review of one deadnix seed on flake.nix against `decision`, the judge given as `judge`. @param {unknown} decision @param {Record<string, unknown>} over @param {unknown} judge */
const nixReview = (decision, over, judge) => nixReviewOf(decision, [nixSeed(over)], judge)
/** A review of these seeds on flake.nix against `decision`. @param {unknown} decision @param {any[]} seeds @param {unknown} judge */
const nixReviewOf = (decision, seeds, judge) => runEngine('review', {
  args: { priorDecisions: decision ? [decision] : [] },
  script: {
    detect: { baseRef: 'main', files: [NIX], spec: '', branch: 'feat/x', head: 'abc9999' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['purity'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: seeds, notes: '' },
    lens: (/** @type {{ opts: { label: string } }} */ { opts }) => ({ lens: String(/^lens:[^:]+:([\w-]+)/.exec(opts.label)?.[1]), findings: [] }),
    dedup: { groups: [] },
    verify: () => UPHELD,
    'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
    'decision-scope': (/** @type {{ prompt: string }} */ { prompt }) => ({ unchanged: [...prompt.matchAll(/echo '([^']+)' \$\?/g)].map(m => m[1]), missing: [], reason: '' }),
    'decision-match': judge,
    'memory-recall': null,
    synthesis: null,
    '*': null,
  },
})

test('review: a deadnix seed with the same title at the place of a decision is set aside without a judge, even with the judge down (#236)', async () => {
  const decision = { ...DECISION, title: 'Unused let binding: pkgs', scope: NIX, line: 10, lens: 'deadnix', toolRule: undefined }
  const run = await nixReview(decision, { line: 11, title: 'unused let binding:  pkgs' }, () => { throw new Error('judge down') })
  assert.match(run.report, /## Rejected before \(set aside — not in the verdict\)\n- Medium[^\n]*matched by file:line\+lens\+title/)
  assert.equal(judgeCalls(run).length, 0)
})

test('review #237: a decision on deadnix binding pkgs puts binding self on the same line to the judge, not set aside', async () => {
  const decision = { ...DECISION, title: 'Unused lambda pattern: pkgs', scope: NIX, line: 3, lens: 'deadnix', toolRule: undefined }
  const run = await nixReview(decision, { line: 3, title: 'Unused lambda pattern: self' }, { verdicts: [{ pair: 0, same: false, why: 'another binding' }] })
  assert.equal(judgeCalls(run).length, 1, 'the judge decides the pair')
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.doesNotMatch(run.report, /✅ Approve/, 'self stays in the verdict')
})

test('review #237 with the judge down: binding self stays in the verdict, the reason named', async () => {
  const decision = { ...DECISION, title: 'Unused lambda pattern: pkgs', scope: NIX, line: 3, lens: 'deadnix', toolRule: undefined }
  const run = await nixReview(decision, { line: 3, title: 'Unused lambda pattern: self' }, () => { throw new Error('judge down') })
  assert.equal(judgeCalls(run).length, 1)
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.doesNotMatch(run.report, /✅ Approve/, 'self stays in the verdict')
  assert.match(run.report, /tool finding\(s\) naming no rule had a candidate record the judge gave no verdict on and no tool record with the same title — raised/)
})

test('review: the Nix gate prompt asks for the deadnix message verbatim and a fixed formatter title as the seed title', async () => {
  const decision = { ...DECISION, title: 'Unused lambda pattern: pkgs', scope: NIX, line: 3, lens: 'deadnix', toolRule: undefined }
  const run = await nixReview(decision, { line: 3, title: 'Unused lambda pattern: pkgs' }, null)
  const gate = run.calls.find((/** @type {{ label: unknown }} */ c) => c.label === 'gate:nix')
  assert.match(String(gate?.prompt), /A deadnix seed's `title` is deadnix's own diagnostic message for that binding, copied verbatim/)
  assert.match(String(gate?.prompt), /a formatter seed's `title` is the fixed form "File not formatted: <path>"/)
})

test('review #237 through dedup: deadnix seeds for pkgs and self on one line are not merged — self stays in the verdict, in either order', async () => {
  const decision = { ...DECISION, title: 'Unused lambda pattern: pkgs', scope: NIX, line: 3, lens: 'deadnix', toolRule: undefined }
  const pkgs = nixSeed({ line: 3, title: 'Unused lambda pattern: pkgs' })
  const self = nixSeed({ line: 3, title: 'Unused lambda pattern: self' })
  for (const seeds of [[pkgs, self], [self, pkgs]]) {
    const run = await nixReviewOf(decision, seeds, { verdicts: [{ pair: 0, same: false, why: 'another binding' }] })
    assert.match(run.report, /## Rejected before \(set aside — not in the verdict\)\n- Medium[^\n]*Unused lambda pattern: pkgs/, 'pkgs set aside by its record')
    const verdict = run.report.split('## Rejected before')[0] ?? ''
    assert.match(verdict, /Unused lambda pattern: self/, 'self is raised')
    assert.doesNotMatch(run.report, /✅ Approve/)
  }
})

test('review: two clippy seeds with different toolRule on one line are not merged by the same-spot dedup', async () => {
  const a = seed({ line: 43, title: 'casting u64 to u32 may truncate the value here', toolRule: 'clippy::cast_possible_truncation' })
  const b = seed({ line: 43, title: 'casting u64 to u32 may lose the sign of the value here', toolRule: 'clippy::cast_sign_loss' })
  const run = await review([a, b], [])
  assert.match(run.report, /tool: clippy::cast_possible_truncation/)
  assert.match(run.report, /tool: clippy::cast_sign_loss/)
})

test('review: a whole-file fmt seed with the title of a decision is set aside without a judge, even with the judge down (#236)', async () => {
  const decision = { ...DECISION, title: 'File not formatted: flake.nix', scope: NIX, line: undefined, lens: 'fmt', toolRule: undefined }
  const run = await nixReviewOf(decision, [nixSeed({ source: 'fmt', line: 0, title: 'File not formatted: flake.nix' })], () => { throw new Error('judge down') })
  assert.match(run.report, /## Rejected before \(set aside — not in the verdict\)\n- Medium[^\n]*matched by file\+lens\+title/)
  assert.equal(judgeCalls(run).length, 0)
})

test('review: a whole-file fmt seed with another title stays raised with the judge down', async () => {
  const decision = { ...DECISION, title: 'File not formatted: flake.nix', scope: NIX, line: undefined, lens: 'fmt', toolRule: undefined }
  const run = await nixReviewOf(decision, [nixSeed({ source: 'fmt', line: 0, title: 'flake.nix needs alejandra' })], () => { throw new Error('judge down') })
  assert.equal(judgeCalls(run).length, 1, 'put to the judge')
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.doesNotMatch(run.report, /✅ Approve/)
})

test('review: two source-less tool seeds for pkgs and self on one line are not merged by the dedup (#238)', async () => {
  const bare = (/** @type {string} */ title) => nixSeed({ source: undefined, line: 3, title })
  const run = await nixReviewOf(null, [bare('Unused lambda pattern: pkgs'), bare('Unused lambda pattern: self')], null)
  assert.match(run.report, /Unused lambda pattern: pkgs/)
  assert.match(run.report, /Unused lambda pattern: self/)
})

test('review: a source-less seed for self is not set aside by the record for pkgs with the judge down; its own record sets it aside without one (#236)', async () => {
  const decision = { ...DECISION, title: 'Unused lambda pattern: pkgs', scope: NIX, line: 3, lens: 'tool', toolRule: undefined }
  const raised = await nixReviewOf(decision, [nixSeed({ source: undefined, line: 3, title: 'Unused lambda pattern: self' })], () => { throw new Error('judge down') })
  assert.doesNotMatch(raised.report, /## Rejected before/)
  assert.doesNotMatch(raised.report, /✅ Approve/, 'self stays in the verdict')
  assert.match(raised.report, /tool finding\(s\) naming no rule had a candidate record the judge gave no verdict on and no tool record with the same title — raised/)
  const own = await nixReviewOf(decision, [nixSeed({ source: undefined, line: 3, title: 'Unused lambda pattern: pkgs' })], () => { throw new Error('judge down') })
  assert.equal(judgeCalls(own).length, 0, 'no judge call')
  assert.match(own.report, /## Rejected before/)
})

test('review: a source-less seed with the title of a clippy decision at its line is put to the judge; judge down, the same title sets it aside (#236)', async () => {
  const bare = seed({ source: undefined, toolRule: undefined, line: 41, title: DECISION.title })
  const run = await review([bare], [DECISION], () => { throw new Error('judge down') })
  assert.equal(judgeCalls(run).length, 1, 'the record names a rule the seed cannot: the judge first')
  assert.match(run.report, /## Rejected before \(set aside — not in the verdict\)\n- Medium[^\n]*matched by the same title near its line/)
})

test('review: both gate prompts ask for the tool message verbatim as the seed title; a reworded clippy seed without toolRule stays raised with the judge down (#236)', async () => {
  const nix = await nixReview(null, { line: 3, title: 'x' }, null)
  assert.match(String(nix.calls.find((/** @type {{ label: unknown }} */ c) => c.label === 'gate:nix')?.prompt), /A statix seed's `title` is statix's own message for that finding, copied verbatim/)
  const reworded = seed({ toolRule: undefined, line: 41, title: 'argument passed by value but never consumed in the body' })
  const run = await review([reworded], [DECISION], () => { throw new Error('judge down') })
  assert.match(String(run.calls.find((/** @type {{ label: unknown }} */ c) => c.label === 'gate:rust')?.prompt), /without `toolRule` the title is all that matches a past decision/)
  assert.doesNotMatch(run.report, /## Rejected before/, 'shared words never set a tool finding aside: raised, the cost of a reworded title')
})
