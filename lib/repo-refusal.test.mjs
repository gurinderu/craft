// repoRefusal (lib/run-record.mjs): the record and the report of an engine refusing `repo`.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { repoRefusal } from './run-record.mjs'

test('repoRefusal: a top-level refusal records no parent and names the engine', () => {
  const { record, report } = repoRefusal({ engine: 'rust-audit', repo: '/x/y', craftVersion: '1.2.3', outputTokens: 7 })
  assert.equal(record.name, 'rust-audit')
  assert.equal(record.craftVersion, '1.2.3')
  assert.equal(record.outputTokens, 7)
  assert.equal(record.nested, false)
  assert.equal(record.via, null)
  assert.equal(record.verdict, 'INCOMPLETE (repo not supported)')
  assert.deepEqual(record.findings, { total: 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 } })
  assert.match(report, /^## Verdict\n⚠️ INCOMPLETE — `repo=\/x\/y` was given, but `rust-audit` does not support/)
  assert.match(report, /run `rust-audit` there\.$/)
})

test('repoRefusal: a nested refusal records its parent', () => {
  const { record } = repoRefusal({ engine: 'adversarial-review', repo: '/x', craftVersion: '1', outputTokens: 0, via: 'rust-audit' })
  assert.equal(record.nested, true)
  assert.equal(record.via, 'rust-audit')
})

test('repoRefusal: notRun carries the class, never the caller\'s path', () => {
  const { record } = repoRefusal({ engine: 'triage-findings', repo: '/secret/path', craftVersion: '1', outputTokens: 0 })
  assert.deepEqual(record.notRun, ['`repo` argument refused — this engine reviews only the session\'s own checkout'])
})
