// Direct unit tests of lib/review-coverage.mjs: the edges the engine-level tests in
// review-coverage.test.mjs reach only through the inlined copy — the inert/ancillary name tables
// entry by entry, resolveCoverage on untrusted shapes, the telemetry banner and the bounded
// ALREADY-FOUND block line by line.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  isInertUncovered, isAncillaryConfig, resolveCoverage, uncoveredNotRunNote, telemetryLostSection,
  canonicalSeverity, priorFoundSummary,
} from './review-coverage.mjs'

const INERT = [
  'license', 'licence', 'notice', 'codeowners', '.gitignore', '.gitattributes',
  'license.txt', 'licence.txt', 'notice.txt', 'copying.txt', 'authors.txt', 'contributors.txt',
  'changelog.txt', 'changes.txt', 'readme.txt', 'robots.txt', 'humans.txt', 'todo.txt', 'notes.txt',
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'cargo.lock', 'flake.lock', 'poetry.lock', 'pdm.lock', 'uv.lock', 'pipfile.lock', 'gemfile.lock',
  'composer.lock', 'go.sum', 'deno.lock', 'mix.lock', 'pubspec.lock', 'podfile.lock', 'packages.lock.json',
  'gradle.lockfile', 'cabal.project.freeze', 'conan.lock', 'herd.lock',
  'a.jpg', 'a.jpeg', 'a.woff', 'a.woff2', 'gen/a.snap',
]

const ANCILLARY = [
  'dockerfile', 'containerfile', 'justfile', 'makefile', 'gnumakefile', 'procfile', 'vagrantfile',
  'deny.toml', 'rustfmt.toml', 'clippy.toml', 'rust-toolchain.toml', 'rust-toolchain',
  '.editorconfig', '.dockerignore', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc',
  'codecov.yml', 'renovate.json', 'dependabot.yml', '.pre-commit-config.yaml', 'api.dockerfile',
]

test('every inert name, lockfile and extension is inert, under a directory and in any case', () => {
  for (const name of INERT) assert.equal(isInertUncovered(`sub/${name.toUpperCase()}`), true, name)
})

test('the inert extension and generated-file patterns are anchored at the end of the path', () => {
  for (const f of ['src/a.md.rs', 'src/a.snap.rs', 'src/x.png.py']) assert.equal(isInertUncovered(f), false, f)
})

test('every ancillary config name is ancillary, and a .dockerfile suffix only at the end', () => {
  for (const name of ANCILLARY) assert.equal(isAncillaryConfig(`sub/${name}`), true, name)
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

test('priorFoundSummary orders by severity, unknown last, and keeps the input order within a tier', () => {
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
