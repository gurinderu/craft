// Direct unit tests of lib/review-coverage-phase.mjs: the language pin, the coverage decision's early
// exits (their run records and reports), the memory recall dispatch and the uncovered-file accounting,
// with the review run's collaborators faked.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { coveragePhase } from './review-coverage-phase.mjs'
import { MEMORY_RECALL_SCHEMA, initialMemory } from './memory-recall.mjs'
import { noChangedFilesMessage, onTrunkMessage, nothingToReviewMessage, noLanguageMessage } from './review-coverage.mjs'
import { PROFILES } from './review-profiles.mjs'

/**
 * @param {string[]} changedFiles
 * @param {{ requestedLangs?: unknown, baseRef?: string, head?: string, branch?: string, detected?: any, baseArg?: string, viaArg?: string, recalledByLauncher?: boolean, answer?: unknown }} [o]
 */
async function phase(changedFiles, o = {}) {
  /** @type {any[]} */ const records = []
  /** @type {any[]} */ const calls = []
  /** @type {string[]} */ const logs = []
  const reviewRun = /** @type {any} */ ({
    craftVersion: '9.9', A: {}, baseArg: o.baseArg ?? '', scopeNotRun: ['scope'], scopeSection: () => '\nSCOPE', viaArg: o.viaArg ?? '',
    recalledByLauncher: !!o.recalledByLauncher, requestedLangs: o.requestedLangs,
    ragent: async (/** @type {string} */ prompt, /** @type {any} */ opts) => { calls.push({ prompt, ...opts }); return o.answer ?? null },
    logRun: async (/** @type {any} */ r) => { records.push(r) },
    out: (/** @type {string} */ text) => ({ text }),
    extraLensesNotRun: (/** @type {string} */ why, /** @type {unknown} */ x) => [`extra:${why}:${x}`],
    depthRecordFields: () => ({ depth: 'full' }),
    sb: { log: (/** @type {string} */ l) => logs.push(l), budget: { spent: () => 42 } },
    memory: initialMemory(0),
  })
  const res = await coveragePhase(reviewRun, { detected: o.detected ?? /** @type {any} */ ({}), baseRef: o.baseRef ?? '', changedFiles, branch: o.branch ?? '', head: o.head ?? '' })
  return { res: /** @type {any} */ (res), records, calls, logs, reviewRun, record: records[0] }
}
const COMMON = { schemaVersion: 1, runtime: 'claude-code', craftVersion: '9.9', kind: 'workflow', name: 'review', languages: [], dimensions: [], verification: null, depth: 'full', outputTokens: 42 }
/** @param {any} record */
const common = record => Object.fromEntries(Object.keys(COMMON).map(k => [k, record[k]]))

test('an unknown language pin stops the run before anything is reviewed', async () => {
  const { res, record, calls } = await phase(['a.rs'], { requestedLangs: ['cobol'], viaArg: 'rust-audit' })
  const msg = 'unknown language pin `cobol` — available: `rust`, `nix`'
  assert.deepEqual(common(record), COMMON)
  assert.deepEqual([record.verdict, record.nested, record.via, record.notRun], ['INCOMPLETE (unknown language pin)', true, 'rust-audit', [`nothing ran — ${msg}`, 'scope', 'extra:the language pin is unknown:undefined']])
  assert.equal(record.findings.total, 0)
  assert.equal(res.exit.text, `## Verdict\n⛔ INCOMPLETE — ${msg}. NOTHING WAS REVIEWED; fix the \`languages\` argument and re-run.\nSCOPE`)
  assert.equal(calls.length, 0)
})

test('an empty diff is INCOMPLETE and says what it was taken against', async () => {
  const { res, record, reviewRun } = await phase([], { baseRef: 'main' })
  assert.deepEqual(common(record), COMMON)
  assert.deepEqual([record.verdict, record.base, record.nested, record.via, record.uncoveredFiles], ['INCOMPLETE (empty diff)', 'main', false, null, []])
  assert.deepEqual(record.notRun, [noChangedFilesMessage(), 'scope', 'extra:the diff is empty:false'])
  assert.equal(record.memory.why, 'not recalled — nothing to review')
  assert.equal(reviewRun.memory.why, 'not recalled — nothing to review')
  assert.equal(res.exit.text, `## Verdict\n⚠️ INCOMPLETE — ${noChangedFilesMessage()}\n\n## Detected\n0 changed file(s) against main\nSCOPE`)
  const noted = await phase([], { detected: { notes: 'n' } })
  assert.ok(noted.res.exit.text.includes('## Detected\nn\n'))
  assert.equal(noted.record.base, '')
  assert.ok((await phase([])).res.exit.text.includes('0 changed file(s) against HEAD'))
})

test('an empty diff on the trunk itself names the head as the base', async () => {
  const { res, record } = await phase([], { baseRef: 'abc1234', head: 'abc1234def', branch: 'main' })
  assert.equal(record.notRun[0], onTrunkMessage())
  assert.equal(res.exit.text, `## Verdict\n⚠️ INCOMPLETE — ${onTrunkMessage()}\n\n## Detected\nHEAD abc1234def on \`main\` is the base itself (abc1234): 0 changed file(s)\nSCOPE`)
  const detached = await phase([], { detected: { baseIsHead: true }, head: 'f00' })
  assert.ok(detached.res.exit.text.includes('HEAD f00 is the base itself (): 0 changed file(s)'))
  const explicit = await phase([], { baseArg: 'abc1234', baseRef: 'abc1234', head: 'abc1234' })
  assert.equal(explicit.record.notRun[0], noChangedFilesMessage(), 'an explicit base equal to HEAD is the caller\'s choice')
})

test('a diff of inert files only is an honest Approve that lists what it did not review', async () => {
  const { res, record } = await phase(['README.md', 'Cargo.lock'])
  assert.deepEqual([record.verdict, record.uncoveredFiles, record.notRun], ['Approve (nothing to review)', ['README.md', 'Cargo.lock'], ['scope', 'extra:nothing reviewable changed:false']])
  assert.equal(res.exit.text, `## Verdict\n✅ Approve (NOTHING TO REVIEW) — ${nothingToReviewMessage(2)}\n\n## Detected\n2 changed file(s)\n\n## Not reviewed (nothing reviewable in them)\n- README.md\n- Cargo.lock\nSCOPE`)
})

test('material no profile covers is INCOMPLETE, never an Approve', async () => {
  const { res, record, reviewRun } = await phase(['a.py', 'README.md'], { detected: { notes: 'two files' } })
  const msg = noLanguageMessage(PROFILES, 2, 1)
  assert.deepEqual([record.verdict, record.uncoveredFiles, record.notRun], ['INCOMPLETE (no language profile)', ['a.py', 'README.md'], [msg, 'scope', 'extra:no language profile covers the diff:undefined']])
  assert.equal(res.exit.text, `## Verdict\n⚠️ INCOMPLETE — ${msg}\n\n## Detected\ntwo files\n\n## Not reviewed (no language profile)\n- a.py\n- README.md\nSCOPE`)
  assert.equal(reviewRun.memory.why, 'not recalled — no language profile for the changed files')
})

test('a reviewable diff recalls memory once, logs the profiles and accounts for what they leave out', async () => {
  const answer = { backend: 'files', why: 'the repo has a store', decisions: [] }
  const { res, calls, logs, reviewRun } = await phase(['a.rs', 'README.md', 'b.py'], { answer, baseRef: 'main' })
  assert.equal(res.exit, null)
  assert.deepEqual([res.active.map((/** @type {any} */ p) => p.id), res.uncoveredFiles, res.uncoveredGap], [['rust'], ['README.md', 'b.py'], ['b.py']])
  assert.deepEqual(reviewRun.active, res.active)
  assert.equal(calls.length, 1)
  assert.deepEqual({ label: calls[0].label, phase: calls[0].phase, schema: calls[0].schema, effort: calls[0].effort }, { label: 'memory-recall', phase: 'Scout', schema: MEMORY_RECALL_SCHEMA, effort: 'low' })
  assert.ok(calls[0].prompt.includes('a.rs'))
  assert.deepEqual(reviewRun.priorDecisionsIn.decisions, [])
  assert.equal(reviewRun.memory.source, 'none')
  assert.match(reviewRun.memory.why, /the repo has a store \(backend files\)/)
  assert.deepEqual(logs, ['Active profiles: rust · base main', 'Outside all active profiles (not reviewed): README.md, b.py — 1 unreviewed source file(s)'])
})

test('a pinned profile is named, and inert leftovers are said not to be a gap', async () => {
  const { res, logs, calls } = await phase(['a.nix', 'README.md'], { requestedLangs: 'nix', recalledByLauncher: true })
  assert.equal(calls.length, 0, 'the launcher already recalled')
  assert.deepEqual(res.uncoveredGap, [])
  assert.deepEqual(logs, ['Active profiles: nix (pinned: nix) · base HEAD', 'Outside all active profiles (not reviewed): README.md (docs/assets/lockfiles/project config only — not a coverage gap)'])
  const covered = await phase(['a.rs'], { answer: { decisions: [] } })
  assert.deepEqual(covered.logs, ['Active profiles: rust · base HEAD'])
})

test('a recalled record the reader refuses is logged by name', async () => {
  const { logs, reviewRun } = await phase(['a.rs'], { answer: { backend: 'b', why: 'y', decisions: [{ id: 'D-1' }] } })
  assert.ok(logs.some(l => l.startsWith('⚠️ priorDecisions: ')), logs.join('\n'))
  assert.equal(reviewRun.priorDecisionsIn.decisions.length, 0)
})
