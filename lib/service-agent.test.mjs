// The engines' service steps run as craft's own engine-service agent, which starts without the project's
// instructions; a step that needs another tool, the consumer's instructions or judgement keeps its own type
// (lib/service-agent.mjs, realm @nick/craft, node #397). Driven through the whole review and adversarial-review engines.
// The run record counts a step the default type answered by reason: the type could not launch, or one step failed.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { SERVICE_AGENT_TYPE, makeDefaultTypeFallback } from './service-agent.mjs'
import { fitsSchema } from './agent-type-fallback.mjs'
const LAUNCH = `${SERVICE_AGENT_TYPE} (launch failed)`
const STEP = `${SERVICE_AGENT_TYPE} (step rerun)`
const NOT_FOUND = `Agent type '${SERVICE_AGENT_TYPE}' not found.\nAvailable agents: general-purpose`
const NO_STRUCTURED = 'agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)'

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
  const ro = makeDefaultTypeFallback(
    async (/** @type {string} */ _p, /** @type {{ agentType?: string | undefined, label?: string, schema?: object }} */ o) => {
      seen.push(o)
      return o.agentType ? { off: 1 } : { a: 1 }
    },
    l => logs.push(l),
    () => stop,
  )
  const schema = { type: 'object', required: ['a'] }
  assert.deepEqual(await ro.run('p', { agentType: SERVICE_AGENT_TYPE, label: 'x', schema }), { a: 1 })
  assert.deepEqual(
    seen.map(o => o.agentType),
    [SERVICE_AGENT_TYPE, undefined],
  )
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
  const ro = makeDefaultTypeFallback(
    async (/** @type {string} */ _p, /** @type {{ agentType?: string | undefined, label?: string }} */ o) => {
      seen.push(o.agentType)
      if (o.agentType === SERVICE_AGENT_TYPE) throw new Error(NOT_FOUND)
      return 'ok'
    },
    l => logs.push(l),
  )
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
  const ro = makeDefaultTypeFallback(
    async () => {
      calls++
      throw new Error('usage limit')
    },
    () => {},
    () => true,
  )
  assert.equal(ro.route({ agentType: SERVICE_AGENT_TYPE }).agentType, SERVICE_AGENT_TYPE)
  await assert.rejects(ro.run('p', { agentType: SERVICE_AGENT_TYPE }), /usage limit/)
  assert.equal(calls, 1)
  assert.deepEqual(ro.fallbacks(), [])
})

test('makeDefaultTypeFallback: a deadline fire is never rerun and comes back as null, on the service type or any other', async () => {
  const FIRED = { fired: true }
  /** @type {(string | undefined)[]} */
  const seen = []
  const ro = makeDefaultTypeFallback(
    async (/** @type {string} */ _p, /** @type {{ agentType?: string | undefined }} */ o) => {
      seen.push(o.agentType)
      return FIRED
    },
    () => {},
    () => false,
    got => got === FIRED,
  )
  assert.equal(await ro.run('p', { agentType: SERVICE_AGENT_TYPE }), null)
  assert.deepEqual(seen, [SERVICE_AGENT_TYPE], 'no rerun after a deadline fire')
  assert.equal(await ro.run('p', { agentType: 'craft:rust-reviewer' }), null, 'the marker never leaks')
  assert.deepEqual(ro.fallbacks(), [])
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
  const ro = makeDefaultTypeFallback(
    async (/** @type {string} */ _p, /** @type {{ agentType?: string | undefined, label?: string, schema?: object }} */ o) => {
      seen.push(o.agentType)
      if (!o.agentType) return { a: 1 }
      const next = script[i++]
      if (typeof next === 'string' && next.startsWith('throw:')) throw new Error(next.slice(6))
      return next
    },
    l => logs.push(l),
    () => false,
    got => fired !== undefined && got === fired,
  )
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
  assert.match(
    String(logs[0]),
    /'detect' as craft:engine-service threw .*StructuredOutput.* re-running this step once on the default agent type; later service steps still try/,
  )
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
  assert.deepEqual(ro.fallbacks(), [
    { agent: LAUNCH, count: 2 },
    { agent: STEP, count: 1 },
  ])
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
  assert.deepEqual(ro.fallbacks(), [
    { agent: LAUNCH, count: 2 },
    { agent: STEP, count: 1 },
  ])
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
  assert.deepEqual(ro.fallbacks(), [
    { agent: LAUNCH, count: 2 },
    { agent: STEP, count: 1 },
  ])
})

test('makeDefaultTypeFallback: deadline fires alone never retire the type', async () => {
  const FIRED = { fired: true }
  const { ro, seen, step } = scripted([FIRED, FIRED, FIRED, { a: 4 }], FIRED)
  for (const label of ['detect', 'units', 'diff-lines']) assert.equal(await step(label), null)
  assert.deepEqual(await step('checkpoint'), { a: 4 })
  assert.deepEqual(seen, [SERVICE_AGENT_TYPE, SERVICE_AGENT_TYPE, SERVICE_AGENT_TYPE, SERVICE_AGENT_TYPE])
  assert.deepEqual(ro.fallbacks(), [])
})
