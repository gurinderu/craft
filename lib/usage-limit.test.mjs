// The usage-limit matcher and the stop it drives (realm @nick/craft, node #299).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { usageLimitText, makeLimitStop, stopAtLimit } from './usage-limit.mjs'

test('usageLimitText: the limit messages are recognised', () => {
  for (const msg of [
    "You've hit your weekly limit - resets Oct 24, 5pm",
    "You've hit your limit",
    "You've hit your 5-hour limit",
    'Claude AI usage limit reached|1761300000',
    'You have reached your usage limit for Opus.',
    '5-hour limit reached - resets 3pm',
    'Weekly limit reached, resets Monday',
  ]) assert.ok(usageLimitText(msg), msg)
})

test('usageLimitText: ordinary errors and review prose are not a limit', () => {
  for (const msg of [
    'agent died',
    'API Error: 429 rate limit exceeded, try again later',
    '429 Too Many Requests',
    'rate limited, resets in 30s',
    'Request rate limit reached for this model',
    "You've hit your rate limit",
    'craft-log-run FAILED: boom',
    'subagent completed without calling StructuredOutput',
    "agent type 'craft:rust-reviewer' not found",
    'memory limit exceeded while compiling',
    'the handler has no rate limit on login attempts',
    'the cache resets every hour',
    'budget exhausted (spent 3000 of 3000)',
    '',
    null,
  ]) assert.equal(usageLimitText(msg), '', String(msg))
})

test('usageLimitText: the matching line, collapsed and bounded', () => {
  assert.equal(usageLimitText('Error:\n  You\'ve hit   your weekly limit\nstack'), "You've hit your weekly limit")
  assert.equal(usageLimitText(`You've hit your weekly limit ${'x'.repeat(400)}`).length, 200)
})

test('makeLimitStop: the first limit wins, is said once, and becomes the note', () => {
  /** @type {string[]} */
  const said = []
  const stop = makeLimitStop(l => said.push(l))
  assert.equal(stop.seen(), '')
  assert.equal(stop.note(), '')
  assert.equal(stop.observeError(new Error('agent died')), false)
  assert.equal(stop.observeAnswer('rate limit everything'), false, 'no limit wording')
  assert.equal(stop.observeAnswer({ text: "You've hit your weekly limit" }), false, 'only a text answer is read')
  assert.equal(stop.observeAnswer(`report body ${'y'.repeat(500)} You've hit your weekly limit`), false, 'a long answer is a report, not an error')
  assert.equal(stop.observeError(new Error("You've hit your weekly limit - resets 5pm")), true)
  assert.equal(stop.observeAnswer("You've hit your daily limit"), true)
  assert.equal(stop.seen(), "You've hit your weekly limit - resets 5pm")
  assert.equal(stop.note(), "stopped: usage limit reached (You've hit your weekly limit - resets 5pm)")
  assert.equal(said.length, 1)
})

test('stopAtLimit: a limit failure becomes a null and stops every later dispatch', async () => {
  const stop = makeLimitStop(() => {})
  /** @type {string[]} */
  const dispatched = []
  const call = stopAtLimit(async (/** @type {string} */ p) => {
    dispatched.push(p)
    if (p === 'limit') throw new Error("You've hit your weekly limit")
    if (p === 'boom') throw new Error('boom')
    return { ok: p }
  }, stop)
  assert.deepEqual(await call('a', {}), { ok: 'a' })
  await assert.rejects(call('boom', {}), /boom/, 'an ordinary throw still throws')
  assert.equal(await call('limit', {}), null)
  assert.equal(await call('b', {}), null)
  assert.deepEqual(dispatched, ['a', 'boom', 'limit'], 'nothing is dispatched after the limit')
})

// A round is dead only when every agent dispatched in it came back null (realm @nick/craft, node #299).
/** @param {ReturnType<typeof makeLimitStop>} stop @param {Array<'dead' | 'live' | 'slow'>} outcomes */
const roundOf = (stop, outcomes) => {
  const call = stopAtLimit(async (/** @type {string} */ p) => (p === 'live' ? { ok: 1 } : p === 'slow' ? new Promise(r => setTimeout(() => r({ ok: 2 }), 5)) : null), stop)
  return stop.round('lens round 1', () => Promise.all(outcomes.map(o => call(o, {}))))
}

test('makeLimitStop: a round whose every agent died is a stop, said once, worded as deaths', async () => {
  /** @type {string[]} */
  const said = []
  const stop = makeLimitStop(l => said.push(l))
  await roundOf(stop, Array(200).fill('dead'))
  assert.equal(stop.cause(), 'deaths')
  assert.equal(stop.note(), "stopped: every agent dispatched in lens round 1 died with no answer, most likely the account's usage limit or a failure (the reason shows in the Workflow tool's failures list)")
  assert.doesNotMatch(stop.note(), /usage limit reached/, 'a dead round never claims the limit text was seen')
  assert.equal(said.length, 1)
  assert.equal(await roundOf(stop, ['live']).then(r => r[0]), null, 'nothing is dispatched after the stop')
})

test('makeLimitStop: one live answer, even the last to settle after hundreds of deaths, keeps the round alive', async () => {
  const stop = makeLimitStop(() => {})
  await roundOf(stop, [...Array(300).fill('dead'), 'slow'])
  assert.equal(stop.seen(), '')
  await roundOf(stop, ['live', 'dead'])
  assert.equal(stop.seen(), '')
})

test('makeLimitStop: deaths outside any round, and a round with no dispatch, stop nothing', async () => {
  const stop = makeLimitStop(() => {})
  const call = stopAtLimit(async () => null, stop)
  for (let i = 0; i < 300; i++) await call('dead', {})
  await stop.round('an empty pass', async () => [])
  assert.equal(stop.seen(), '')
})

test('makeLimitStop: an agent still in flight when its round settles keeps the round alive', async () => {
  const stop = makeLimitStop(() => {})
  await stop.round('lens round 1', async () => {
    stop.observeDispatch()
    const died = stop.observeDispatch()
    died()
    died()
  })
  assert.equal(stop.seen(), '', 'one of its two agents had not died, and a death counts once')
})

test('makeLimitStop: a thrown agent is not a death, and the limit text keeps its own wording over a dead round', async () => {
  const thrower = makeLimitStop(() => {})
  const boom = stopAtLimit(async () => { throw new Error('boom') }, thrower)
  await thrower.round('verification', () => boom('x', {}).catch(() => null))
  assert.equal(thrower.seen(), '', 'a throw carries its error, and a budget-exceeded one must still fail the run closed')
  const stop = makeLimitStop(() => {})
  stop.observeError(new Error("You've hit your weekly limit"))
  await stop.round('lens round 1', async () => { stop.observeDispatch()() })
  assert.equal(stop.cause(), 'limit')
  assert.equal(stop.note(), "stopped: usage limit reached (You've hit your weekly limit)")
})

test('makeLimitStop: an attempt counts only in the rounds open when it was dispatched', async () => {
  // Dispatched before the round opened and dying inside it: no death of that round's.
  const early = makeLimitStop(() => {})
  const earlyCall = stopAtLimit(async (/** @type {string} */ p) => (p === 'live' ? { ok: 1 } : null), early)
  /** @type {(v: null) => void} */
  let release = () => {}
  const before = stopAtLimit(() => new Promise(r => { release = r }), early)('early', {})
  await early.round('lens round 1', async () => {
    const live = earlyCall('live', {})
    release(null)
    await before
    return live
  })
  assert.equal(early.seen(), '', 'one live answer of the round, and an outside death, is no dead round')
  // The same with every agent of the round dead: the outside attempt neither adds a death nor hides one.
  const all = makeLimitStop(() => {})
  /** @type {(v: null) => void} */
  let release2 = () => {}
  const before2 = stopAtLimit(() => new Promise(r => { release2 = r }), all)('early', {})
  const dead = stopAtLimit(async () => null, all)
  await all.round('lens round 1', async () => {
    const d = await dead('x', {})
    release2(null)
    await before2
    return d
  })
  assert.equal(all.cause(), 'deaths', 'the round died whole')
})
