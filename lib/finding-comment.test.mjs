// The inline PR comment for a Confirmed finding and its reading back (lib/finding-comment.mjs, inlined
// into src/review.js). The thread rule that reads it across a PR: pr-rejections.test.mjs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { commentLine, findingCommentBody, readFindingComment, hiddenLine, LENS_LINE, QUESTION_ASK, FINDING_COMMENT_MARKER as MARK } from './finding-comment.mjs'

test('commentLine: one line, every whitespace run one space, ends trimmed; nullish is empty', () => {
  assert.equal(commentLine('  a \n\t b\r\nc  '), 'a b c')
  assert.equal(commentLine(undefined), '')
  assert.equal(commentLine(null), '')
  assert.equal(commentLine(42), '42')
})

test('body: severity and title on one line, reason and fix trimmed, lens and rule lines, the marker last', () => {
  const body = findingCommentBody({ severity: ' High ', title: 'unwrap\nmay panic', why: '  it panics \n', fix: '\n return an error ', source: 'security', toolRule: 'clippy::unwrap_used' })
  assert.equal(body, `[High] unwrap may panic\n\nit panics — return an error\n\n<!-- craft-lens: security -->\n<!-- craft-tool-rule: clippy::unwrap_used -->\n${MARK}`)
})

test('body: no reason, fix, lens or rule — empty in place, no hidden lines', () => {
  assert.equal(findingCommentBody({ severity: 'Low', title: 't' }), `[Low] t\n\n — \n\n${MARK}`)
})

test('body: a lens or rule unfit for its line is left out', () => {
  const body = findingCommentBody({ severity: 'Low', title: 't', why: 'w', fix: 'f', source: 'a<b', toolRule: 'has space' })
  assert.equal(body, `[Low] t\n\nw — f\n\n${MARK}`)
})

test('read: the body the engine writes reads back with its lens and rule', () => {
  const body = findingCommentBody({ severity: 'Medium', title: 'leak', why: 'w', fix: 'f', source: 'perf', toolRule: 'semgrep/x.y' })
  assert.deepEqual(readFindingComment(body), { severity: 'Medium', title: 'leak', lens: 'perf', toolRule: 'semgrep/x.y' })
})

test('read: a first line indented or padded still reads; severity matched in any case', () => {
  assert.deepEqual(readFindingComment(`   [critical] a title   \nmore\n${MARK}`), { severity: 'critical', title: 'a title' })
})

test('read: not a craft finding — no marker, no [Severity] at the start, an unknown severity, no title', () => {
  assert.equal(readFindingComment('[High] t'), null)
  assert.equal(readFindingComment(`see [High] t\n${MARK}`), null)
  assert.equal(readFindingComment(`[Severe] t\n${MARK}`), null)
  assert.equal(readFindingComment(`[High] \n${MARK}`), null)
  assert.equal(readFindingComment(undefined), null)
  assert.equal(readFindingComment(null), null)
})

test('hiddenLine: the matched value trimmed; none, or only blanks, is no key', () => {
  assert.deepEqual(hiddenLine('lens', LENS_LINE, 'x\n<!-- craft-lens: tests  -->\ny'), { lens: 'tests' })
  assert.deepEqual(hiddenLine('lens', LENS_LINE, '<!-- craft-lens:    -->'), {})
  assert.deepEqual(hiddenLine('lens', LENS_LINE, 'nothing'), {})
})

test('question: the ask under the first line, the kind line before the marker; it reads back as a question', () => {
  const body = findingCommentBody({ severity: 'Medium', title: 'old readers', why: 'w', fix: 'f', source: 'compat' }, 'question')
  assert.equal(body, `[Medium] old readers\n\n${QUESTION_ASK}\n\nw — f\n\n<!-- craft-lens: compat -->\n<!-- craft-kind: question -->\n${MARK}`)
  assert.deepEqual(readFindingComment(body), { severity: 'Medium', title: 'old readers', lens: 'compat', kind: 'question' })
  assert.equal(findingCommentBody({ severity: 'Low', title: 't' }, 'defect'), findingCommentBody({ severity: 'Low', title: 't' }), 'a defect has no kind line')
  assert.ok(!('kind' in /** @type {object} */ (readFindingComment(findingCommentBody({ severity: 'Low', title: 't' })))))
})
