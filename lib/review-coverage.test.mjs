// The telemetry section of a review's report (lib/review-coverage.mjs, telemetryLostSection): a run must never claim
// its record landed when it did not, nor cry "lost" over a record sitting on disk.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { telemetryLostSection } from './review-coverage.mjs'

test('a landed record is not counted as one that could not be confirmed', () => {
  // A banner that cries "lost" over a record sitting on disk is a banner readers learn to skip —
  // which costs the runs where it means what it says. Both facts stay in one section; the heading
  // and the count follow whichever is true.
  //
  // This one is NOT superseded by the executed engine tests, and the distinction is the whole reason
  // it survives here: those script ONE condition per run, so they cover lost-only and degraded-only.
  // The third block below is the MIXED axis — a lost record and a refused directory in the same run —
  // and it is the axis where the classifier can invert. Losing it let `unconfirmed` be zeroed
  // whenever any line was landed, so a run whose record was lost rendered a serene
  // "Telemetry incomplete — the record is in the store", with every gate green.
  const degraded = telemetryLostSection(['the run directory (the record itself landed) — refused'])
  assert.match(degraded, /## ⚠️ Telemetry incomplete/)
  assert.ok(!/could not be confirmed/.test(degraded), 'a landed record must not read as unconfirmed')
  assert.match(degraded, /record is in the store/)

  const lost = telemetryLostSection(['the run record — the logger agent returned no result'])
  assert.match(lost, /## ⚠️ Telemetry lost/)
  assert.match(lost, /^1 record write/m, 'a genuinely lost record still says so')

  const both = telemetryLostSection(['the run record — gone', 'the run directory (the record itself landed) — refused'])
  assert.match(both, /## ⚠️ Telemetry lost/, 'a real loss in the mix keeps the louder heading')
  assert.match(both, /^1 record write/m, 'but only the unconfirmed ones are counted as unconfirmed')
  assert.ok(both.includes('- the run directory (the record itself landed) — refused'), 'and both lines are still listed')
})
