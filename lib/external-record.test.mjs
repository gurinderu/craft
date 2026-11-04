// The external records a review can use (lib/external-record.mjs, realm @nick/craft, nodes #431, #440).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { externalRecords } from './external-record.mjs'
import { encodeSpec, EXTERNALS_MAX } from './external-source-spec.mjs'

test('records are kept one per system, well-formed and active, and every other one is named with why', () => {
  const ok = { system: 'kube-ovn', repo: 'r', versionFrom: 'f', versionMatch: 'm', scope: 's' }
  const { records, refused } = externalRecords([ok, { ...ok }, { ...ok, system: 'x', status: 'withdrawn' }, { ...ok, system: 'has space' }, { ...ok, system: 'y', repo: '' }, 'junk'])
  assert.deepEqual(records, [ok])
  assert.deepEqual(refused, [
    'external record #1 (kube-ovn): a second record of the same system',
    'external record #2 (x): status withdrawn',
    'external record #3: no system name of letters, digits, `.`, `_` or `-`',
    'external record #4 (y): repo missing or over 300 characters',
    'external record #5: no system name of letters, digits, `.`, `_` or `-`',
  ])
  const many = Array.from({ length: EXTERNALS_MAX + 1 }, (_, i) => ({ ...ok, system: `s${i}` }))
  assert.equal(externalRecords(many).records.length, EXTERNALS_MAX)
  assert.deepEqual(externalRecords(undefined), { records: [], refused: [] })
})

test('a record may carry a stated version in place of versionFrom and versionMatch, never both (node #440)', () => {
  const stated = { system: 'kube-ovn', repo: 'r', version: 'v1.16.10', scope: 's' }
  const { records, refused } = externalRecords([stated, { ...stated, system: 'x', versionFrom: 'f', versionMatch: 'm' }, { ...stated, system: 'y', version: '' }])
  assert.deepEqual(records, [{ ...stated, versionFrom: '', versionMatch: '' }])
  assert.deepEqual(refused, ['external record #1 (x): both a stated version and versionFrom or versionMatch', 'external record #2 (y): versionFrom missing or over 300 characters'])
  assert.deepEqual(JSON.parse(Buffer.from(encodeSpec(records), 'base64url').toString('utf8')), [{ system: 'kube-ovn', repo: 'r', version: 'v1.16.10' }])
})
