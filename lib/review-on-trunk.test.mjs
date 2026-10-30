// A review launched on the trunk itself, with no base: the default base is the merge base of HEAD and
// the trunk, which IS HEAD, so the diff is empty by construction. The run says so and how to re-run,
// and its record keeps the base it resolved (realm @nick/craft, node #251).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
import { baseIsHead, onTrunkMessage, noChangedFilesMessage } from './review-coverage.mjs'

const SHA = '9df209b95b0a06fb4fd79e9d135c11d751306e5a'

test('base is head: the merge base equal to HEAD, by full or short sha; a named ref or an empty side is not', () => {
  assert.equal(baseIsHead(SHA, '9df209b'), true)
  assert.equal(baseIsHead(SHA.toUpperCase(), SHA), true)
  assert.equal(baseIsHead('537e5aae69693d174e0d22d309472f396d3d15f8', '9df209b'), false)
  assert.equal(baseIsHead('origin/main', '9df209b'), false)
  assert.equal(baseIsHead('', '9df209b'), false)
  assert.equal(baseIsHead(SHA, ''), false)
  assert.equal(baseIsHead(SHA, '9df2'), false, 'a prefix too short to name a commit')
})

test('on-trunk message: names the cause and both ways to re-run; stable across runs', () => {
  const msg = onTrunkMessage()
  assert.match(msg, /NOTHING WAS REVIEWED/)
  assert.match(msg, /HEAD IS the resolved base/)
  assert.match(msg, /worktree/)
  assert.match(msg, /`base`/)
  assert.match(msg, /not an approval/i)
  assert.notEqual(msg, noChangedFilesMessage())
})

/** @param {string} baseRef @param {string} branch @param {{ head?: string, baseIsHead?: boolean, args?: Record<string, unknown> }} [o] */
const run = (baseRef, branch, { head = '9df209b', baseIsHead: same, args = {} } = {}) => runEngine('review', {
  args,
  script: { detect: { baseRef, files: [], spec: '', branch, head, ...(same === undefined ? {} : { baseIsHead: same }), notes: '' }, 'log-run': { ok: true, output: ['wrote r.json'] }, '*': null },
})

test('review on the trunk: the report and the record name the trunk, the record keeps the base', async () => {
  const r = await run(SHA, 'main')
  assert.match(r.report, /INCOMPLETE — NOTHING WAS REVIEWED — HEAD IS the resolved base/)
  assert.match(r.report, /HEAD 9df209b on `main` is the base itself/)
  const logged = r.calls.filter(c => c.label === 'log-run').map(c => c.prompt).join('\n')
  assert.match(logged, new RegExp(`"base": "${SHA}"`))
  assert.match(logged, /"verdict": "INCOMPLETE \(empty diff\)"/)
  assert.match(logged, /HEAD IS the resolved base/)
})

test('review off the trunk with an empty diff keeps the general message', async () => {
  const r = await run('537e5aae69693d174e0d22d309472f396d3d15f8', 'feat/x')
  assert.match(r.report, /the diff came back EMPTY/)
  assert.doesNotMatch(r.report, /HEAD IS the resolved base/)
})

test('review on the trunk: the agent\'s baseIsHead decides even when it left head empty and named the base by ref', async () => {
  const r = await run('origin/main', 'main', { head: '', baseIsHead: true })
  assert.match(r.report, /HEAD IS the resolved base/)
})

test('an explicit base equal to HEAD is the caller\'s choice: the general message, not the trunk one', async () => {
  const r = await run(SHA, 'main', { baseIsHead: true, args: { base: SHA } })
  assert.match(r.report, /the diff came back EMPTY/)
  assert.doesNotMatch(r.report, /HEAD IS the resolved base/)
})

test('the detect prompt asks for baseIsHead as a required answer, not a fallback', async () => {
  const r = await run(SHA, 'main')
  const detect = r.calls.find(c => c.label === 'detect')
  assert.match(String(detect?.prompt), /baseIsHead[\s\S]*NOT a fallback/)
})
