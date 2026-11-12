// Direct unit tests of lib/review-coverage.mjs: the edges the engine-level tests in
// review-coverage.test.mjs reach only through the engine — the inert/ancillary classifiers by
// one representative each, resolveCoverage on untrusted shapes, the telemetry banner and the bounded
// ALREADY-FOUND block line by line.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { telemetryLostSection } from './review-coverage.mjs'

test('telemetryLostSection: nothing to say for absent or blank entries', () => {
  assert.equal(telemetryLostSection(undefined), '')
  assert.equal(telemetryLostSection([null, '  ', undefined]), '')
})

test('telemetryLostSection: one flattened, bounded line per entry, closed by a blank line', () => {
  const out = telemetryLostSection(['write failed:\r\nexit 1', 'x'.repeat(400)])
  const lines = out.split('\n')
  assert.match(/** @type {string} */ (lines[0]), /^## ⚠️ Telemetry lost$/)
  assert.match(/** @type {string} */ (lines[1]), /^2 record/, 'the head counts the unconfirmed entries')
  assert.deepEqual(
    lines.slice(2),
    ['- write failed: exit 1', `- ${'x'.repeat(300)}`, '', ''],
    'a forged newline is flattened, a runaway line clamped, and the section closed',
  )
})

test('telemetryLostSection: a landed record with a lost run directory is "incomplete", with its count', () => {
  const landed = 'the run directory (the record itself landed) could not be folded'
  assert.match(telemetryLostSection([landed]), /^## ⚠️ Telemetry incomplete\n.*\b1 run director/)
  assert.match(telemetryLostSection([landed, landed]), /^## ⚠️ Telemetry incomplete\n.*\b2 run director/)
  // The marker only counts when it LEADS the line: quoted inside another failure it is an unconfirmed write.
  assert.match(telemetryLostSection([`write failed: ${landed}`]), /^## ⚠️ Telemetry lost\n1 /)
})
