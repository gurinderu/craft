import { test } from 'vitest'
import assert from 'node:assert/strict'
import { saidInSession } from './work-hook-said.mjs'

/** @typedef {import('./hook-log.mjs').HookEntry} HookEntry */
/** @param {Partial<HookEntry>} x @returns {HookEntry} */
const e = x => ({
  ts: '2026-10-20T10:00:00.000Z',
  repo: '/r',
  source: '',
  event: 'UserPromptSubmit',
  session: 's',
  spoke: false,
  found: [],
  silent: 'no-kind',
  ...x,
})
const findings = (/** @type {Partial<HookEntry>} */ x = {}) => e({ kind: 'findings', spoke: true, silent: null, ...x })
const clear = (/** @type {string} */ session) => e({ event: 'SessionStart', source: 'clear', session, silent: null })

test('lines said count until a clear or compact of their own session', () => {
  const nudge = e({ silent: null, spoke: true, reason: 're-review-nudge' })
  assert.equal(saidInSession([findings()], 's'), true)
  assert.equal(saidInSession([findings(), clear('s')], 's'), false)
  assert.equal(saidInSession([findings(), clear('x')], 's'), true)
  assert.equal(saidInSession([nudge], 's'), false, "a nudge line is no request's text")
  assert.equal(saidInSession([findings(), e({ event: 'SessionStart', source: 'compact', silent: null })], 's'), false)
})
