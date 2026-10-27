// What a stopped run tells a human, and how a parent reads a nested run's stop (realm @nick/craft, nodes #299, #300).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { makeLimitStop, DEATH_STREAK_STOP } from './usage-limit.mjs'
import { loggerCommand, limitStopAdvice, limitInReport, deathsInReport } from './limit-report.mjs'

test('limitStopAdvice: a death-streak stop names the deaths, not a limit message', () => {
  const stop = makeLimitStop(() => {})
  for (let i = 0; i < DEATH_STREAK_STOP; i++) stop.observeDeath()
  const advice = limitStopAdvice(stop, { version: '1.2.3', engine: 'review', checkpoints: true })
  assert.ok(advice.startsWith(`stopped: ${DEATH_STREAK_STOP} agents in a row died with no answer, most likely an account usage limit or an outage`), advice)
  assert.ok(advice.endsWith(`\`${loggerCommand('1.2.3')} recover\``), advice)
})

test('loggerCommand: the plugin root, else the installed copy; nothing a model supplied', () => {
  assert.equal(loggerCommand('1.2.3'), 'node "${CLAUDE_PLUGIN_ROOT:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/1.2.3}"/lib/craft-log-run.mjs')
  assert.equal(loggerCommand('1.2.3"; rm -rf ~; echo "'), 'node "${CLAUDE_PLUGIN_ROOT:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/1.2.3rm-rfecho}"/lib/craft-log-run.mjs', 'a version cannot break out of the quotes')
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
  assert.doesNotMatch(without, /recover|from-journal/, 'no recovery claimed for an engine that writes no checkpoints')
  assert.ok(without.endsWith("this run's record could not be written (rust-audit writes no checkpoints): rerun the audit after the limit resets"), without)
  assert.match(limitStopAdvice(stop, { ...audit, engine: 'adversarial-review' }), /rerun the review after the limit resets$/)
})

test('limitInReport: the stop a nested review states, and nothing else', () => {
  const stopped = "## x Usage limit reached\nstopped: usage limit reached (You've hit your weekly limit - resets 5pm (Europe/Berlin)). The run record was attempted"
  assert.equal(limitInReport(stopped), "You've hit your weekly limit - resets 5pm (Europe/Berlin)")
  assert.equal(limitInReport('## Verdict\nINCOMPLETE \u2014 x \u00b7 part of this review did not run: stopped: usage limit reached (Weekly limit reached, resets Monday); b'), 'Weekly limit reached, resets Monday')
  assert.equal(limitInReport('## Verdict\nApprove \u2014 the handler has no rate limit'), '')
  assert.equal(limitInReport('stopped: usage limit reached (agent died)'), '', 'only a limit message counts')
  assert.equal(limitInReport(null), '')
})

test('deathsInReport: the death streak a nested review states, and nothing else', () => {
  const stop = makeLimitStop(() => {})
  for (let i = 0; i < DEATH_STREAK_STOP; i++) stop.observeDeath()
  const nested = `## \u26d4 Agents keep dying with no answer\n${limitStopAdvice(stop, { version: '1.2.3', engine: 'review', checkpoints: true })}`
  assert.equal(deathsInReport(nested), `${DEATH_STREAK_STOP} agents in a row died with no answer`)
  assert.equal(limitInReport(nested), '', 'a streak is not a limit message')
  assert.equal(deathsInReport('## Verdict\nINCOMPLETE \u2014 one agent died with no answer'), '')
  assert.equal(deathsInReport(null), '')
  const parent = makeLimitStop(() => {})
  assert.equal(parent.observeReportedDeaths(deathsInReport(nested)), true)
  assert.equal(parent.cause(), 'deaths')
  assert.equal(parent.note(), stop.note(), 'the parent states the same stop as the nested review')
  assert.equal(makeLimitStop(() => {}).observeReportedDeaths(''), false, 'no report, no stop')
})
