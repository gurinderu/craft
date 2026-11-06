// The read-only service agents run as Claude Code's Explore type, which is handed no project instructions;
// every agent that writes, builds or judges keeps its own type (lib/read-only-agent.mjs, realm @nick/craft,
// node #442). Driven through the whole review and adversarial-review engines.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { READ_ONLY_AGENT_TYPE } from './read-only-agent.mjs'

/** @typedef {import('./engine-harness.mjs').Call} Call */
const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const FILE = 'crates/a/src/db.rs'
/** @param {Record<string, unknown>} [over] */
const finding = (over = {}) => ({
  severity: 'Medium', title: 'unwrap on the row may panic', file: FILE, line: 12, why: 'an empty row panics', fix: 'return an error',
  blastRadius: '', source: 'errors', ruleId: '', symbol: 'load', whereChecked: '', ...over,
})
const FINDINGS = [finding(), finding({ title: 'lock held across await', line: 99, symbol: 'flush' }), finding({ source: 'safety', title: 'unchecked index', line: 40, symbol: 'get' })]

/** The type each dispatched label ran as, the first call of each label. @param {Call[]} calls */
function typeByLabel(calls) {
  /** @type {Map<string, unknown>} */
  const out = new Map()
  for (const c of calls) {
    const label = String(c.label)
    if (!out.has(label)) out.set(label, c.opts?.agentType)
  }
  return out
}
/** @param {Map<string, unknown>} types @param {RegExp} re */
const matching = (types, re) => [...types].filter(([label]) => re.test(label))

test('review: detect, prior-round, scout, units, dedup and diff-lines run as Explore with their own model; the writers and judges do not', async () => {
  const seen = new Set()
  const run = await runEngine('review', { args: { comment: true, unitScope: true, unitBatches: false }, script: {
    detect: { baseRef: 'main', files: [FILE, 'crates/b/src/x.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    scout: { sizeBucket: 'small', lenses: ['safety', 'errors'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    units: { roots: ['crates/a', 'crates/b'] },
    coord: { answered: 1, unanswered: 0, notes: '' },
    'coord-stop': { written: true },
    seam: { findings: [], dispositions: [], answered: 0 },
    lens: (/** @type {{ opts: { label: string } }} */ { opts }) => {
      const lens = String(/^lens:[^:]+:([\w-]+)/.exec(opts.label)?.[1])
      const first = !seen.has(lens)
      seen.add(lens)
      return { lens, findings: first ? FINDINGS.filter(f => f.source === lens) : [] }
    },
    dedup: { groups: [] },
    verify: () => UPHELD,
    'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
    'diff-lines': { lines: [`HUNK\t+10,5\tb/${FILE}`, 'HUNKS-END'], reason: '' },
    'pr-comments': { posted: 1, reason: 'PR #9' },
    synthesis: null,
    '*': null,
  } })
  const types = typeByLabel(run.calls)
  for (const re of [/^detect$/, /^prior-round$/, /^scout:rust$/, /^units:rust$/, /^dedup:rust$/, /^diff-lines$/]) {
    const hits = matching(types, re)
    assert.ok(hits.length, `${re} dispatched: ${[...types.keys()].join(', ')}`)
    for (const [label, type] of hits) assert.equal(type, READ_ONLY_AGENT_TYPE, `${label} runs as Explore`)
  }
  const scout = run.calls.find(c => c.label === 'scout:rust')
  assert.equal(scout?.opts?.model, 'haiku', 'the agent keeps its model')
  const writers = matching(types, /^(checkpoint|log-run|gate:|preflight:|probe:|memory-recall|coord|lens:|verify|pr-comments|synthesis)/)
  assert.ok(writers.some(([l]) => l.startsWith('checkpoint')), 'premise: a checkpoint dispatched')
  assert.ok(writers.some(([l]) => l.startsWith('gate:')), 'premise: the gate dispatched')
  for (const [label, type] of writers) assert.notEqual(type, READ_ONLY_AGENT_TYPE, `${label} keeps its own type`)
})

test('adversarial-review: the scout and the semantic dedup run as Explore; the checkpoint and the index warm-up do not', async () => {
  // More findings than the engine's semantic-dedup threshold (15), so the clusterer dispatches.
  const find = (/** @type {number} */ i) => ({ title: `defect number ${i}`, file: `web/f${i}.js`, line: 10 * i + 1, severity: 'medium', description: `d${i}`, fix: 'f', whereChecked: '' })
  const run = await runEngine('adversarial-review', { args: { diffBase: 'main' }, script: {
    scout: { head: 'abc1234', baseRef: 'main', sizeBucket: 'small', lenses: ['correctness', 'errors'], changedFiles: Array.from({ length: 20 }, (_v, i) => `web/f${i}.js`), notes: '' },
    'index-warmup': { indexed: false, notes: 'x' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    review: { findings: Array.from({ length: 20 }, (_v, i) => find(i)) },
    'dedup-semantic': { clusters: [] },
    'coverage-critic': { findings: [] },
    'log-run': { ok: true, output: [] },
    '*': (/** @type {{ opts: { label?: string } }} */ { opts }) => (/^verify/.test(String(opts.label)) ? { refuted: false, premiseSupported: true, reasoning: 'ok', severity: 'medium' } : null),
  } })
  const types = typeByLabel(run.calls)
  for (const label of ['scout', 'dedup-semantic']) assert.equal(types.get(label), READ_ONLY_AGENT_TYPE, `${label} runs as Explore: ${[...types.keys()].join(', ')}`)
  for (const [label, type] of matching(types, /^(checkpoint|index-warmup|log-run|review:|verify|coverage-critic)/)) {
    assert.notEqual(type, READ_ONLY_AGENT_TYPE, `${label} keeps its own type`)
  }
  assert.ok(types.has('index-warmup') && [...types.keys()].some(l => l.startsWith('checkpoint')), 'premise: the writers dispatched')
})
