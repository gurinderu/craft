// Posting a doubtful finding the reviewer chose (lib/finding-post.mjs; realm @nick/craft, nodes #270, #271,
// #194): read by its number from the run record, the request carries the craft-finding marker, a question its
// kind line, a line outside the diff goes to the file, and the thread reader reads it back as the finding.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readArgs } from './finding-post.mjs'


const SHA = 'abc1234def'

test('args: the kind, the commit, the options and the number; anything else is the usage', () => {
  assert.deepEqual(readArgs(['--as', 'question', '--commit', SHA, '--record', 'r.json', '3']), { kind: 'question', commit: SHA, n: 3, opt: { as: 'question', commit: SHA, record: 'r.json' } })
  assert.match(String(readArgs(['--as', 'comment', '1'])), /^usage:/)
  assert.match(String(readArgs(['--as', 'defect'])), /^usage:/)
  assert.match(String(readArgs(['--as', 'defect', '0'])), /^usage:/)
  assert.match(String(readArgs(['--as', 'defect', 'l.json', '1'])), /^usage:/, 'no hand-copied list operand')
})
