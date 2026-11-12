// A candidate external record (lib/external-candidate.mjs, realm @nick/craft, node #434): its checks, whether a
// record covers it, how a relayed list is read, and its report line.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { checkCandidate, coveredBy } from './external-candidate.mjs'

const C = {
  system: 'kube-ovn',
  repo: 'https://github.com/kubeovn/kube-ovn',
  repoGuessed: true,
  versionFrom: 'charts/values.yaml',
  versionMatch: 'tag: (\\S+)',
  version: 'v1.12.3',
  scope: 'charts',
}

test('a candidate passes only with every field sound', () => {
  assert.deepEqual(checkCandidate(C), C)
  const bad = [
    { system: 'a b' },
    { repo: 'ftp://x/y' },
    { repo: 'git@github.com:a/b' },
    { versionMatch: '(a)(b)' },
    { versionMatch: 'a`(b)' },
    { version: '-x' },
    { scope: '../x' },
    { scope: '/etc' },
    { versionFrom: 'x;rm' },
    { versionFrom: 'a/../../b' },
  ]
  for (const b of bad) assert.equal(checkCandidate({ ...C, ...b }), null, JSON.stringify(b))
  assert.equal(checkCandidate(C, ['other.yaml']), null, 'a versionFrom outside the files asked for')
  assert.deepEqual(checkCandidate({ ...C, repo: '', note: 'a b`c' }), { ...C, repo: '', repoGuessed: false, note: 'a b c' })
})

test('a record covers a candidate by its repository, or by versionFrom and system', () => {
  assert.ok(coveredBy(C, [{ system: 'other', repo: 'https://GitHub.com/kubeovn/kube-ovn.git', versionFrom: 'x' }]))
  assert.ok(coveredBy(C, [{ system: 'Kube-OVN', repo: 'https://github.com/x/y', versionFrom: 'charts/values.yaml' }]))
  assert.ok(!coveredBy(C, [{ system: 'kube-ovn', repo: 'https://github.com/x/y', versionFrom: 'other.yaml' }]))
  assert.ok(!coveredBy({ ...C, repo: '' }, [{ system: 'x', repo: '', versionFrom: 'charts/values.yaml' }]))
  assert.ok(
    coveredBy({ ...C, repo: '' }, [{ system: 'kube-ovn', repo: 'https://github.com/x/y', versionFrom: '', version: 'v1.16.10' }]),
    'a stated version covers its system (node #440)',
  )
  assert.ok(!coveredBy({ ...C, repo: '' }, [{ system: 'other', repo: '', versionFrom: '', version: 'v1' }]))
})
