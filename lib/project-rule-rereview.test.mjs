// A finding a project rule covered is persisted `covered`, never as a dismissal (realm @nick/craft, node
// #273): the re-review adjudicates it like an open prior and the rules, recalled again, decide again — so a
// rule withdrawn since lets the finding back into the verdict. Through the real review engine.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { fingerprint } from './run-record.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const FILE = 'crates/node/src/db.rs'
const TITLE = 'migration has no down step'
const RULE = { kind: 'rule', title: 'we do not support rollback', scope: 'crates/node', body: 'deploys only go forward', status: 'active', date: '2026-10-20', author: 'nick', links: [] }
const FINDING = { severity: 'Medium', title: TITLE, file: FILE, line: 12, why: 'a deploy cannot be rolled back', fix: 'add a down step', blastRadius: '', source: 'compat', ruleId: 'CMP-001', symbol: 'migrate', whereChecked: '' }
const covers = (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: JSON.parse(String(prompt.match(/^\[\{"pair".*\]$/m)?.[0])).map((/** @type {{ pair: number }} */ p) => ({ pair: p.pair, covered: true, why: 'rollback is not supported here' })) })

/** @param {unknown} prior the prior round, or null for a first round */
const scriptFor = prior => ({
  detect: { baseRef: 'main', files: [FILE], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': prior ?? { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-B', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['compat'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  // A first round finds it; a re-review's delta does not raise it again — only the prior carries it.
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'compat', findings: !prior && callIndex === 0 ? [FINDING] : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  adjudicate: { status: 'still-open', note: '', attack: '', currentLine: 12 },
  carry: { changed: false, reason: 'unchanged' },
  'rule-match': covers,
  'memory-recall': null,
  synthesis: null,
  '*': null,
})

/** @param {any} run */
const rowsOf = run => /** @type {any[]} */ ((filedRecord(run) || {}).ledger || []).filter(e => e.file === FILE && e.disposition !== 'closed')

test('a covered finding is persisted `covered`; the re-review without the rule raises it again, with the rule covers it again', async () => {
  const first = await runEngine('review', { args: { priorDecisions: [RULE] }, script: scriptFor(null) })
  assert.match(first.report, /✅ Approve/)
  const rows = rowsOf(first)
  assert.deepEqual(rows.map(e => e.disposition), ['covered'], 'not a dismissal')
  const row = { ...rows[0], fp: fingerprint(rows[0]) }
  const prior = { found: true, round: 1, head: 'abc0000', ledgerCount: 1, priorFindings: 1, reason: '', ledger: [row], sameFpBasis: true }

  const withdrawn = await runEngine('review', { args: {}, script: scriptFor(prior) })
  assert.equal(withdrawn.calls.filter(c => /^carry:/.test(c.label)).length, 0, 'never carried as a dismissal')
  assert.ok(withdrawn.calls.some(c => /^adjudicate/.test(c.label)), 'adjudicated like an open prior')
  assert.doesNotMatch(withdrawn.report, /## Covered by project rules/)
  assert.match(withdrawn.report, /⚠️ Warning/, 'back in the verdict')
  assert.deepEqual(rowsOf(withdrawn).map(e => e.disposition), ['open'])

  const kept = await runEngine('review', { args: { priorDecisions: [RULE] }, script: scriptFor(prior) })
  assert.match(kept.report, /## Covered by project rules \(not in the verdict\)\n- Medium[^\n]*migration has no down step · rule rule-/)
  assert.match(kept.report, /✅ Approve/)
  assert.deepEqual(rowsOf(kept).map(e => e.disposition), ['covered'])
})
