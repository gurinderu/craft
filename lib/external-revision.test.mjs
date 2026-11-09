// The deployed revision of an external system (lib/external-revision.mjs, realm @nick/craft, nodes #431, #440): read
// from the consumer's file with its pattern, or the version the human stated, each held to the safe charset.
import { test, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { revisionOf } from './external-revision.mjs'

/** @type {string} */ let tmp
/** @type {string} */ let repo
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-revision-')))
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(path.join(repo, 'chart'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'chart', 'values.yaml'), 'kubeovn:\n  tag: v1.13.2\nkubevirt: 0123456789abcdef0123456789abcdef01234567\n')
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const OVN = { versionFrom: 'chart/values.yaml', versionMatch: 'tag: (\\S+)' }
const VIRT = { versionFrom: 'chart/values.yaml', versionMatch: '^kubevirt: ([0-9a-f]+)$' }

test('the revision is read from the file with its pattern: a tag, or a full commit', () => {
  assert.deepEqual(revisionOf(repo, OVN), { ref: 'v1.13.2' })
  assert.deepEqual(revisionOf(repo, VIRT), { ref: '0123456789abcdef0123456789abcdef01234567' })
})

test('a revision outside the safe charset is refused', () => {
  fs.writeFileSync(path.join(repo, 'chart', 'values.yaml'), 'tag: -v1;rm\n')
  const r = revisionOf(repo, OVN)
  assert.match('error' in r ? r.error : '', /revision outside/)
})

test('a symlinked version file that leads out of the repository is refused', () => {
  fs.writeFileSync(path.join(tmp, 'outside.yaml'), 'tag: v1\n')
  fs.symlinkSync(path.join(tmp, 'outside.yaml'), path.join(repo, 'chart', 'link.yaml'))
  assert.throws(() => revisionOf(repo, { ...OVN, versionFrom: 'chart/link.yaml' }), /versionFrom resolves outside the repository/)
})

test('a stated version (node #440) is taken as the ref with no file read; a bad one is refused', () => {
  fs.rmSync(path.join(repo, 'chart'), { recursive: true })
  assert.deepEqual(revisionOf(repo, { versionFrom: '', versionMatch: '', version: '1.12.3' }), { ref: '1.12.3' })
  assert.deepEqual(revisionOf(repo, { version: '-x;rm' }), { error: 'version: revision outside [A-Za-z0-9._+/-] or starting with a non-alphanumeric' })
})
