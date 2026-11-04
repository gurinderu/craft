// The source agent's answers read as the run's state (lib/external-source-agent.mjs, realm @nick/craft, node #430):
// a nested run's prep taken only when it answers every record for the same spec.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { adoptedPrep } from './external-source-agent.mjs'

const OVN = { system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn', versionFrom: 'chart/values.yaml', versionMatch: 'tag: (\\S+)', scope: 'src' }
const DIR = '/home/u/.craft/sources/github.com/kubeovn/kube-ovn@v1.13.2'
const SPEC = { repo: OVN.repo, versionFrom: OVN.versionFrom, versionMatch: OVN.versionMatch }

test('a nested run\'s prep for another repo, versionFrom or versionMatch, or with no spec, is not taken', () => {
  for (const diff of [{ repo: 'https://github.com/fork/kube-ovn' }, { versionFrom: 'go.mod' }, { versionMatch: 'v(\\S+)' }, {}]) {
    const entry = { system: 'kube-ovn', ref: 'v1.13.2', dir: DIR, ...SPEC, ...diff }
    assert.equal(adoptedPrep(Object.keys(diff).length ? [entry] : [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }], [OVN]), null, `refused: ${JSON.stringify(diff)}`)
  }
  assert.equal(adoptedPrep([{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR, ...SPEC }], []), null, 'no record, nothing to take')
  assert.equal(adoptedPrep('x', [OVN]), null)
  assert.deepEqual(adoptedPrep([{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR, ...SPEC }], [OVN])?.prepared, [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }])
})

test('a nested run\'s prep of a stated version is taken only for that same version (node #440)', () => {
  const stated = { ...OVN, versionFrom: '', versionMatch: '', version: 'v1.13.2' }
  const entry = { system: 'kube-ovn', ref: 'v1.13.2', dir: DIR, repo: OVN.repo, version: 'v1.13.2' }
  assert.deepEqual(adoptedPrep([entry], [stated])?.prepared, [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }])
  assert.equal(adoptedPrep([{ ...entry, version: 'v1.14.0' }], [stated]), null, 'another stated version')
  assert.equal(adoptedPrep([{ ...entry, ...SPEC, version: undefined }], [stated]), null, 'read from a file, not stated')
  assert.equal(adoptedPrep([entry], [OVN]), null, 'stated, where the record reads a file')
})
