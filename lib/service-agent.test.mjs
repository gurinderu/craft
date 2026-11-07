// The engines' service steps run as craft's own engine-service agent, which starts without the project's
// instructions; a step that needs another tool, the consumer's instructions or judgement keeps its own type
// (lib/service-agent.mjs, realm @nick/craft, node #397). Driven through the whole review and adversarial-review engines.
// The run record counts a step the default type answered by reason: the type could not launch, or one step failed.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { SERVICE_AGENT_TYPE, makeDefaultTypeFallback } from './service-agent.mjs'
import { fitsSchema } from './agent-type-fallback.mjs'
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
    detect: { baseRef: 'main', files: [FILE, 'crates/b/src/x.rs'], spec: '', branch: 'feat/x', head: 'abc1234', baseIsHead: false, notes: '' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, journalSourced: false, reason: 'none' },
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
const LAUNCH = `${SERVICE_AGENT_TYPE} (launch failed)`
const STEP = `${SERVICE_AGENT_TYPE} (step rerun)`
const NOT_FOUND = `Agent type '${SERVICE_AGENT_TYPE}' not found.\nAvailable agents: general-purpose`
const NO_STRUCTURED = 'agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)'

// The steps on the service agent, and the ones that keep their type: memory-recall and index-warmup need MCP
// tools, probe checks the reviewer type itself, gate and preflight lean on a skill or on judgement, the scout
// finds intent and churn and picks lenses, dedup merges findings, and the lenses, verifiers, critics,
// adjudicators and synthesis judge.
const SERVICE_STEPS = [/^detect$/, /^prior-round$/, /^units:rust$/, /^diff-lines$/, /^checkpoint:/, /^log-run/]
const OWN_TYPE_STEPS = /^(gate:|preflight:|probe:|memory-recall|index-warmup|scout:|dedup:|coord|seam|lens:|verify|critic|adjudicate|pr-comments|synthesis)/

test('review: the service steps, the checkpoints and the run record included, run as the service agent with their own model; the others do not', async () => {
  const run = await runEngine('review', { args: REVIEW_ARGS, script: reviewScript() })
  const types = typeByLabel(run.calls)
  for (const re of SERVICE_STEPS) {
    const hits = matching(types, re)
    assert.ok(hits.length, `${re} dispatched: ${[...types.keys()].join(', ')}`)
    for (const [label, type] of hits) assert.equal(type, SERVICE_AGENT_TYPE, `${label} runs as the service agent`)
  }
  assert.equal(run.calls.find(c => c.label === 'units:rust')?.opts?.model, 'haiku', 'the agent keeps its model')
  assert.ok(run.calls.some(c => /^checkpoint:/.test(String(c.label)) && c.opts?.model === 'haiku'), 'a checkpoint keeps its model')
  const others = matching(types, OWN_TYPE_STEPS)
  for (const premise of ['gate:', 'preflight:', 'scout:', 'dedup:', 'lens:', 'verify']) assert.ok(others.some(([l]) => l.startsWith(premise)), `premise: ${premise} dispatched`)
  for (const [label, type] of others) assert.notEqual(type, SERVICE_AGENT_TYPE, `${label} keeps its own type`)
})

test('adversarial-review: the checkpoint and the run record run as the service agent; the scout, the semantic dedup, the index warm-up and the judges do not', async () => {
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
  for (const label of ['scout', 'dedup-semantic']) {
    assert.ok(types.has(label), `premise: ${label} dispatched: ${[...types.keys()].join(', ')}`)
    assert.notEqual(types.get(label), SERVICE_AGENT_TYPE, `${label} keeps its own type`)
  }
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

test('review: when the service agent answers nothing, the first step reruns on the default type, the second retires the type, the run completes and the record counts both', async () => {
  const script = reviewScript()
  /** The service agent never answers; the default type gets the scripted answer. */
  const run = await runEngine('review', { args: REVIEW_ARGS, script: Object.fromEntries(Object.entries(script).map(([label, answer]) => [label,
    (/** @type {{ opts: { agentType?: string } }} */ call) => (call.opts.agentType === SERVICE_AGENT_TYPE ? null : typeof answer === 'function' ? answer(call) : answer)])) })
  /** @param {string} label */
  const typesOf = label => run.calls.filter(c => String(c.label).replace(/^retry:/, '') === label).map(c => c.opts?.agentType)
  for (const label of ['detect', 'prior-round']) {
    const types = typesOf(label)
    assert.equal(types[0], SERVICE_AGENT_TYPE, `${label} first ran as the service agent: ${types.join(', ')}`)
    assert.equal(types.at(-1), undefined, `${label} last ran on the default type`)
  }
  for (const label of ['units:rust', 'diff-lines', 'checkpoint:rust-plan']) {
    const types = typesOf(label)
    assert.ok(types.length && !types.includes(SERVICE_AGENT_TYPE), `${label} went straight to the default type: ${types.join(', ')}`)
  }
  assert.doesNotMatch(run.report, /INCOMPLETE/, 'the review completes')
  assert.ok(run.logs.some(l => /'detect' as craft:engine-service returned no result — re-running it once on the default agent type/.test(l)), 'the first fallback is logged')
  assert.ok(run.logs.some(l => /'prior-round' as craft:engine-service returned no result — craft:engine-service could not launch/.test(l)), 'the retirement is logged')
  const record = filedRecord(run)
  assert.equal(record?.agentFallbacks?.[STEP], 1, `one step rerun: ${JSON.stringify(record?.agentFallbacks)}`)
  assert.ok(record?.agentFallbacks?.[LAUNCH] >= 4, `the rest counted as a launch failure: ${JSON.stringify(record?.agentFallbacks)}`)
})

test('adversarial-review: a checkpoint the service agent did not answer reruns on the default type and the record counts it', async () => {
  const run = await runEngine('adversarial-review', { args: { diffBase: 'main' }, script: {
    scout: { head: 'abc1234', baseRef: 'main', sizeBucket: 'small', lenses: ['correctness', 'errors'], changedFiles: ['web/a.js'], notes: '' },
    'index-warmup': { indexed: false, notes: 'x' },
    checkpoint: (/** @type {{ opts: { agentType?: string } }} */ { opts }) => (opts.agentType === SERVICE_AGENT_TYPE ? null : { runDir: '/store/.partial/run-A', error: '' }),
    review: { findings: [] },
    'coverage-critic': { findings: [] },
    'log-run': { ok: true, output: [] },
    '*': null,
  } })
  const checkpoints = run.calls.filter(c => /^checkpoint:/.test(String(c.label))).map(c => c.opts?.agentType)
  assert.deepEqual(checkpoints, [SERVICE_AGENT_TYPE, undefined], 'the service agent once, then the default type once')
  assert.notEqual(run.reportValue.verdict, 'INCOMPLETE', `the review is not cut short: ${run.reportValue.verdict}`)
  assert.deepEqual(filedRecord(run)?.agentFallbacks, { [STEP]: 1 })
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
  assert.deepEqual(ro.fallbacks(), [{ agent: STEP, count: 1 }])
})

test('makeDefaultTypeFallback: a throw that reads as an unregistered type retires the service agent at once; no later step tries it again', async () => {
  /** @type {(string | undefined)[]} */
  const seen = []
  const logs = /** @type {string[]} */ ([])
  const ro = makeDefaultTypeFallback(async (/** @type {string} */ _p, /** @type {{ agentType?: string | undefined, label?: string }} */ o) => {
    seen.push(o.agentType)
    if (o.agentType === SERVICE_AGENT_TYPE) throw new Error(NOT_FOUND)
    return 'ok'
  }, l => logs.push(l))
  assert.equal(await ro.run('p', { agentType: SERVICE_AGENT_TYPE, label: 'detect' }), 'ok')
  assert.equal(await ro.run('p', { agentType: SERVICE_AGENT_TYPE, label: 'scout' }), 'ok')
  assert.deepEqual(seen, [SERVICE_AGENT_TYPE, undefined, undefined], 'the service type is tried once, then never again')
  assert.equal(logs.length, 1, `logged once: ${logs.join(' | ')}`)
  assert.match(String(logs[0]), /'detect' as craft:engine-service threw \(Error: Agent type .* not found\. Available agents.*could not launch/)
  assert.deepEqual(ro.fallbacks(), [{ agent: LAUNCH, count: 2 }], 'both steps counted as a launch failure')
  assert.equal(ro.route({ agentType: SERVICE_AGENT_TYPE, label: 'log-run' }).agentType, undefined, 'a dispatch outside run is routed too')
  assert.equal(ro.route({ agentType: 'craft:rust-reviewer' }).agentType, 'craft:rust-reviewer', 'another type is left alone')
})

test('makeDefaultTypeFallback: before any throw route keeps the service type; a throw on a stopped run is raised, not rerun', async () => {
  let calls = 0
  const ro = makeDefaultTypeFallback(async () => { calls++; throw new Error('usage limit') }, () => {}, () => true)
  assert.equal(ro.route({ agentType: SERVICE_AGENT_TYPE }).agentType, SERVICE_AGENT_TYPE)
  await assert.rejects(ro.run('p', { agentType: SERVICE_AGENT_TYPE }), /usage limit/)
  assert.equal(calls, 1)
  assert.deepEqual(ro.fallbacks(), [])
})

test('makeDefaultTypeFallback: a deadline fire is never rerun and comes back as null, on the service type or any other', async () => {
  const FIRED = { fired: true }
  /** @type {(string | undefined)[]} */
  const seen = []
  const ro = makeDefaultTypeFallback(async (/** @type {string} */ _p, /** @type {{ agentType?: string | undefined }} */ o) => { seen.push(o.agentType); return FIRED }, () => {}, () => false, got => got === FIRED)
  assert.equal(await ro.run('p', { agentType: SERVICE_AGENT_TYPE }), null)
  assert.deepEqual(seen, [SERVICE_AGENT_TYPE], 'no rerun after a deadline fire')
  assert.equal(await ro.run('p', { agentType: 'craft:rust-reviewer' }), null, 'the marker never leaks')
  assert.deepEqual(ro.fallbacks(), [])
})

test('review: a service agent whose launch throws is tried once; every service step runs on the default type and the review completes', async () => {
  const script = reviewScript()
  const run = await runEngine('review', { args: REVIEW_ARGS, script: Object.fromEntries(Object.entries(script).map(([label, answer]) => [label,
    (/** @type {{ opts: { agentType?: string } }} */ call) => {
      if (call.opts.agentType === SERVICE_AGENT_TYPE) throw new Error(NOT_FOUND)
      return typeof answer === 'function' ? answer(call) : answer
    }])) })
  const tried = run.calls.filter(c => c.opts?.agentType === SERVICE_AGENT_TYPE)
  assert.equal(tried.length, 1, `the service type is tried once: ${tried.map(c => c.label).join(', ')}`)
  for (const label of ['detect', 'prior-round', 'units:rust', 'diff-lines']) {
    assert.ok(run.calls.some(c => c.label === label && c.opts?.agentType === undefined), `${label} ran on the default type`)
  }
  assert.doesNotMatch(run.report, /INCOMPLETE/, 'the review completes')
  assert.equal(run.logs.filter(l => /as craft:engine-service threw/.test(l)).length, 1, 'logged once')
  const record = filedRecord(run)
  assert.ok(record, 'the run record is filed')
  assert.ok(record?.agentFallbacks?.[LAUNCH] >= 4, `the record counts the fallbacks as a launch failure: ${JSON.stringify(record?.agentFallbacks)}`)
  assert.equal(record?.agentFallbacks?.[STEP], undefined, 'none as a step rerun')
})

test('review: a service step whose deadline fires is not rerun on the default type', async () => {
  const run = await runEngine('review', { args: { ...REVIEW_ARGS, deadlineMs: 5 }, script: { ...reviewScript(), 'prior-round': () => new Promise(() => {}) } })
  const prior = run.calls.filter(c => String(c.label).replace(/^retry:/, '') === 'prior-round').map(c => c.opts?.agentType)
  assert.deepEqual(prior, [SERVICE_AGENT_TYPE], `one dispatch, no rerun: ${prior.join(', ')}`)
})

/**
 * A fallback whose service agent answers from `script` in turn: 'throw:<msg>' throws, anything else is the answer;
 * the default type always answers { a: 1 }; `fired` is the dispatch's deadline marker.
 * @param {unknown[]} script
 * @param {unknown} [fired]
 */
function scripted(script, fired) {
  /** @type {(string | undefined)[]} */
  const seen = []
  const logs = /** @type {string[]} */ ([])
  let i = 0
  const ro = makeDefaultTypeFallback(async (/** @type {string} */ _p, /** @type {{ agentType?: string | undefined, label?: string, schema?: object }} */ o) => {
    seen.push(o.agentType)
    if (!o.agentType) return { a: 1 }
    const next = script[i++]
    if (typeof next === 'string' && next.startsWith('throw:')) throw new Error(next.slice(6))
    return next
  }, l => logs.push(l), () => false, got => fired !== undefined && got === fired)
  const step = (/** @type {string} */ label) => ro.run('p', { agentType: SERVICE_AGENT_TYPE, label, schema: { type: 'object', required: ['a'] } })
  return { ro, seen, logs, step }
}

test('makeDefaultTypeFallback: a single throw that is not a missing type (no structured answer) reruns that step only; later steps still use the service agent', async () => {
  const { ro, seen, logs, step } = scripted([`throw:${NO_STRUCTURED}`, { a: 2 }, { a: 3 }])
  assert.deepEqual(await step('detect'), { a: 1 }, 'the step answered by the default type')
  assert.deepEqual(await step('units'), { a: 2 })
  assert.deepEqual(await step('diff-lines'), { a: 3 })
  assert.deepEqual(seen, [SERVICE_AGENT_TYPE, undefined, SERVICE_AGENT_TYPE, SERVICE_AGENT_TYPE])
  assert.equal(logs.length, 1)
  assert.match(String(logs[0]), /'detect' as craft:engine-service threw .*StructuredOutput.* re-running this step once on the default agent type; later service steps still try/)
  assert.doesNotMatch(String(logs[0]), /could not launch/)
  assert.deepEqual(ro.fallbacks(), [{ agent: STEP, count: 1 }])
  assert.equal(ro.route({ agentType: SERVICE_AGENT_TYPE }).agentType, SERVICE_AGENT_TYPE, 'route keeps the service type')
})

test('makeDefaultTypeFallback: two service-agent throws in a row with no answer between retire the type', async () => {
  const { ro, seen, logs, step } = scripted([`throw:${NO_STRUCTURED}`, 'throw:boom', { a: 9 }])
  await step('detect')
  await step('units')
  assert.deepEqual(await step('diff-lines'), { a: 1 }, 'the third step goes straight to the default type')
  assert.deepEqual(seen, [SERVICE_AGENT_TYPE, undefined, SERVICE_AGENT_TYPE, undefined, undefined])
  assert.match(String(logs[1]), /'units' as craft:engine-service threw \(Error: boom\).*could not launch/)
  assert.deepEqual(ro.fallbacks(), [{ agent: LAUNCH, count: 2 }, { agent: STEP, count: 1 }])
  assert.equal(ro.route({ agentType: SERVICE_AGENT_TYPE }).agentType, undefined)
})

test('makeDefaultTypeFallback: a fitting service-agent answer between two throws resets the count', async () => {
  const { ro, seen, step } = scripted([`throw:${NO_STRUCTURED}`, { a: 2 }, 'throw:boom', { a: 4 }])
  await step('detect')
  await step('units')
  await step('diff-lines')
  assert.deepEqual(await step('checkpoint'), { a: 4 }, 'the service agent still answers')
  assert.deepEqual(seen, [SERVICE_AGENT_TYPE, undefined, SERVICE_AGENT_TYPE, SERVICE_AGENT_TYPE, undefined, SERVICE_AGENT_TYPE])
  assert.deepEqual(ro.fallbacks(), [{ agent: STEP, count: 2 }])
})

test('makeDefaultTypeFallback: two service-agent nulls in a row retire the type, as an unregistered agent that comes back empty', async () => {
  const { ro, seen, logs, step } = scripted([null, null, { a: 9 }])
  await step('detect')
  await step('units')
  assert.deepEqual(await step('diff-lines'), { a: 1 }, 'the third step goes straight to the default type')
  assert.deepEqual(seen, [SERVICE_AGENT_TYPE, undefined, SERVICE_AGENT_TYPE, undefined, undefined])
  assert.match(String(logs[1]), /'units' as craft:engine-service returned no result — craft:engine-service could not launch/)
  assert.deepEqual(ro.fallbacks(), [{ agent: LAUNCH, count: 2 }, { agent: STEP, count: 1 }])
  assert.equal(ro.route({ agentType: SERVICE_AGENT_TYPE }).agentType, undefined)
})

test('makeDefaultTypeFallback: a null, a fitting answer, then a null does not retire the type', async () => {
  const { ro, seen, step } = scripted([null, { a: 2 }, null, { a: 4 }])
  await step('detect')
  await step('units')
  await step('diff-lines')
  assert.deepEqual(await step('checkpoint'), { a: 4 }, 'the service agent still answers')
  assert.deepEqual(seen, [SERVICE_AGENT_TYPE, undefined, SERVICE_AGENT_TYPE, SERVICE_AGENT_TYPE, undefined, SERVICE_AGENT_TYPE])
  assert.deepEqual(ro.fallbacks(), [{ agent: STEP, count: 2 }])
})

test('makeDefaultTypeFallback: a deadline fire between two failures neither counts nor resets', async () => {
  const FIRED = { fired: true }
  const { ro, seen, step } = scripted([null, FIRED, FIRED, null, { a: 9 }], FIRED)
  await step('detect')
  assert.equal(await step('units'), null, 'a deadline fire is not rerun')
  assert.equal(await step('prior-round'), null)
  await step('diff-lines')
  assert.deepEqual(await step('checkpoint'), { a: 1 }, 'the two nulls around the deadlines retired the type')
  assert.deepEqual(seen, [SERVICE_AGENT_TYPE, undefined, SERVICE_AGENT_TYPE, SERVICE_AGENT_TYPE, SERVICE_AGENT_TYPE, undefined, undefined])
  assert.deepEqual(ro.fallbacks(), [{ agent: LAUNCH, count: 2 }, { agent: STEP, count: 1 }])
})

test('makeDefaultTypeFallback: deadline fires alone never retire the type', async () => {
  const FIRED = { fired: true }
  const { ro, seen, step } = scripted([FIRED, FIRED, FIRED, { a: 4 }], FIRED)
  for (const label of ['detect', 'units', 'diff-lines']) assert.equal(await step(label), null)
  assert.deepEqual(await step('checkpoint'), { a: 4 })
  assert.deepEqual(seen, [SERVICE_AGENT_TYPE, SERVICE_AGENT_TYPE, SERVICE_AGENT_TYPE, SERVICE_AGENT_TYPE])
  assert.deepEqual(ro.fallbacks(), [])
})
