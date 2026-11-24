// A record put back from part of its parts keeps the verdict its run gave: only what did not run (`notRun`) makes it
// INCOMPLETE, never a coverage gap the binary files apart (`capped`, cli/crates/craft-review/src/report/gap_cap.rs).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { recordWithParts } from './record-parts-recover.mjs'

const GAP = 'general metrics-only lenses that never returned — complexity: died'
const SHORT = { recordInParts: { of: 2, seen: 1 } }

test('a capped Warning put back from its parts stays a Warning, its gap kept apart', () => {
  const base = { partialReason: 'checkpoints', notRun: [] }
  const got = { record: { verdict: 'Warning', notRun: [], capped: [GAP], ...SHORT }, complete: false, warning: '' }
  const merged = recordWithParts(base, [], got)
  assert.equal(merged['verdict'], 'Warning')
  assert.deepEqual(merged['notRun'], [])
  assert.deepEqual(merged['capped'], [GAP])
})

test('what did not run still makes it INCOMPLETE', () => {
  const got = { record: { verdict: 'Warning', notRun: ['errors: died'], ...SHORT }, complete: false, warning: '' }
  assert.equal(recordWithParts({ partialReason: 'p' }, [], got)['verdict'], 'Warning (INCOMPLETE)')
})
