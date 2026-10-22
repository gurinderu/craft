// The usage-limit matcher and the stop it drives (realm @nick/craft, node #299).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { usageLimitText, makeLimitStop, stopAtLimit, DEATH_STREAK_STOP } from './usage-limit.mjs'

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

test('makeLimitStop: a streak of deaths with no live answer between them is a stop, said once, worded as deaths', () => {
  assert.ok(DEATH_STREAK_STOP > 12 && DEATH_STREAK_STOP <= 16, 'above one dead lens\'s whole ladder (twelve), at most a wave of four dying lenses')
  /** @type {string[]} */
  const said = []
  const stop = makeLimitStop(l => said.push(l))
  for (let i = 1; i < DEATH_STREAK_STOP; i++) assert.equal(stop.observeDeath(), false, `death ${i}`)
  assert.equal(stop.seen(), '')
  assert.equal(stop.cause(), '')
  assert.equal(stop.observeDeath(), true, 'the Nth death in a row stops the run')
  assert.equal(stop.cause(), 'deaths')
  assert.ok(stop.seen())
  assert.equal(stop.note(), `stopped: ${DEATH_STREAK_STOP} agents in a row died with no answer, most likely an account usage limit (the reason shows in the Workflow tool's failures list)`)
  assert.doesNotMatch(stop.note(), /usage limit reached/, 'a streak never claims the limit text was seen')
  assert.equal(stop.observeDeath(), true, 'stopped stays stopped')
  stop.observeLive()
  assert.ok(stop.seen(), 'a live answer in flight does not lift the stop')
  assert.equal(said.length, 1)
  assert.match(String(said[0]), /agents in a row died with no answer/)
})

test('makeLimitStop: a live answer resets the streak', () => {
  const stop = makeLimitStop(() => {})
  for (let round = 0; round < 3; round++) {
    for (let i = 1; i < DEATH_STREAK_STOP; i++) stop.observeDeath()
    stop.observeLive()
  }
  assert.equal(stop.seen(), '', 'three near-streaks broken by live answers are not a stop')
  assert.equal(stop.observeDeath(), false)
})

test('makeLimitStop: the limit text, once seen, keeps its own wording over a later streak', () => {
  const stop = makeLimitStop(() => {})
  stop.observeError(new Error("You've hit your weekly limit"))
  for (let i = 0; i < DEATH_STREAK_STOP; i++) assert.equal(stop.observeDeath(), true)
  assert.equal(stop.cause(), 'limit')
  assert.equal(stop.note(), "stopped: usage limit reached (You've hit your weekly limit)")
})

test('stopAtLimit: null answers build the streak, a live one resets it, and the streak stops dispatch', async () => {
  const stop = makeLimitStop(() => {})
  let n = 0
  const call = stopAtLimit(async (/** @type {string} */ p) => { n++; return p === 'live' ? { ok: 1 } : null }, stop)
  for (let i = 1; i < DEATH_STREAK_STOP; i++) await call('dead', {})
  assert.deepEqual(await call('live', {}), { ok: 1 })
  for (let i = 1; i < DEATH_STREAK_STOP; i++) await call('dead', {})
  assert.equal(stop.seen(), '', 'reset by the live answer')
  assert.equal(await call('dead', {}), null)
  assert.equal(stop.cause(), 'deaths')
  const before = n
  assert.equal(await call('live', {}), null, 'nothing is dispatched after the streak')
  assert.equal(n, before)
})
