// The usage-limit matcher and the stop it drives (realm @nick/craft, node #299).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { usageLimitText, makeLimitStop, stopAtLimit, loggerCommand, limitStopAdvice } from './usage-limit.mjs'

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

test('loggerCommand: located as the engine locates its logger', () => {
  assert.equal(loggerCommand('1.2.3'), 'node "${CLAUDE_PLUGIN_ROOT:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/1.2.3}"/lib/craft-log-run.mjs')
  assert.equal(loggerCommand('1.2.3', "/opt/it's craft"), "node '/opt/it'\\''s craft'/lib/craft-log-run.mjs", 'an absolute craftRoot first, quoted')
  assert.match(loggerCommand('1.2.3', 'relative/root'), /CLAUDE_PLUGIN_ROOT/, 'a relative craftRoot is not used, as the logger refuses it')
})

test('limitStopAdvice: nothing without a stop; with one, the note and the engine\'s own recovery', () => {
  const stop = makeLimitStop(() => {})
  const review = { version: '1.2.3', engine: 'review', checkpoints: true }
  const audit = { version: '1.2.3', engine: 'rust-audit', checkpoints: false }
  assert.equal(limitStopAdvice(stop, review), '')
  stop.observeError(new Error("You've hit your weekly limit"))
  const cmd = loggerCommand('1.2.3')
  const withCheckpoints = limitStopAdvice(stop, review)
  assert.ok(withCheckpoints.startsWith("stopped: usage limit reached (You've hit your weekly limit)."), withCheckpoints)
  assert.ok(withCheckpoints.endsWith(`\`${cmd} recover\``), withCheckpoints)
  const without = limitStopAdvice(stop, audit)
  assert.doesNotMatch(without, / recover`/, 'no recover for an engine that writes no checkpoints')
  assert.match(without, /rust-audit writes no checkpoints/)
  assert.ok(without.endsWith(`\`${cmd} from-journal <that directory> --name rust-audit\``), without)
})
