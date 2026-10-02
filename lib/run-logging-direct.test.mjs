// Direct tests of lib/run-logging.mjs at the edges run-logging.test.mjs leaves open: the logger
// result schema's shape, quoting of an absent or quoted value, what the prompts emit when craftRoot,
// repo, version or phase are left at their defaults, and the model-size boundary.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { LOGRUN_SCHEMA, shq, loggerPrelude, payloadVersion, logRunPrompt, logRunDispatch, checkpointPrompt, logRunOutcome } from './run-logging.mjs'

/** @param {string} text */
const candidates = text => text.split('CRAFT_TRY=').length - 1

test('the logger result schema asks for a boolean ok and an optional string error, nothing else', () => {
  assert.equal(LOGRUN_SCHEMA.type, 'object')
  assert.equal(LOGRUN_SCHEMA.additionalProperties, false)
  assert.deepEqual(LOGRUN_SCHEMA.required, ['ok'])
  assert.deepEqual(Object.keys(LOGRUN_SCHEMA.properties), ['ok', 'error'])
  assert.equal(LOGRUN_SCHEMA.properties.ok.type, 'boolean')
  assert.equal(LOGRUN_SCHEMA.properties.error.type, 'string')
  for (const p of Object.values(LOGRUN_SCHEMA.properties)) assert.ok(p.description.length > 0, 'the model steers by the description')
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
  assert.match(out, /no installed copy of "'this version'" under the plugin cache/)
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
