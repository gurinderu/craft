// Direct tests of lib/run-logging.mjs at the edges run-logging.test.mjs leaves open: the logger
// result schema's shape, quoting of an absent or quoted value, what the prompts emit when craftRoot,
// repo, version or phase are left at their defaults, and the model-size boundary.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { LOGRUN_SCHEMA, shq, loggerPrelude, payloadVersion, logRunPrompt, logRunDispatch, checkpointPrompt, logRunOutcome } from './run-logging.mjs'

/** @param {string} text */
const candidates = text => text.split('CRAFT_TRY=').length - 1

// A contract, not a table: logRunOutcome trusts a write only on `ok === true`, so the agent must be
// made to assert `ok` as a boolean, and its `error` must be text it can quote.
test('the logger result schema requires a boolean ok, which is what logRunOutcome reads', () => {
  assert.ok(LOGRUN_SCHEMA.required.includes('ok'))
  assert.equal(LOGRUN_SCHEMA.properties.ok.type, 'boolean')
  assert.equal(LOGRUN_SCHEMA.properties.error.type, 'string')
})

test('shq quotes an absent value as empty and escapes a single quote', () => {
  assert.equal(shq(null), "''")
  assert.equal(shq("it's"), `'it'\\''s'`)
})

test('loggerPrelude with no version tries only the plugin root, and resolves an unnamed repo as "."', () => {
  const out = loggerPrelude('')
  assert.equal(candidates(out), 1)
  assert.ok(out.startsWith(`CRAFT_REPO="$(cd '.' 2>/dev/null && pwd -P)"`))
  assert.ok(!out.includes('plugins/cache'))
  assert.ok(out.includes('fi\n[ -n "${CRAFT_LOGGER:-}" ] ||'), 'the last candidate is followed by the check itself')
})

test('payloadVersion of an absent payload is empty', () => {
  assert.equal(payloadVersion(null), '')
})

test('logRunPrompt and checkpointPrompt at their defaults: no explicit root, the current directory, no rejoin', () => {
  for (const prompt of [logRunPrompt({ record: {} }), checkpointPrompt({ payload: {} })]) {
    assert.equal(candidates(prompt), 1)
    assert.match(prompt, /\ncd '\.' && node "\$CRAFT_LOGGER" /)
    assert.ok(!prompt.includes('--rejoin'))
  }
  assert.match(checkpointPrompt({ payload: {} }), / checkpoint --phase '' /)
})

test('the prompts cd into a named repo', () => {
  assert.match(logRunPrompt({ record: {}, repo: '/r' }), /\ncd '\/r' && node /)
  assert.match(checkpointPrompt({ payload: {}, repo: '/r' }), /\ncd '\/r' && node /)
})

test('logRunDispatch: exactly 24KB is still small; the phase defaults to none; the effort is low', () => {
  const at = { a: 'x'.repeat(24 * 1024 - 8) }
  assert.equal(JSON.stringify(at).length, 24 * 1024)
  const d = logRunDispatch(at)
  assert.deepEqual([d.model, d.label, d.phase, d.effort], ['haiku', 'log-run', '', 'low'])
  assert.equal(logRunDispatch({ a: 'x'.repeat(24 * 1024) }).model, 'sonnet')
})

test('logRunOutcome trims the warning a landed write carries', () => {
  assert.deepEqual(logRunOutcome({ ok: true, error: '  craft-log-run WARNING: x \n' }), { ok: true, reason: 'craft-log-run WARNING: x' })
})
