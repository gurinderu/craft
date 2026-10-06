import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkVersionStamps, filesRunRecord, versionStamp } from './workflow-version.mjs'

const stamped = "const CRAFT_VERSION = '1.2.3' // x-release-please-version\nawait logRun({ craftVersion: CRAFT_VERSION })\n"
const unstamped = "await logRun({ kind: 'workflow' })\n"
const pin = "return await workflow('review', { languages: ['rust'] })\n"

test('a record-filing workflow with a matching stamp passes', () => {
  const r = checkVersionStamps([{ name: 'a.js', src: stamped }], '1.2.3')
  assert.deepEqual(r.failures, [])
  assert.equal(r.oks.length, 1)
})

test('a record-filing workflow with NO stamp is a failure, not a silent skip', () => {
  const r = checkVersionStamps([{ name: 'a.js', src: unstamped }], '1.2.3')
  assert.equal(r.failures.length, 1)
  assert.match(/** @type {string} */ (r.failures[0]), /^a\.js :: files a run record but carries no CRAFT_VERSION stamp/)
  assert.deepEqual(r.skipped, [])
})

test('a drifted stamp is still a failure', () => {
  const r = checkVersionStamps([{ name: 'a.js', src: stamped }], '9.9.9')
  assert.equal(r.failures.length, 1)
  assert.match(/** @type {string} */ (r.failures[0]), /CRAFT_VERSION '1\.2\.3' != plugin\.json version '9\.9\.9'/)
})

test('a pin that files no record is skipped silently', () => {
  const r = checkVersionStamps([{ name: 'rust-review.js', src: pin }], '1.2.3')
  assert.deepEqual(r.failures, [])
  assert.deepEqual(r.oks, [])
  assert.deepEqual(r.skipped, ['rust-review.js'])
})

test('logRun detection ignores lookalikes and matches real calls', () => {
  assert.equal(filesRunRecord('await logRun({})'), true)
  assert.equal(filesRunRecord('async function logRun(record) {}'), true)
  assert.equal(filesRunRecord('obj.logRun(1)'), false)
  assert.equal(filesRunRecord('const notlogRun = 1'), false)
  assert.equal(versionStamp(pin), null)
})

test('logRun detection: a call at the very start of the source, or with a space before the paren, still files a record', () => {
  assert.equal(filesRunRecord('logRun({})'), true)
  assert.equal(filesRunRecord('x\nlogRun ({})'), true)
})

test('only a line-leading CRAFT_VERSION declaration is a stamp — a commented-out one is not', () => {
  assert.equal(versionStamp("// const CRAFT_VERSION = '1.2.3'"), null)
  assert.equal(versionStamp("x\nconst CRAFT_VERSION = '1.2.3'"), '1.2.3')
})

test('a stamped workflow that files no record is still held to the manifest, not skipped', () => {
  const stampOnly = "const CRAFT_VERSION = '1.2.3' // x-release-please-version\n"
  const r = checkVersionStamps([{ name: 'a.js', src: stampOnly }], '1.2.3')
  assert.deepEqual(r.skipped, [])
  assert.equal(r.oks.length, 1)
  assert.equal(checkVersionStamps([{ name: 'a.js', src: stampOnly }], '9.9.9').failures.length, 1)
})

// The real workflows: every one that files a record carries a stamp. This is the regression that
// matters — it fails if someone deletes a version line or adds a record-filing workflow without one.
test('every real record-filing workflow carries a stamp matching the manifest', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dir = path.join(root, 'workflows')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
  const r = checkVersionStamps(files.map(f => ({ name: f, src: fs.readFileSync(path.join(dir, f), 'utf8') })), manifest.version)
  assert.deepEqual(r.failures, [])
  assert.ok(r.oks.length >= 4, `expected at least 4 stamped workflows, got ${r.oks.length}`)
})
