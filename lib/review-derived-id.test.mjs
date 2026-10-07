// A record without an id: the engine derives it by the memory skill's rule when the record carries
// kind, title and scope, and still refuses one that lacks them (realm @nick/craft, node #222). The
// consumer case (realm @nick/craft, node #217): a launcher hand-built ten priorDecisions without an id and
// the engine refused every one. Expected ids are computed here with node:crypto, not the engine's sha256.
import crypto from 'node:crypto'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { memoryLine, withDerived } from './memory-recall.mjs'

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }

/** The skill's own rule, by node:crypto. @param {string} kind @param {string} title @param {string} scope */
const skillId = (kind, title, scope) => `${kind}-${crypto.createHash('sha256').update(`${kind}\n${title.trim().replace(/\s+/g, ' ').toLowerCase()}\n${scope.replace(/^\.\//, '').replace(/\/+$/, '')}`).digest('hex').slice(0, 10)}`

/** @param {string} title @param {string} file */
const finding = (title, file) => ({
  severity: 'Medium', title, file, line: 12, why: 'w', fix: 'f', blastRadius: '', source: 'safety', ruleId: 'ERR-001', symbol: 's', whereChecked: '',
})
const FILES = Array.from({ length: 10 }, (_, i) => `src/m${i}.rs`)
/** @param {number} i */
const titleOf = i => `unwrap number ${i} may panic`
// Ten records as the launcher built them: the skill's shape, no id.
const NO_ID = FILES.map((f, i) => ({ kind: 'decision', title: titleOf(i), body: `validated upstream ${i}`, scope: f, status: 'active', date: '2026-10-01', author: 'alice', commit: 'abc1234', links: [`https://x/pr/731#c${i}`] }))
const FINDINGS = FILES.map((f, i) => finding(titleOf(i), f))

/** @param {unknown} recall @param {any[]} findings @param {string[]} files */
const reviewScript = (recall, findings = FINDINGS, files = FILES) => ({
  detect: { baseRef: 'main', files, spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? findings : [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  'decision-scope': (/** @type {{ prompt: string }} */ { prompt }) => ({ unchanged: [...prompt.matchAll(/echo '([^']+)' \$\?/g)].map(m => m[1]), reason: '' }),
  'memory-recall': recall,
  synthesis: null,
  '*': null,
})
const EMPTY_RECALL = { backend: 'repo', why: 'nothing recorded', decisions: [] }

/** @param {string} report */
const setAsideIds = report => [...report.matchAll(/REJECTED BEFORE: [^\n]*\(decision (decision-[0-9a-f]{10})\)/g)].map(m => String(m[1])).sort()

test('derived id: ten passed records without an id are applied, each finding set aside, the derivation named once', async () => {
  const run = await runEngine('review', { args: { priorDecisions: NO_ID }, script: reviewScript(EMPTY_RECALL) })
  assert.doesNotMatch(run.report, /lacks an id/)
  assert.doesNotMatch(run.report, /## Prior decisions not applied/)
  assert.deepEqual(setAsideIds(run.report), FILES.map((f, i) => skillId('decision', titleOf(i), f)).sort())
  assert.equal(run.report.match(/id derived for 10 record\(s\)/g)?.length, 1, 'named once')
  const named = [0, 1, 2].map(i => `${skillId('decision', titleOf(i), FILES[i] ?? '')} \\(${titleOf(i)}\\)`).join(', ')
  assert.match(run.report, new RegExp(`id derived for 10 record\\(s\\): ${named} and 7 more\\n`), 'the first few named, the rest counted')
  assert.match(run.report, /✅ Approve/)
})

test('derived id: equals the skill\'s rule — title trimmed, collapsed, lower-cased; scope without ./ and trailing /', async () => {
  const rec = { kind: 'decision', title: '  Unwrap   in PARSER may panic ', body: 'validated upstream', scope: './src/parse.rs', author: 'alice', date: '2026-10-01', commit: 'abc1234', links: ['https://x/pr/1#c1'] }
  const run = await runEngine('review', { args: { priorDecisions: [rec] }, script: reviewScript(EMPTY_RECALL, [finding('unwrap in parser may panic', 'src/parse.rs')], ['src/parse.rs']) })
  assert.deepEqual(setAsideIds(run.report), [skillId('decision', 'unwrap in parser may panic', 'src/parse.rs')])
})

test('derived id: a record without an id and without a title, or without a kind, is still refused by name', async () => {
  const noTitle = Object.fromEntries(Object.entries(NO_ID[0] ?? {}).filter(([k]) => k !== 'title'))
  const noKind = Object.fromEntries(Object.entries(NO_ID[2] ?? {}).filter(([k]) => k !== 'kind'))
  const run = await runEngine('review', { args: { priorDecisions: [noTitle, NO_ID[1], noKind] }, script: reviewScript(EMPTY_RECALL) })
  assert.match(run.report, /## Prior decisions not applied\n- ⚠️ passed decision #0 lacks an id, a title or a reason\n- ⚠️ passed decision #2 lacks an id, and the kind its id is derived from\n/)
  assert.deepEqual(setAsideIds(run.report), [skillId('decision', titleOf(1), FILES[1] ?? '')])
  assert.match(run.report, /id derived for 1 record\(s\)/)
})

test('derived id: a recalled and a passed record without an id but with one kind, title and scope merge into one (the recalled kept)', async () => {
  const recalled = { ...NO_ID[0], body: 'the store says so' }
  const passed = { ...NO_ID[0], body: 'an old reason from a thread' }
  const run = await runEngine('review', { args: { priorDecisions: [passed] }, script: reviewScript({ backend: 'repo', why: 'w', decisions: [recalled] }) })
  assert.match(run.report, /REJECTED BEFORE: the store says so/)
  assert.doesNotMatch(run.report, /an old reason from a thread|repeats an id/)
  assert.match(run.report, /plus 1 passed by the launcher \(0 new\)/)
})

test('withDerived/memoryLine: the derived count closes every form of the line, and nothing is said when none was derived', () => {
  const long = 'a title long enough to be cut at the bound of the line'
  const two = [{ id: 'decision-a', title: 't1', derived: true }, { id: 'x', title: 'x' }, { id: 'decision-b', title: long, derived: true }]
  const tail = `id derived for 2 record(s): decision-a (t1), decision-b (${long.slice(0, 40)}…)`
  assert.equal(memoryLine(withDerived({ source: 'recalled', count: 3, why: 'repo (w)' }, two)), `memory: recalled 3 decision(s) from repo (w); ${tail}`)
  assert.equal(memoryLine(withDerived({ source: 'none', count: 0, why: 'w', passed: 2 }, two)), `memory: none — w; plus 2 passed by the launcher; ${tail}`)
  assert.equal(memoryLine(withDerived({ source: 'launcher', count: 3, why: '' }, two)), `memory: recalled by the launching audit — applied 3 decision(s); ${tail}`)
  assert.deepEqual(withDerived({ source: 'none', count: 0, why: 'w' }, [{ id: 'x', title: 'x' }]), { source: 'none', count: 0, why: 'w' })
})
