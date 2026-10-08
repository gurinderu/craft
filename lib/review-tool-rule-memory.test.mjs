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
/** A review of one deadnix seed on flake.nix against `decision`, the judge given as `judge`. @param {unknown} decision @param {Record<string, unknown>} over @param {unknown} judge */
const nixReview = (decision, over, judge) => runEngine('review', {
  args: { priorDecisions: [decision] },
  script: {
    detect: { baseRef: 'main', files: [NIX], spec: '', branch: 'feat/x', head: 'abc9999' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['purity'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [seed({ file: NIX, source: 'deadnix', toolRule: undefined, why: 'deadnix reported it', ...over })], notes: '' },
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
