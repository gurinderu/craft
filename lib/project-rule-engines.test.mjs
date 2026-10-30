// Project rules through the real engines (realm @nick/craft, node #273; lib/engine-harness.mjs): review and
// adversarial-review ask ONE rule judge after the decisions; a covered finding leaves the verdict and the
// PR comments for its own section; a Critical one is raised; a dead judge covers nothing and says so; the
// run record counts what was covered; rust-audit forwards recalled rules to its nested reviews.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { filedRecord, runEngine } from './engine-harness.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const FILE = 'crates/node/src/db.rs'
const RULE = { kind: 'rule', title: 'we do not support rollback', scope: 'crates/node', body: 'deploys only go forward', status: 'active', date: '2026-10-20', author: 'nick', links: [] }

/** @param {Record<string, unknown>} [over] */
const finding = (over = {}) => ({
  severity: 'Medium', title: 'migration has no down step', file: FILE, line: 12, why: 'a deploy cannot be rolled back', fix: 'add a down step',
  blastRadius: '', source: 'compat', ruleId: '', symbol: 'migrate', whereChecked: '', ...over,
})

/** @param {any[]} findings */
const lensOnce = findings => {
  const seen = new Set()
  return (/** @type {{ opts: { label: string } }} */ { opts }) => {
    const lens = String(/^lens:[^:]+:([\w-]+)/.exec(opts.label)?.[1])
    const first = !seen.has(lens)
    seen.add(lens)
    return { lens, findings: first ? findings.filter(f => f.source === lens) : [] }
  }
}

/** @param {boolean} covered */
const judgeSays = covered => (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: JSON.parse(String(prompt.match(/^\[\{"pair".*\]$/m)?.[0])).map((/** @type {{ pair: number }} */ p) => ({ pair: p.pair, covered, why: 'rollback is not supported here' })) })

/** @param {any[]} findings @param {unknown} judge @param {unknown} [recall] */
const review = (findings, judge, recall = null) => runEngine('review', { args: { priorDecisions: [RULE], comment: true }, script: {
  detect: { baseRef: 'main', files: [FILE], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, output: ['wrote r.json'] },
  scout: { sizeBucket: 'small', lenses: ['compat', 'errors'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: lensOnce(findings),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  'rule-match': judge,
  'pr-comments': { posted: 1, reason: 'PR #9' },
  'memory-recall': recall,
  synthesis: null,
  '*': null,
} })
/** @param {any} run @param {string} label */
const calls = (run, label) => run.calls.filter((/** @type {{ label: unknown }} */ c) => c.label === label)

test('review: a finding the judge puts under a rule leaves the verdict and the PR comments, listed with the rule', async () => {
  const run = await review([finding()], judgeSays(true))
  assert.equal(calls(run, 'rule-match').length, 1)
  assert.equal(calls(run, 'decision-match').length, 0, 'a rule is not matched as a decision')
  assert.match(run.report, /## Covered by project rules \(not in the verdict\)\n- Medium · `crates\/node\/src\/db\.rs:12` · migration has no down step · rule rule-[0-9a-f]{10} "we do not support rollback" · covered by judge: rollback is not supported here/)
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.match(run.report, /✅ Approve/)
  assert.equal(calls(run, 'pr-comments').length, 0, 'nothing confirmed is left to post')
  assert.equal(filedRecord(run).memory.covered, 1)
})

test('review: a Critical finding is raised even under a rule; a High one is covered', async () => {
  const run = await review([finding({ severity: 'Critical' }), finding({ severity: 'High', line: 30, title: 'no down step for the index migration' })], judgeSays(true))
  assert.match(run.report, /- ⚠️ Critical "migration has no down step" @ crates\/node\/src\/db\.rs:12 RAISED — a Critical finding is raised even under rule/)
  assert.match(run.report, /- High · `crates\/node\/src\/db\.rs:30` · no down step for the index migration · rule /)
  assert.match(run.report, /⛔ Block/)
  // The raised Critical is a compat finding about a migration: doubtful, so it goes to the reviewer, not the
  // PR (realm @nick/craft, node #277); the covered High is in neither list.
  assert.equal(calls(run, 'pr-comments').length, 0)
  assert.match(run.report, /## Doubtful — for the reviewer, not posted\n[^\n]*\n1\. Critical · `crates\/node\/src\/db\.rs:12` · migration has no down step · doubtful: raised by the compat lens; it speaks of rollback/)
  assert.doesNotMatch(run.report.slice(run.report.indexOf('## Doubtful')), /no down step for the index migration/)
})

test('review: the judge saying no, or dying, leaves the finding in the verdict — a dead judge is named', async () => {
  const no = await review([finding()], judgeSays(false))
  assert.match(no.report, /⚠️ Warning/)
  assert.doesNotMatch(no.report, /## Covered by project rules/)
  const dead = await review([finding()], null)
  assert.match(dead.report, /⚠️ Warning/)
  assert.match(dead.report, /## Covered by project rules \(not in the verdict\)\n- ⚠️ 1 finding\(s\) in a project rule's scope NOT covered — the rule judge died or answered unreadably/)
  assert.equal(filedRecord(dead).memory.covered, 0)
})

/** @param {unknown} judge @param {string} severity */
const adversarial = (judge, severity = 'medium') => runEngine('adversarial-review', { args: { priorDecisions: [RULE] }, script: {
  scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: [FILE], notes: 'x' },
  'index-warmup': { indexed: false, notes: 'x' },
  review: { findings: [{ title: 'migration has no down step', file: FILE, line: 12, severity, description: 'd', fix: 'f', whereChecked: '' }] },
  'coverage-critic': { findings: [] },
  'rule-match': judge,
  'memory-recall': null,
  'log-run': { ok: true },
  '*': (/** @type {{ opts: { label?: string } }} */ { opts }) => (/^verify/.test(String(opts.label)) ? { refuted: false, premiseSupported: true, reasoning: 'ok', severity } : null),
} })

test('adversarial-review: a covered finding moves to coveredByRule and out of the verdict; a dead judge leaves it with a notice', async () => {
  const covered = await adversarial(judgeSays(true))
  assert.equal(covered.reportValue.verdict, 'Approve')
  assert.equal(covered.reportValue.coveredByRule?.length, 1)
  assert.match(covered.reportValue.coveredByRule[0].priorMatch, /covered by judge/)
  const critical = await adversarial(judgeSays(true), 'critical')
  assert.equal(critical.reportValue.verdict, 'Block')
  assert.match(String(critical.reportValue.ruleNotices?.[0]), /RAISED/)
  const dead = await adversarial(null)
  assert.equal(dead.reportValue.verdict, 'Warning')
  assert.equal(dead.reportValue.coveredByRule, undefined)
  assert.match(String(dead.reportValue.ruleNotices?.[0]), /NOT covered — the rule judge died/)
})

test('rust-audit: rules its recall returns are forwarded to every nested review, counted on its memory line', async () => {
  const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
  const run = await runEngine('rust-audit', { args: {}, script: {
    scout: { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'a' }], changedCrates: [{ name: 'a', path: 'a' }], edges: [], repoRoot: '/r', notes: 'n' },
    workflow: () => '## Verdict\n✅ Approve', synthesis: 'the audit body', 'memory-recall': { backend: 'repo', why: 'w', decisions: [], rules: [RULE] }, '*': green,
  } })
  const nested = calls(run, 'workflow')
  assert.ok(nested.length >= 1)
  for (const c of nested) assert.equal(/** @type {any[]} */ (c.argv)[1].priorDecisions[0].kind, 'rule')
  assert.match(run.report, /memory: returned 0 decision\(s\) and 1 project rule\(s\) from repo/)
})

test('review: a passed rule the store names withdrawn is held back and covers nothing', async () => {
  const recall = { backend: 'repo', why: 'w', decisions: [], rules: [], inactive: [{ kind: 'rule', title: RULE.title, scope: RULE.scope, status: 'withdrawn', date: '2026-10-21' }] }
  const run = await review([finding()], judgeSays(true), recall)
  assert.equal(calls(run, 'rule-match').length, 0)
  assert.doesNotMatch(run.report, /## Covered by project rules/)
  assert.match(run.report, /⚠️ Warning/)
  assert.match(run.report, /not applied: withdrawn in memory/)
})
