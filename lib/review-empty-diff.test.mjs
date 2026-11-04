// The report of an empty diff (lib/review-empty-diff.mjs): a launch on the trunk itself names the head as the base;
// an explicit base equal to HEAD is the caller's choice (realm @nick/craft, node #251).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { emptyDiffReport } from './review-empty-diff.mjs'
import { noChangedFilesMessage, onTrunkMessage } from './review-coverage.mjs'

const AT = { baseArg: '', detected: /** @type {any} */ ({}), baseRef: '', head: '', branch: '' }

test('the agent\'s own comparison marks a launch on the trunk, a detached head named without a branch', () => {
  assert.deepEqual(emptyDiffReport({ ...AT, detected: { ...AT.detected, baseIsHead: true }, head: 'f00' }), { msg: onTrunkMessage(), detectedLine: 'HEAD f00 is the base itself (): 0 changed file(s)' })
})

test('an explicit base equal to HEAD is no launch on the trunk', () => {
  assert.equal(emptyDiffReport({ ...AT, baseArg: 'abc1234', baseRef: 'abc1234', head: 'abc1234' }).msg, noChangedFilesMessage(), 'an explicit base equal to HEAD is the caller\'s choice')
})
