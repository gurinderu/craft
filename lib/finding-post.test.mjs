// Posting a doubtful finding the reviewer chose (lib/finding-post.mjs; realm @nick/craft, nodes #270, #271,
// #194): the request body carries the craft-finding marker, a question its kind line, and it is read back
// as the same finding by the thread reader.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFindingComment, FINDING_COMMENT_MARKER } from './finding-comment.mjs'
import { findingPostRequest, readArgs, run } from './finding-post.mjs'
import { doubtfulSection } from './finding-sort.mjs'

const SHA = 'abc1234def'
// The list exactly as the report section prints it.
const section = doubtfulSection([{ f: { severity: 'High', title: 'old replicas drop the field', why: 'w', fix: 'x', file: 'src/a.rs', line: 7, source: 'compat' }, reasons: ['raised by the compat lens'] }], '')
const LIST = JSON.parse(String(/```json\n(.*)\n```/.exec(section)?.[1]))

test('request: the finding as a question — anchored to its line, the marker last, read back with its kind', () => {
  const r = findingPostRequest(LIST, 1, 'question', SHA)
  assert.ok(typeof r === 'object')
  assert.deepEqual({ ...r, body: undefined }, { commit_id: SHA, path: 'src/a.rs', line: 7, side: 'RIGHT', body: undefined })
  assert.ok(r.body.endsWith(`<!-- craft-kind: question -->\n${FINDING_COMMENT_MARKER}`))
  assert.deepEqual(readFindingComment(r.body), { severity: 'High', title: 'old replicas drop the field', lens: 'compat', kind: 'question' })
})

test('request: as a defect it is the body the engine posts — no kind line', () => {
  const r = findingPostRequest(LIST[0], 1, 'defect', SHA)
  assert.ok(typeof r === 'object')
  assert.deepEqual(readFindingComment(r.body), { severity: 'High', title: 'old replicas drop the field', lens: 'compat' })
})

test('request: refused, named — a missing number, no file:line, a commit that is no sha', () => {
  assert.equal(findingPostRequest(LIST, 2, 'question', SHA), 'no finding numbered 2 in the list')
  assert.match(String(findingPostRequest([{ n: 1, file: 'a', line: 0 }], 1, 'defect', SHA)), /no file:line/)
  assert.match(String(findingPostRequest(LIST, 1, 'defect', 'HEAD')), /--commit must be the PR head sha/)
})

test('args: the kind, the commit, the list and the number; anything else is the usage', () => {
  assert.deepEqual(readArgs(['--as', 'question', '--commit', SHA, 'l.json', '3']), { kind: 'question', commit: SHA, src: 'l.json', n: 3 })
  assert.match(String(readArgs(['--as', 'comment', 'l.json', '1'])), /^usage:/)
  assert.match(String(readArgs(['--as', 'defect', 'l.json'])), /^usage:/)
  assert.match(String(readArgs(['--as', 'defect', 'l.json', '0'])), /^usage:/)
})

test('run: prints the request as one JSON line; an unreadable list or a refusal exits 2 with the reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-post-'))
  try {
    const file = path.join(dir, 'doubtful.json')
    fs.writeFileSync(file, JSON.stringify(LIST))
    const ok = await run(['--as', 'question', '--commit', SHA, file, '1'])
    assert.equal(ok.exitCode, 0)
    assert.equal(JSON.parse(String(ok.stdout[0])).path, 'src/a.rs')
    const missing = await run(['--as', 'question', '--commit', SHA, path.join(dir, 'none.json'), '1'])
    assert.equal(missing.exitCode, 2)
    assert.match(String(missing.stderr[0]), /cannot read/)
    const refused = await run(['--as', 'question', '--commit', SHA, file, '5'])
    assert.equal(refused.exitCode, 2)
    assert.match(String(refused.stderr[0]), /no finding numbered 5/)
    assert.equal((await run([])).exitCode, 2)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
