// Which finished verdicts say a run's work was cut short (lib/cli-review-verdict.mjs, cutShort).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { cutShort } from './cli-review-verdict.mjs'

test('INCOMPLETE anywhere in the verdict is a run cut short, but not one that ended on nothing to review', () => {
  assert.deepEqual(['INCOMPLETE', 'Warning (INCOMPLETE)', 'Block (INCOMPLETE)'].map(cutShort), [true, true, true])
  assert.deepEqual(['INCOMPLETE (empty diff)', 'INCOMPLETE (no language profile)', 'Approve', 'Block', 'Approve (nothing to review)'].map(cutShort), [false, false, false, false, false])
})
