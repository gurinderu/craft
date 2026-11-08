// The memory verb of lib/craft-externals.mjs (lib/craft-externals-memory.mjs, realm @nick/craft, node #470): each
// usable `external` record a candidate with the revision read from its file or stated, every other one refused by
// name, and a malformed invocation refused — in a temporary repository.
import { test, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryExternals, memoryRecords } from './craft-externals-memory.mjs'
import { run } from './craft-externals.mjs'

/** @type {string} */ let repo
beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-externals-memory-')))
  fs.mkdirSync(path.join(repo, 'deploy'))
  fs.writeFileSync(path.join(repo, 'deploy/values.yaml'), 'kubeovn:\n  tag: v1.13.2\n')
})
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

const RECORDS = [
  { kind: 'external', system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn.git', versionFrom: 'deploy/values.yaml', versionMatch: 'tag: (\\S+)', scope: 'pkg/net', status: 'active' },
  { kind: 'external', system: 'linstor', repo: 'git@github.com:LINBIT/linstor-server.git', version: 'v1.29.0', scope: '.' },
  { kind: 'external', system: 'gone', repo: 'https://h/a.git', version: 'v1', status: 'withdrawn' },
  { kind: 'external', system: 'nofile', repo: 'https://h/b.git', versionFrom: 'missing.yaml', versionMatch: 'v: (\\S+)' },
  { kind: 'decision', title: 'not an external record' },
]

/** @param {string} stdin @param {string[]} [argv] */
const go = (stdin, argv = ['memory', '--repo-root', repo]) => memoryExternals(argv, { stdin: () => stdin })

test('each usable record is a candidate with its revision read; the rest are refused by name', () => {
  const r = go(JSON.stringify({ externals: RECORDS }))
  assert.equal(r.exitCode, 0)
  assert.deepEqual(r.answer.candidates, [
    { system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn.git', ref: 'v1.13.2', scope: 'pkg/net', versionFrom: 'deploy/values.yaml', versionMatch: 'tag: (\\S+)' },
    { system: 'linstor', repo: 'git@github.com:LINBIT/linstor-server.git', ref: 'v1.29.0', scope: '.', version: 'v1.29.0' },
  ])
  const refused = r.answer.refused ?? []
  assert.equal(refused.length, 2, refused.join('\n'))
  assert.match(refused[0] ?? '', /^external record #2 \(gone\): status withdrawn$/)
  assert.match(refused[1] ?? '', /^external record nofile: /)
})

test('a list of records of another kind gives nothing, and a malformed call or stdin is refused', () => {
  assert.deepEqual(memoryRecords(JSON.stringify([{ kind: 'rule' }])), [])
  assert.equal(memoryRecords('not json'), null)
  assert.equal(go('{"x": 1}').exitCode, 1)
  assert.equal(go('[]', ['memory', '--repo-root', 'relative']).exitCode, 1)
  assert.equal(go('[]', ['memory']).exitCode, 1)
  assert.deepEqual(go('[]').answer, { candidates: [], refused: [] })
})

test('the CLI dispatches the memory verb', async () => {
  const r = await run(['memory', '--repo-root', 'relative'])
  assert.equal(r.exitCode, 1)
  assert.match(r.stdout[0] ?? '', /not an absolute path/)
})
