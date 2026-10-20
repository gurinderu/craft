// Posting a doubtful finding the reviewer chose (lib/finding-post.mjs; realm @nick/craft, nodes #270, #271,
// #194): read by its number from the run record, the request carries the craft-finding marker, a question its
// kind line, a line outside the diff goes to the file, and the thread reader reads it back as the finding.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFindingComment, FINDING_COMMENT_MARKER } from './finding-comment.mjs'
import { findingPostRequest, readArgs, run } from './finding-post.mjs'
import { postable } from './finding-sort.mjs'

const SHA = 'abc1234def'
const F = { severity: 'High', title: 'old replicas drop the field', why: 'w', fix: 'x', file: 'src/a.rs', line: 7, source: 'compat' }
// The findings exactly as the engine keeps them in the run record.
const FINDINGS = [postable(F, 0, ['raised by the compat lens']), postable({ ...F, title: 'pre-existing leak', line: 90 }, 1, ['its line is outside the lines the diff changed'])]

test('request: a question on the finding line — subject line, side RIGHT, the marker last, read back with its kind', () => {
  const r = findingPostRequest(FINDINGS, 1, 'question', SHA)
  assert.ok(typeof r === 'object')
  assert.deepEqual({ ...r, body: undefined }, { commit_id: SHA, path: 'src/a.rs', subject_type: 'line', line: 7, side: 'RIGHT', body: undefined })
  assert.ok(r.body.endsWith(`<!-- craft-kind: question -->\n${FINDING_COMMENT_MARKER}`))
  assert.deepEqual(readFindingComment(r.body), { severity: 'High', title: 'old replicas drop the field', lens: 'compat', kind: 'question' })
})

test('request: a line outside the diff becomes a file-level comment with the same marker; a defect has no kind line', () => {
  const r = findingPostRequest(FINDINGS, 2, 'defect', SHA)
  assert.ok(typeof r === 'object')
  assert.deepEqual({ ...r, body: undefined }, { commit_id: SHA, path: 'src/a.rs', subject_type: 'file', body: undefined })
  assert.deepEqual(readFindingComment(r.body), { severity: 'High', title: 'pre-existing leak', lens: 'compat' })
  assert.equal(/** @type {any} */ (findingPostRequest([{ ...postable(F, 0, []), line: 0 }], 1, 'defect', SHA)).subject_type, 'file', 'no line — the file')
  assert.equal(/** @type {any} */ (findingPostRequest(FINDINGS, 1, 'question', SHA, false)).subject_type, 'file', 'lines not judged — the file')
})

test('request: refused, named — a missing number, no file, a commit that is no sha', () => {
  assert.equal(findingPostRequest(FINDINGS, 3, 'question', SHA), 'the run record lists no doubtful finding numbered 3')
  assert.match(String(findingPostRequest([{ n: 1, title: 't', file: '', line: 1 }], 1, 'defect', SHA)), /names no file/)
  assert.match(String(findingPostRequest(FINDINGS, 1, 'defect', 'HEAD')), /--commit must be the PR head sha/)
})

test('args: the kind, the commit, the options and the number; anything else is the usage', () => {
  assert.deepEqual(readArgs(['--as', 'question', '--commit', SHA, '--record', 'r.json', '3']), { kind: 'question', commit: SHA, n: 3, opt: { as: 'question', commit: SHA, record: 'r.json' } })
  assert.match(String(readArgs(['--as', 'comment', '1'])), /^usage:/)
  assert.match(String(readArgs(['--as', 'defect'])), /^usage:/)
  assert.match(String(readArgs(['--as', 'defect', '0'])), /^usage:/)
  assert.match(String(readArgs(['--as', 'defect', 'l.json', '1'])), /^usage:/, 'no hand-copied list operand')
})

test('run: reads the finding from the named run record or the newest of the store; a missing one exits 2 with the reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-post-'))
  try {
    const record = path.join(dir, 'rec.json')
    fs.writeFileSync(record, JSON.stringify({ kind: 'workflow', name: 'review', sorting: { defect: 0, doubtful: 2, findings: FINDINGS } }))
    const ok = await run(['--as', 'question', '--commit', SHA, '--record', record, '1'])
    assert.equal(ok.exitCode, 0, ok.stderr.join('\n'))
    assert.equal(JSON.parse(String(ok.stdout[0])).path, 'src/a.rs')
    const store = path.join(dir, 'store')
    fs.mkdirSync(store)
    fs.writeFileSync(path.join(store, '20261020-100000-workflow-review.json'), JSON.stringify({ project: fs.realpathSync(dir), sorting: { findings: FINDINGS } }))
    const found = await run(['--as', 'defect', '--commit', SHA, '--store', store, '--project', dir, '2'])
    assert.equal(found.exitCode, 0, found.stderr.join('\n'))
    assert.equal(JSON.parse(String(found.stdout[0])).subject_type, 'file')
    const unjudged = path.join(dir, 'unjudged.json')
    fs.writeFileSync(unjudged, JSON.stringify({ sorting: { inDiffJudged: false, findings: FINDINGS } }))
    const toFile = await run(['--as', 'question', '--commit', SHA, '--record', unjudged, '1'])
    assert.equal(JSON.parse(String(toFile.stdout[0])).subject_type, 'file', 'a record whose lines were not judged posts to the file')
    const missing = await run(['--as', 'question', '--commit', SHA, '--record', path.join(dir, 'none.json'), '1'])
    assert.equal(missing.exitCode, 2)
    const refused = await run(['--as', 'question', '--commit', SHA, '--record', record, '5'])
    assert.match(String(refused.stderr[0]), /no doubtful finding numbered 5/)
    assert.equal((await run([])).exitCode, 2)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
