// A memory backend that keeps its own ids (an MCP server with its own write skill): its recalled record
// carries a foreign id, a launcher's hand-built copy of the same record carries none and gets the skill's
// id. The two are one record — keyed by the id derived from kind, title and scope — so a withdrawn record
// cannot return through the passed copy; and the recall agent is asked for the skill's id with the
// store's own one in links (realm @nick/craft, node #222). A record without a scope is the whole repo.
import crypto from 'node:crypto'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { memoryRecallPrompt, mergeById } from './memory-recall.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
/** @param {string} kind @param {string} title @param {string} scope */
const skillId = (kind, title, scope) => `${kind}-${crypto.createHash('sha256').update(`${kind}\n${title}\n${scope}`).digest('hex').slice(0, 10)}`

const TITLE = 'unwrap in parser may panic'
const FINDING = { severity: 'Medium', title: TITLE, file: 'src/parse.rs', line: 12, why: 'w', fix: 'f', blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: 's', whereChecked: '' }
const STORED = { id: 'node-1849', kind: 'decision', title: TITLE, body: 'the store says so', scope: 'src/parse.rs', status: 'active', date: '2026-10-01', author: 'alice', commit: 'abc1234', links: ['https://x/pr/1#c1'] }
const PASSED = { kind: 'decision', title: TITLE, body: 'an old reason from a thread', scope: 'src/parse.rs', date: '2026-09-01', author: 'bob', commit: 'abc1234', links: ['https://x/pr/1#c0'] }

/** @param {unknown} recall */
const script = recall => ({
  detect: { baseRef: 'main', files: ['src/parse.rs'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? [FINDING] : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  'decision-scope': (/** @type {{ prompt: string }} */ { prompt }) => ({ unchanged: [...prompt.matchAll(/echo '([^']+)' \$\?/g)].map(m => m[1]), reason: '' }),
  'memory-recall': recall,
  synthesis: null,
  '*': null,
})

test('foreign id: a recalled record with the store\'s own id and a hand-built passed copy without one are one record, the recalled kept', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [PASSED] }, script: script({ backend: 'mcp', why: 'w', decisions: [STORED] }) })
  assert.match(run.report, /REJECTED BEFORE: the store says so[^\n]*\(decision node-1849\)/)
  assert.doesNotMatch(run.report, /an old reason from a thread|repeats an id/)
  assert.match(run.report, /plus 1 passed by the launcher \(0 new\)/)
})

test('foreign id: a recalled record that is no longer active keeps its passed stale copy out', async () => {
  for (const status of ['superseded', 'withdrawn']) {
    const run = await runEngine('review', { args: { priorDecisions: [PASSED] }, script: script({ backend: 'mcp', why: 'w', decisions: [{ ...STORED, status }] }) })
    assert.doesNotMatch(run.report, /REJECTED BEFORE/, status)
    assert.doesNotMatch(run.report, /an old reason from a thread/, status)
    assert.match(run.report, /plus 1 passed by the launcher \(0 new\)/, status)
  }
})

test('foreign id: mergeById keys on the derived id when the ids differ, both records carrying kind, title and scope', () => {
  const passedWithId = { ...PASSED, id: skillId('decision', TITLE, 'src/parse.rs') }
  assert.deepEqual(mergeById([STORED], [PASSED, passedWithId]).addedAt, [])
  const other = { ...PASSED, title: 'another title entirely' }
  assert.deepEqual(mergeById([STORED], [other]).addedAt, [0], 'a different title is a different record')
})

test('foreign id: the recall prompt asks for the skill id in id and the store\'s own id in links as store: <id>', () => {
  const p = memoryRecallPrompt(['src/a.rs'], 'main')
  assert.match(p, /`store: <id>`/)
  assert.match(p, /sha256\("<kind>\\n<title>\\n<scope>"\)/)
  assert.match(p, /derive it from kind, title and scope/)
})

test('scope default: a record with kind, title and reason but no scope is the whole repo — its id derived with scope .', async () => {
  const noScope = Object.fromEntries(Object.entries(PASSED).filter(([k]) => k !== 'scope'))
  const run = await runEngine('review', { args: { priorDecisions: [noScope] }, script: script({ backend: 'repo', why: 'w', decisions: [] }) })
  assert.doesNotMatch(run.report, /## Prior decisions not applied/)
  assert.match(run.report, new RegExp(`REJECTED BEFORE: an old reason from a thread[^\\n]*\\(decision ${skillId('decision', TITLE, '.')}\\)`))
})
