// The engines' service steps run as craft's own engine-service agent, which starts without the project's
// instructions; a step that needs another tool, the consumer's instructions or judgement keeps its own type
// (lib/service-agent.mjs, realm @nick/craft, node #397). Driven through the whole review and adversarial-review engines.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { SERVICE_AGENT_TYPE, fitsSchema, makeDefaultTypeFallback } from './service-agent.mjs'
import { askSourceAgent } from './external-source-agent.mjs'

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

/** The review engine's answers by label, the lenses' findings once each. @returns {Record<string, unknown>} */
function reviewScript() {
  const seen = new Set()
  return {
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
  }
}
const REVIEW_ARGS = { comment: true, unitScope: true, unitBatches: false }

// The steps on the service agent, and the ones that keep their type: memory-recall and index-warmup need MCP
// tools, probe checks the reviewer type itself, gate and preflight lean on a skill or on judgement, and the
// lenses, verifiers, critics, adjudicators and synthesis judge.
const SERVICE_STEPS = [/^detect$/, /^prior-round$/, /^scout:rust$/, /^units:rust$/, /^dedup:rust$/, /^diff-lines$/, /^checkpoint:/, /^log-run/]
const OWN_TYPE_STEPS = /^(gate:|preflight:|probe:|memory-recall|index-warmup|coord|seam|lens:|verify|critic|adjudicate|pr-comments|synthesis)/

test('review: the service steps, the checkpoints and the run record included, run as the service agent with their own model; the others do not', async () => {
  const run = await runEngine('review', { args: REVIEW_ARGS, script: reviewScript() })
  const types = typeByLabel(run.calls)
  for (const re of SERVICE_STEPS) {
    const hits = matching(types, re)
    assert.ok(hits.length, `${re} dispatched: ${[...types.keys()].join(', ')}`)
    for (const [label, type] of hits) assert.equal(type, SERVICE_AGENT_TYPE, `${label} runs as the service agent`)
  }
  assert.equal(run.calls.find(c => c.label === 'scout:rust')?.opts?.model, 'haiku', 'the agent keeps its model')
  assert.ok(run.calls.some(c => /^checkpoint:/.test(String(c.label)) && c.opts?.model === 'haiku'), 'a checkpoint keeps its model')
  const others = matching(types, OWN_TYPE_STEPS)
  for (const premise of ['gate:', 'preflight:', 'lens:', 'verify']) assert.ok(others.some(([l]) => l.startsWith(premise)), `premise: ${premise} dispatched`)
  for (const [label, type] of others) assert.notEqual(type, SERVICE_AGENT_TYPE, `${label} keeps its own type`)
})

test('adversarial-review: the scout, the semantic dedup, the checkpoint and the run record run as the service agent; the index warm-up and the judges do not', async () => {
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
  for (const label of ['scout', 'dedup-semantic']) assert.equal(types.get(label), SERVICE_AGENT_TYPE, `${label} runs as the service agent: ${[...types.keys()].join(', ')}`)
  for (const re of [/^checkpoint:/, /^log-run/]) {
    const hits = matching(types, re)
    assert.ok(hits.length, `${re} dispatched`)
    for (const [label, type] of hits) assert.equal(type, SERVICE_AGENT_TYPE, `${label} runs as the service agent`)
  }
  const checkpoint = run.calls.find(c => /^checkpoint:/.test(String(c.label)))
  assert.doesNotMatch(String(checkpoint?.prompt), /^REPO/, 'the checkpoint carries its own cd, no repo directive')
  for (const [label, type] of matching(types, /^(index-warmup|memory-recall|review:|verify|coverage-critic)/)) {
    assert.notEqual(type, SERVICE_AGENT_TYPE, `${label} keeps its own type`)
  }
  assert.ok(types.has('index-warmup'), 'premise: the warm-up dispatched')
})

test('the external-sources prep runs as the service agent', async () => {
  /** @type {Record<string, unknown>[]} */
  const seen = []
  await askSourceAgent({ ragent: async (_p, o) => { seen.push(/** @type {Record<string, unknown>} */ (o)); return null }, plugin: { craftRoot: '/c', version: '1', repo: '' }, prepPhase: 'Scout' }, [], ['chart/values.yaml'])
  assert.equal(seen[0]?.['label'], 'external-sources')
  assert.equal(seen[0]?.['agentType'], SERVICE_AGENT_TYPE)
})

test('review: when the service agent answers nothing, each service step reruns once on the default type, the run completes and the record counts the fallbacks', async () => {
  const script = reviewScript()
  /** The service agent never answers; the default type gets the scripted answer. */
  const run = await runEngine('review', { args: REVIEW_ARGS, script: Object.fromEntries(Object.entries(script).map(([label, answer]) => [label,
    (/** @type {{ opts: { agentType?: string } }} */ call) => (call.opts.agentType === SERVICE_AGENT_TYPE ? null : typeof answer === 'function' ? answer(call) : answer)])) })
  for (const label of ['detect', 'prior-round', 'scout:rust', 'units:rust', 'diff-lines', 'checkpoint:rust-plan']) {
    const types = run.calls.filter(c => String(c.label).replace(/^retry:/, '') === label).map(c => c.opts?.agentType)
    assert.ok(types.includes(SERVICE_AGENT_TYPE), `${label} first ran as the service agent: ${types.join(', ')}`)
    assert.equal(types.at(-1), undefined, `${label} last ran on the default type`)
  }
  assert.doesNotMatch(run.report, /INCOMPLETE/, 'the review completes')
  assert.ok(run.logs.some(l => /as craft:engine-service returned no result — re-running it once on the default agent type/.test(l)), 'the fallback is logged')
  const record = filedRecord(run)
  assert.ok(record?.agentFallbacks?.[SERVICE_AGENT_TYPE] >= 5, `the record counts the fallbacks: ${JSON.stringify(record?.agentFallbacks)}`)
})

test('adversarial-review: a scout the service agent did not answer reruns on the default type and the record counts it', async () => {
  const run = await runEngine('adversarial-review', { args: { diffBase: 'main' }, script: {
    scout: (/** @type {{ opts: { agentType?: string } }} */ { opts }) => (opts.agentType === SERVICE_AGENT_TYPE ? null
      : { head: 'abc1234', baseRef: 'main', sizeBucket: 'small', lenses: ['correctness', 'errors'], changedFiles: ['web/a.js'], notes: '' }),
    'index-warmup': { indexed: false, notes: 'x' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    review: { findings: [] },
    'coverage-critic': { findings: [] },
    'log-run': { ok: true, output: [] },
    '*': null,
  } })
  const scouts = run.calls.filter(c => c.label === 'scout').map(c => c.opts?.agentType)
  assert.deepEqual(scouts, [SERVICE_AGENT_TYPE, undefined], 'the service agent once, then the default type once')
  assert.notEqual(run.reportValue.verdict, 'INCOMPLETE', `the review is not cut short: ${run.reportValue.verdict}`)
  assert.deepEqual(filedRecord(run)?.agentFallbacks, { [SERVICE_AGENT_TYPE]: 1 })
})

test('fitsSchema: null never fits; an object schema needs an object with every required key', () => {
  const schema = { type: 'object', required: ['a', 'b'] }
  assert.equal(fitsSchema(null, schema), false)
  assert.equal(fitsSchema(undefined, undefined), false)
  assert.equal(fitsSchema('text', undefined), true)
  assert.equal(fitsSchema({ a: 1 }, schema), false)
  assert.equal(fitsSchema([], schema), false)
  assert.equal(fitsSchema({ a: 1, b: 0 }, schema), true)
})

test('makeDefaultTypeFallback: only a service-agent call is rerun, once, without its agent type; a stopped run is not', async () => {
  /** @type {{ agentType?: string | undefined, label?: string, schema?: object }[]} */
  const seen = []
  const logs = /** @type {string[]} */ ([])
  let stop = false
  const ro = makeDefaultTypeFallback(async (/** @type {string} */ _p, /** @type {{ agentType?: string | undefined, label?: string, schema?: object }} */ o) => { seen.push(o); return o.agentType ? { off: 1 } : { a: 1 } }, l => logs.push(l), () => stop)
  const schema = { type: 'object', required: ['a'] }
  assert.deepEqual(await ro.run('p', { agentType: SERVICE_AGENT_TYPE, label: 'x', schema }), { a: 1 })
  assert.deepEqual(seen.map(o => o.agentType), [SERVICE_AGENT_TYPE, undefined])
  assert.equal(seen[1]?.schema, schema, 'the same schema')
  assert.match(String(logs[0]), /'x' as craft:engine-service answered off its schema/)
  assert.deepEqual(await ro.run('p', { agentType: 'craft:rust-reviewer', schema }), { off: 1 }, 'another type is left alone')
  stop = true
  assert.deepEqual(await ro.run('p', { agentType: SERVICE_AGENT_TYPE, schema }), { off: 1 }, 'a stopped run is not rerun')
  assert.deepEqual(ro.fallbacks(), [{ agent: SERVICE_AGENT_TYPE, count: 1 }])
})
