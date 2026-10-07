// A memory backend that keeps its own ids (an MCP server with its own write skill): its recalled record
// carries a foreign id, a launcher's hand-built copy of the same record carries none and gets the skill's
// id. The two are one record — keyed by the id derived from kind, title and scope — and the ENGINE sets
// the recalled record's id to the skill's, keeping the store's own in links as `store: <id>`. A record the
// store withdrew or superseded comes back only in the recall's `inactive` list and blocks any passed copy
// (realm @nick/craft, nodes #222, #224). A record without an id and without a scope is refused by name.
import crypto from 'node:crypto'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { memoryRecallPrompt, mergeById, readMemoryRecall } from './memory-recall.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
/** @param {string} kind @param {string} title @param {string} scope */
const skillId = (kind, title, scope) => `${kind}-${crypto.createHash('sha256').update(`${kind}\n${title}\n${scope}`).digest('hex').slice(0, 10)}`

const TITLE = 'unwrap in parser may panic'
const FINDING = { severity: 'Medium', title: TITLE, file: 'src/parse.rs', line: 12, why: 'w', fix: 'f', blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: 's', whereChecked: '' }
const STORED = { id: 'node-1849', kind: 'decision', title: TITLE, body: 'the store says so', scope: 'src/parse.rs', status: 'active', date: '2026-10-01', author: 'alice', commit: 'abc1234', links: ['https://x/pr/1#c1'] }
const PASSED = { kind: 'decision', title: TITLE, body: 'an old reason from a thread', scope: 'src/parse.rs', date: '2026-09-01', author: 'bob', commit: 'abc1234', links: ['https://x/pr/1#c0'] }
const SKILL_ID = skillId('decision', TITLE, 'src/parse.rs')

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

test('foreign id: a recalled record with the store\'s own id and a hand-built passed copy without one are one record, the recalled kept under the skill id', async () => {
  const run = await runEngine('review', { args: { priorDecisions: [PASSED] }, script: script({ backend: 'mcp', why: 'w', decisions: [STORED] }) })
  assert.match(run.report, new RegExp(`REJECTED BEFORE: the store says so[^\\n]*\\(decision ${SKILL_ID}\\)`))
  assert.doesNotMatch(run.report, /an old reason from a thread|repeats an id/)
  assert.match(run.report, /plus 1 passed by the launcher \(0 new\)/)
})

test('inactive: a record the store withdrew or superseded, returned in inactive, blocks the passed copy — named once', async () => {
  for (const status of ['superseded', 'withdrawn']) {
    const inactive = [{ id: 'node-1849', kind: 'decision', title: TITLE, scope: 'src/parse.rs', status }]
    const run = await runEngine('review', { args: { priorDecisions: [PASSED] }, script: script({ backend: 'mcp', why: 'w', decisions: [], inactive }) })
    assert.doesNotMatch(run.report, /REJECTED BEFORE/, status)
    assert.doesNotMatch(run.report, /an old reason from a thread/, status)
    assert.equal(run.report.match(new RegExp(`passed decision #0 \\(${SKILL_ID}\\) not applied: ${status} in memory`, 'g'))?.length, 1, status)
  }
})

test('inactive: the block holds by the store\'s own id too, and an unrelated passed record is applied', async () => {
  const inactive = [{ id: 'node-1849', storeId: 'node-1849', kind: 'decision', title: 'renamed since', scope: 'src/parse.rs', status: 'withdrawn' }]
  const byStoreId = { ...PASSED, id: 'node-1849' }
  const run = await runEngine('review', { args: { priorDecisions: [byStoreId] }, script: script({ backend: 'mcp', why: 'w', decisions: [], inactive }) })
  assert.match(run.report, /passed decision #0 \(node-1849\) not applied: withdrawn in memory/)
  assert.doesNotMatch(run.report, /REJECTED BEFORE/)
  const other = await runEngine('review', { args: { priorDecisions: [PASSED] }, script: script({ backend: 'mcp', why: 'w', decisions: [], inactive }) })
  assert.match(other.report, /REJECTED BEFORE: an old reason from a thread/)
})

test('foreign id: mergeById keys on the derived id when the ids differ, both records carrying kind, title and scope', () => {
  const passedWithId = { ...PASSED, id: SKILL_ID }
  assert.deepEqual(mergeById([STORED], [PASSED, passedWithId]).addedAt, [])
  const other = { ...PASSED, title: 'another title entirely' }
  assert.deepEqual(mergeById([STORED], [other]).addedAt, [0], 'a different title is a different record')
})

test('foreign id: the engine sets the id — a store id, or a wrong hash beside a store: link, becomes the skill id; the store id kept in links', () => {
  const [stored] = readMemoryRecall({ backend: 'mcp', why: 'w', decisions: [STORED] }, 0).decisions
  assert.deepEqual(stored, { ...STORED, id: SKILL_ID, links: [...STORED.links, 'store: node-1849'] })
  const wrong = { ...STORED, id: 'decision-0123456789', links: ['store: node-1849'] }
  assert.deepEqual(readMemoryRecall({ backend: 'mcp', why: 'w', decisions: [wrong] }, 0).decisions, [{ ...wrong, id: SKILL_ID }])
  const right = { ...STORED, id: SKILL_ID, links: [] }
  assert.deepEqual(readMemoryRecall({ backend: 'repo', why: 'w', decisions: [right] }, 0).decisions, [right], 'a skill id is left as it is')
})

test('foreign id: the recall prompt asks for kind, title, scope and the store id in links, and for the inactive ids — never a hash', () => {
  const p = memoryRecallPrompt(['src/a.rs'], 'main')
  assert.match(p, /`store: <id>`/)
  assert.doesNotMatch(p, /sha256/)
  assert.match(p, /inactive[\s\S]*superseded[\s\S]*withdrawn/)
  assert.match(p, /\{id, storeId, kind, title, scope, status\}/)
})

test('scope: a record without an id and without a scope is refused by name; one with an id and no scope is the whole repo', async () => {
  const noScope = Object.fromEntries(Object.entries(PASSED).filter(([k]) => k !== 'scope'))
  const run = await runEngine('review', { args: { priorDecisions: [noScope] }, script: script({ backend: 'repo', why: 'w', decisions: [] }) })
  assert.match(run.report, /## Prior decisions not applied\n- ⚠️ passed decision #0 lacks an id, and the kind or the scope its id is derived from\n/)
  assert.doesNotMatch(run.report, /REJECTED BEFORE/)
  const withId = await runEngine('review', { args: { priorDecisions: [{ ...noScope, id: 'decision-own' }] }, script: script({ backend: 'repo', why: 'w', decisions: [] }) })
  assert.match(withId.report, /REJECTED BEFORE: an old reason from a thread[^\n]*\(decision decision-own\)/)
})
