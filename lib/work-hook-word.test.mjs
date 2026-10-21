import { test } from 'vitest'
import assert from 'node:assert/strict'
import { continuation, notHuman, otherLanguage, subagentReport } from './work-hook-word.mjs'
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
  // The shape observed in Claude Code 2.x: `from` is the agent's id.
  assert.equal(subagentReport('Another Claude session sent a message:\n<agent-message from="a627e0ee592a02009">\ndone\n</agent-message>'), true)
  assert.equal(subagentReport(NOTIFICATION), false, 'a task notification may be a shell command')
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
