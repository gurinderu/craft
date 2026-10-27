// The usage-limit matcher and the stop it drives (realm @nick/craft, node #299).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { usageLimitText, makeLimitStop, stopAtLimit, DEATH_STREAK_STOP } from './usage-limit.mjs'
import { LENS_WINDOW_AGENTS } from './lens-scope.mjs'
import { VERIFY_WINDOW_AGENTS } from './review-waves.mjs'
import { makeReviewAgent } from './review-run-agent.mjs'

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

// Deaths count in completion order and a dead agent returns long before a live one, so a whole window
// dying through its ladder must not reach the stop (realm @nick/craft, node #299). Raising a window, or
// review's re-dispatch count, without raising the threshold fails here. review's extra lenses run beside
// round 1 outside these windows and are uncapped, so they are not held here: the run raises its own
// threshold by their burst (lib/review-extra-lens-run.mjs; lib/death-streak-engine.test.mjs runs it).
test('DEATH_STREAK_STOP is above what one concurrency window can die through before any live answer', () => {
  const tries = makeReviewAgent({ runAgent: async () => null, logLine: () => {}, repoArg: '', deadlineArg: 0 }).AGENT_TRIES
  assert.ok(tries >= 1, 'premise: review\'s dispatch path declares AGENT_TRIES')
  // A lens dispatch is the reviewer agent, then the generic subagent, each through ragent's tries
  // (lib/review-lens-dispatch.mjs).
  const lensLadder = 2 * tries
  // A verification window counts agents already; each goes through ragent's tries.
  const verifyLadder = tries
  // unitScope gives one slot of the lens window to the round's coordinator, one ragent call (lib/review-unit-scope.mjs).
  const unitWindow = (LENS_WINDOW_AGENTS - 1) * lensLadder + tries
  const window = Math.max(LENS_WINDOW_AGENTS * lensLadder, unitWindow, VERIFY_WINDOW_AGENTS * verifyLadder)
  assert.ok(DEATH_STREAK_STOP > window, `${DEATH_STREAK_STOP} must exceed ${window}`)
})

test('makeLimitStop: a streak of deaths with no live answer between them is a stop, said once, worded as deaths', () => {
  assert.ok(DEATH_STREAK_STOP < 267, 'well under the fewest dead agents a limit-hit run spent')
  /** @type {string[]} */
  const said = []
  const stop = makeLimitStop(l => said.push(l))
  for (let i = 1; i < DEATH_STREAK_STOP; i++) assert.equal(stop.observeDeath(), false, `death ${i}`)
  assert.equal(stop.seen(), '')
  assert.equal(stop.cause(), '')
  assert.equal(stop.observeDeath(), true, 'the Nth death in a row stops the run')
  assert.equal(stop.cause(), 'deaths')
  assert.ok(stop.seen())
  assert.equal(stop.note(), `stopped: ${DEATH_STREAK_STOP} agents in a row died with no answer, most likely an account usage limit or an outage (the reason shows in the Workflow tool's failures list)`)
  assert.doesNotMatch(stop.note(), /usage limit reached/, 'a streak never claims the limit text was seen')
  assert.equal(stop.observeDeath(), true, 'stopped stays stopped')
  stop.observeLive()
  assert.ok(stop.seen(), 'a live answer in flight does not lift the stop')
  assert.equal(said.length, 1)
  assert.match(String(said[0]), /agents in a row died with no answer/)
})

test('makeLimitStop: a given threshold, raised by a burst, is the streak that stops and the N its note names', () => {
  const stop = makeLimitStop(() => {}, 5)
  stop.raise(3)
  stop.raise(-4)
  for (let i = 1; i < 8; i++) assert.equal(stop.observeDeath(), false, `death ${i}`)
  assert.equal(stop.observeDeath(), true, 'the eighth death in a row stops the run')
  assert.match(stop.note(), /^stopped: 8 agents in a row died with no answer/)
  const byDefault = makeLimitStop(() => {})
  byDefault.raise(2)
  for (let i = 1; i < DEATH_STREAK_STOP + 2; i++) assert.equal(byDefault.observeDeath(), false, `death ${i}`)
  assert.equal(byDefault.observeDeath(), true)
  assert.match(byDefault.note(), new RegExp(`^stopped: ${DEATH_STREAK_STOP + 2} agents in a row`))
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
