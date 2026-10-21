import { test } from 'vitest'
import assert from 'node:assert/strict'
import { continuation, notHuman, otherLanguage, recentKind } from './work-hook-word.mjs'
import { promptKind } from './work-hook-kind.mjs'

const HANDBACK = 'Another Claude session sent a message:\n<agent-message from="worker">\nAddressed the review findings on the PR; fixed 3 PR comments.\n</agent-message>'
const NOTIFICATION = 'Background agent done.\n<task-notification>\n<result>review findings: 3, PR comments addressed</result>\n</task-notification>'
// Greek "continue", from code points: the hook's sources carry English only.
const GREEK_CONTINUE = String.fromCodePoint(0x3c3, 0x3c5, 0x3bd, 0x3ad, 0x3c7, 0x3b9, 0x3c3, 0x3b5)

test('a subagent hand-back and a task notification are not a human\'s word, whatever their words', () => {
  for (const p of [HANDBACK, NOTIFICATION, '<agent-message from="a">review the PR</agent-message>', '<task-notification>\n<result>x</result>']) {
    assert.equal(notHuman(p), true, p)
    assert.equal(promptKind(p, 'findings'), null, p)
  }
  for (const p of ['review this branch', 'why does the hook skip "<task-notification>" prompts? review it', 'the agent said: Another Claude session sent a message: hi']) {
    assert.equal(notHuman(p), false, p)
  }
})

test('a bare English continuation takes the recent kind; with none, or inside a request with its own subject, it is classed as before', () => {
  for (const p of ['continue', 'Keep going!', 'finish it', 'finish the work', 'finish up', 'ok, carry on', 'great, go ahead please', 'proceed']) {
    assert.equal(continuation(p), true, p)
    assert.equal(promptKind(p, 'findings'), 'findings', p)
    assert.equal(promptKind(p, 'review'), 'review', p)
    assert.equal(promptKind(p, 'other-language'), 'other-language', p)
    assert.equal(promptKind(p), null, p)
  }
  for (const p of ['continue the parser refactor', 'finish the migration script', 'keep the old API', '', 'please', GREEK_CONTINUE]) {
    assert.equal(continuation(p), false, p)
    assert.notEqual(promptKind(p, 'findings'), 'findings', p)
  }
  assert.equal(promptKind(GREEK_CONTINUE, 'findings'), 'other-language', 'a continuation in another script is the model\'s to class')
  assert.equal(promptKind('continue the review', 'findings'), 'review', 'its own subject wins')
})

test('another script: at least three letters outside Latin and at least 30% of the letters', () => {
  assert.equal(otherLanguage(GREEK_CONTINUE), true)
  assert.equal(otherLanguage(`${GREEK_CONTINUE} the review`), true)
  assert.equal(otherLanguage(`please review the parser and the lexer, says ${GREEK_CONTINUE}`), false)
  assert.equal(otherLanguage('naïve café résumé'), false)
  assert.equal(otherLanguage('12 + 3 = 15'), false)
})

test('the recent kind: the latest classed UserPromptSubmit line of the same repo within 12 hours', () => {
  const now = new Date('2026-10-20T12:00:00Z')
  /** @param {Partial<import('./hook-log.mjs').HookEntry>} x @returns {import('./hook-log.mjs').HookEntry} */
  const e = x => ({ ts: '2026-10-20T10:00:00.000Z', repo: '/r', source: '', event: 'UserPromptSubmit', session: 'old', spoke: true, found: [], silent: null, ...x })
  assert.equal(recentKind([e({ kind: 'findings' })], '/r', now), 'findings')
  assert.equal(recentKind([e({ kind: 'other-language' })], '/r', now), 'other-language')
  assert.equal(recentKind([e({ kind: 'findings', spoke: false, silent: 'already-said' })], '/r', now), 'findings', 'a silent line still names the kind')
  assert.equal(recentKind([e({ kind: 'findings', ts: '2026-10-19T23:59:00.000Z' })], '/r', now), null, 'older than 12 hours')
  assert.equal(recentKind([e({ kind: 'findings', repo: '/other' })], '/r', now), null, 'another repo')
  assert.equal(recentKind([e({ kind: 'findings', event: 'SubagentStart' })], '/r', now), null)
  assert.equal(recentKind([e({}), e({ silent: 'not-human', spoke: false })], '/r', now), null, 'lines without a kind')
  assert.equal(recentKind([e({ kind: 'review', ts: '2026-10-20T11:00:00.000Z' }), e({ kind: 'findings' })], '/r', now), 'review', 'the latest by time')
  assert.equal(recentKind([e({ kind: 'review' }), e({ kind: 'findings' })], '/r', now), 'findings', 'on a tie, the later line')
  assert.equal(recentKind([], '/r', now), null)
})
