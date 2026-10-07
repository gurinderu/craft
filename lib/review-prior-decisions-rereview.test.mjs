// Prior decisions on a RE-REVIEW, through the real review engine (lib/engine-harness.mjs). The flow the
// skills prescribe: round 1 posts finding F, the author rejects it, the decision is recorded and the
// re-review is launched with it. On that round F is a live prior — adjudicated still-open (or
// regressed), its fresh duplicate absorbed into it — and the decision must reach it there too.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { fingerprint } from './run-record.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const TITLE = 'unwrap in parser may panic'

/** @param {string} severity */
const finding = severity => ({
  severity, title: TITLE, file: 'src/parse.rs', line: 12, why: 'panics on bad input', fix: 'return an error',
  blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: 'parse', whereChecked: '',
})
/** @param {string} severity */
const priorRow = severity => {
  const base = { file: 'src/parse.rs', line: 12, symbol: 'parse', severity, tier: 'confirmed', disposition: 'open', source: 'safety', ruleId: 'ERR-001', title: TITLE, why: 'panics on bad input' }
  return { fp: fingerprint(base), ...base }
}
const DECISION = {
  id: 'decision-46833ecec3', title: TITLE, scope: 'src/parse.rs',
  reason: 'input is validated upstream', who: 'alice', when: '2026-10-01', link: 'https://x/pr/1#c2', commit: 'abc1234',
}

/** @param {{ severity: string, status?: string, scope?: unknown }} o */
const scriptFor = ({ severity, status = 'still-open', scope = { unchanged: [DECISION.id], reason: '' } }) => ({
  detect: { baseRef: 'main', files: ['src/parse.rs'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: true, round: 1, head: 'abc0000', ledgerCount: 1, priorFindings: 1, reason: '', ledger: [priorRow(severity)], sameFpBasis: true },
  checkpoint: { runDir: '/store/.partial/run-B', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? [finding(severity)] : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  adjudicate: { status, note: status === 'regressed' ? 'a different panic now' : '', attack: '', currentLine: 12 },
  redteam: { defeated: false, attack: '' },
  carry: { changed: false, reason: 'unchanged' },
  'decision-scope': scope,
  synthesis: null,
  '*': null,
})

/** @param {any} run */
const ledgerOf = run => /** @type {any[]} */ ((filedRecord(run) || {}).ledger || [])

for (const status of ['still-open', 'regressed']) {
  test(`prior decisions on a re-review: a ${status} Medium prior the decision answers is set aside, out of the verdict, persisted as rejected`, async () => {
    const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ severity: 'Medium', status }) })
    assert.match(run.report, /## Rejected before \(set aside — not in the verdict\)/)
    assert.match(run.report, /REJECTED BEFORE: input is validated upstream — alice/)
    assert.match(run.report, /✅ Approve/, 'the rejected prior does not hold the verdict at Warning')
    const rows = ledgerOf(run).filter(e => e.file === 'src/parse.rs' && e.disposition !== 'closed')
    assert.deepEqual(rows.map(e => e.disposition), ['rejected'], 'one row, carried as a dismissal')
  })
}

test('prior decisions on a re-review: a still-open High prior is raised again', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ severity: 'High' }) })
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.match(run.report, /⛔ Block/)
  assert.match(run.report, /raised again: a Critical\/High finding is never set aside/)
})

test('prior decisions on a re-review: a still-open Medium prior whose scope changed is raised again', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [DECISION] }, script: scriptFor({ severity: 'Medium', scope: { unchanged: [], reason: '' } }) })
  assert.doesNotMatch(run.report, /## Rejected before/)
  assert.match(run.report, /⚠️ Warning/)
  assert.match(run.report, /changed since abc1234/)
})
