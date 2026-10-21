import { test } from 'vitest'
import assert from 'node:assert/strict'
import { nudgedInSession, recentKind, saidInSession } from './work-hook-said.mjs'

/** @typedef {import('./hook-log.mjs').HookEntry} HookEntry */
const NOW = new Date('2026-10-20T12:00:00Z')
/** @param {Partial<HookEntry>} x @returns {HookEntry} */
const e = x => ({ ts: '2026-10-20T10:00:00.000Z', repo: '/r', source: '', event: 'UserPromptSubmit', session: 's', spoke: false, found: [], silent: 'no-kind', ...x })
const findings = (/** @type {Partial<HookEntry>} */ x = {}) => e({ kind: 'findings', spoke: true, silent: null, ...x })
const clear = (/** @type {string} */ session) => e({ event: 'SessionStart', source: 'clear', session, silent: null })

test('a continuation takes the kind of this session\'s latest human prompt, an unclassed one giving null', () => {
  assert.equal(recentKind([findings()], '/r', 's', NOW), 'findings')
  assert.equal(recentKind([findings({ spoke: false, silent: 'already-said' })], '/r', 's', NOW), 'findings', 'a silent line still names the kind')
  assert.equal(recentKind([findings(), e({})], '/r', 's', NOW), null, '"implement X" came after the findings request')
  assert.equal(recentKind([findings({ ts: '2026-10-19T01:00:00.000Z' })], '/r', 's', NOW), 'findings', 'its own session is not bounded by time')
  assert.equal(recentKind([findings(), e({ silent: 'not-human' }), e({ silent: null, spoke: true, reason: 're-review-nudge' })], '/r', 's', NOW), 'findings', 'an agent\'s words and the nudge are no human prompt')
  assert.equal(recentKind([findings({ session: 'a' }), e({ session: 'b' })], '/r', 'b', NOW), null, 'session B said something unclassed: A\'s kind does not reach it')
})

test('a session with no human prompt yet (or since a clear or compact) takes the repo\'s latest from another session within 12 hours', () => {
  assert.equal(recentKind([findings({ session: 'a' })], '/r', 'b', NOW), 'findings')
  assert.equal(recentKind([findings({ session: 'a' }), e({ session: 'c', ts: '2026-10-20T11:00:00.000Z' })], '/r', 'b', NOW), null, 'the latest is unclassed')
  assert.equal(recentKind([findings({ session: 'a', ts: '2026-10-19T23:59:00.000Z' })], '/r', 'b', NOW), null, 'older than 12 hours')
  assert.equal(recentKind([findings({ session: 'a', repo: '/other' })], '/r', 'b', NOW), null, 'another repo')
  assert.equal(recentKind([findings({ session: 'a', event: 'SubagentStart' })], '/r', 'b', NOW), null)
  assert.equal(recentKind([findings(), clear('s'), e({ session: 'a', kind: 'review', spoke: true, silent: null })], '/r', 's', NOW), 'findings', 'a clear or compact does not drop the session\'s own request')
  assert.equal(recentKind([e({}), clear('s'), findings({ session: 'a' })], '/r', 's', NOW), null, 'nor its unclassed one')
  assert.equal(recentKind([findings({ session: 'a', ts: '2026-10-20T11:00:00.000Z' }), e({ session: 'c' })], '/r', 'b', NOW), 'findings', 'the latest by time')
  assert.equal(recentKind([], '/r', 'b', NOW), null)
})

test('lines said and the nudge count until a clear or compact of their own session', () => {
  const nudge = e({ silent: null, spoke: true, reason: 're-review-nudge' })
  assert.equal(nudgedInSession([nudge], 's'), true)
  assert.equal(nudgedInSession([nudge, clear('s')], 's'), false)
  assert.equal(nudgedInSession([nudge, clear('x')], 's'), true)
  assert.equal(saidInSession([nudge], 's'), false, 'a nudge line is no request\'s text')
  assert.equal(saidInSession([findings(), e({ event: 'SessionStart', source: 'compact', silent: null })], 's'), false)
})
