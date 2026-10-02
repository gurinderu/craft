// Direct unit tests of lib/review-coverage.mjs: the edges the engine-level tests in
// review-coverage.test.mjs reach only through the inlined copy — the inert/ancillary classifiers by
// one representative each, resolveCoverage on untrusted shapes, the telemetry banner and the bounded
// ALREADY-FOUND block line by line.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  isInertUncovered, isAncillaryConfig, resolveCoverage, uncoveredNotRunNote, telemetryLostSection,
  canonicalSeverity, priorFoundSummary,
} from './review-coverage.mjs'

// No copy of the name tables here: they are module-level constants a mutant run ignores, and a copy
// would only have to be mirrored on every edit. One representative per kind carries the behaviour —
// the basename is matched, case-folded, under any directory.
test('an inert name, lockfile, extension or generated file is inert, under a directory and in any case', () => {
  for (const f of ['sub/LICENSE', 'sub/Cargo.LOCK', 'sub/A.JPEG', 'gen/a.snap']) assert.equal(isInertUncovered(f), true, f)
})

test('a name outside the inert tables stays material, even beside a lockfile-shaped word', () => {
  for (const f of ['sub/requirements.txt', 'src/lock.rs']) assert.equal(isInertUncovered(f), false, f)
})

test('the inert extension and generated-file patterns are anchored at the end of the path', () => {
  for (const f of ['src/a.md.rs', 'src/a.snap.rs', 'src/x.png.py']) assert.equal(isInertUncovered(f), false, f)
})

test('an ancillary config name is ancillary in any case, and a .dockerfile suffix only at the end', () => {
  for (const f of ['sub/Dockerfile', 'sub/api.dockerfile']) assert.equal(isAncillaryConfig(f), true, f)
  assert.equal(isAncillaryConfig('sub/x.dockerfile.sh'), false)
})

test('resolveCoverage reads a non-array change set or detection as none, and returns empty actives', () => {
  const profiles = { rust: { lang: 'Rust' } }
  assert.deepEqual(resolveCoverage({ profiles, changedFiles: undefined, detectedActive: [], pinnedLangs: null }), { outcome: 'empty', active: [], material: [] })
  assert.deepEqual(resolveCoverage({ profiles, changedFiles: ['a.rs'], detectedActive: 'rust', pinnedLangs: null }), { outcome: 'no-profile', active: [], material: ['a.rs'] })
  assert.deepEqual(resolveCoverage({ profiles, changedFiles: ['README.md'], detectedActive: null, pinnedLangs: null }), { outcome: 'nothing-to-review', active: [], material: [] })
})

test('uncoveredNotRunNote names up to five files and counts only the rest', () => {
  const five = ['a', 'b', 'c', 'd', 'e']
  assert.match(uncoveredNotRunNote(five), /^5 .*\(a, b, c, d, e\)$/)
  assert.match(uncoveredNotRunNote([...five, 'f']), /^6 .*\(a, b, c, d, e, \+1 more\)$/)
})

test('telemetryLostSection: nothing to say for absent or blank entries', () => {
  assert.equal(telemetryLostSection(undefined), '')
  assert.equal(telemetryLostSection([null, '  ', undefined]), '')
})

test('telemetryLostSection: one flattened, bounded line per entry, closed by a blank line', () => {
  const out = telemetryLostSection(['write failed:\r\nexit 1', 'x'.repeat(400)])
  const lines = out.split('\n')
  assert.match(/** @type {string} */ (lines[0]), /^## ⚠️ Telemetry lost$/)
  assert.match(/** @type {string} */ (lines[1]), /^2 record/, 'the head counts the unconfirmed entries')
  assert.deepEqual(lines.slice(2), ['- write failed: exit 1', `- ${'x'.repeat(300)}`, '', ''], 'a forged newline is flattened, a runaway line clamped, and the section closed')
})

test('telemetryLostSection: a landed record with a lost run directory is "incomplete", with its count', () => {
  const landed = 'the run directory (the record itself landed) could not be folded'
  assert.match(telemetryLostSection([landed]), /^## ⚠️ Telemetry incomplete\n.*\b1 run director/)
  assert.match(telemetryLostSection([landed, landed]), /^## ⚠️ Telemetry incomplete\n.*\b2 run director/)
  // The marker only counts when it LEADS the line: quoted inside another failure it is an unconfirmed write.
  assert.match(telemetryLostSection([`write failed: ${landed}`]), /^## ⚠️ Telemetry lost\n1 /)
})

test('canonicalSeverity maps every known severity to canonical case', () => {
  assert.deepEqual(['CRITICAL', 'high', 'Medium', ' low ', 'INFO'].map(canonicalSeverity), ['Critical', 'High', 'Medium', 'Low', 'Info'])
})

test('priorFoundSummary flattens and trims model text, and names what is missing', () => {
  const pool = [{ file: ' a.rs\r\nb ', line: 3, title: ' bad\r\nthing ', severity: 'High' }, { title: 't' }, null]
  assert.equal(priorFoundSummary(pool), 'a.rs b:3 bad thing\n?:0 t\n?:0')
})

test('priorFoundSummary clamps a title to titleMax and sorts around an absent entry wherever it sits', () => {
  assert.equal(priorFoundSummary([{ file: 'a', title: 'x'.repeat(130) }]), `a:0 ${'x'.repeat(120)}`)
  assert.equal(priorFoundSummary([null, { file: 'h', severity: 'High' }]), 'h:0\n?:0')
  assert.equal(priorFoundSummary([{ file: 'h', severity: 'High' }, null]), 'h:0\n?:0')
})

// Within a tier the input order holds because Array.prototype.sort is stable (ES2019); the explicit
// `|| (a.i - b.i)` tie-break restates that, so removing it is an equivalent mutant. This test pins the
// tier order, and it still kills a REVERSED tie-break (`b.i - a.i`).
test('priorFoundSummary orders by severity, unknown last, and never reorders within a tier', () => {
  const pool = [
    { file: 'u', severity: 'Bogus' }, { file: 'm1', severity: 'Medium' }, { file: 'h', severity: 'high' },
    { file: 'm2', severity: 'Medium' }, { file: 'm3', severity: 'Medium' }, { file: 'c', severity: 'Critical' },
  ]
  assert.equal(priorFoundSummary(pool), ['c:0', 'h:0', 'm1:0', 'm2:0', 'm3:0', 'u:0'].join('\n'))
})

test('priorFoundSummary keeps a line that fits the cap exactly, newline included', () => {
  const pool = [{ file: 'a', line: 1, title: 'x' }, { file: 'b', line: 1, title: 'y' }] // two 5-char lines
  assert.equal(priorFoundSummary(pool, { maxChars: 12 }), 'a:1 x\nb:1 y')
  const cut = priorFoundSummary(pool, { maxChars: 11 }).split('\n')
  assert.equal(cut[0], 'a:1 x')
  assert.equal(cut.length, 2)
  assert.notEqual(cut[1], 'b:1 y', 'one character short, the second line is withheld')
  assert.match(/** @type {string} */ (cut[1]), /\b1\b/, 'the overflow line counts the one withheld')
})
