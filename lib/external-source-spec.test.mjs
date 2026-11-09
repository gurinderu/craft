// The checks shared by the record reader and lib/external-revision.mjs (realm @nick/craft, nodes #430, #431).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readRef, refFault, repoUrlParts, versionPattern } from './external-source-spec.mjs'

test('repository URLs: https, ssh and scp forms give host and path; the rest is refused', () => {
  assert.deepEqual(repoUrlParts('https://GitHub.com/kubevirt/kubevirt.git'), { host: 'github.com', path: 'kubevirt/kubevirt' })
  assert.deepEqual(repoUrlParts('ssh://git@gitlab.example:2222/a/b'), { host: 'gitlab.example', path: 'a/b' })
  assert.deepEqual(repoUrlParts('git@github.com:kubeovn/kube-ovn.git'), { host: 'github.com', path: 'kubeovn/kube-ovn' })
  for (const bad of ['', '-u', 'https://h/a b', 'http://h/a', 'file:///x', 'https://user:pw@h/a', 'https://../a', 'https://h/a/../b', 'git@h:-x', 'ext::sh -c x']) {
    assert.ok('error' in repoUrlParts(bad), bad)
  }
})

test('revisions: tags, branches and commits pass; option-like, traversing and over-long ones do not', () => {
  for (const ok of ['v1.13.2', 'release/1.2', 'kubernetes-1.30.0', '0123456789abcdef0123456789abcdef01234567', 'v1+build']) assert.equal(refFault(ok), '', ok)
  for (const bad of ['', '-x', 'a..b', 'a//b', 'a/', 'x.lock', 'a b', 'a;b', '$(x)', 'v'.repeat(129)]) assert.notEqual(refFault(bad), '', bad)
})

test('the pattern must compile with exactly one group, and reads the revision from the file', () => {
  const p = versionPattern('^version: "?([^"\\s]+)')
  assert.ok('re' in p)
  assert.deepEqual(readRef(p.re, 'name: x\nversion: "v0.4.1"\n'), { ref: 'v0.4.1' })
  assert.deepEqual(readRef(p.re, 'none'), { error: 'versionMatch found no version in versionFrom' })
  assert.match(String(Object.values(versionPattern('(?<a>x)(y)'))[0]), /2 capture groups/)
  assert.ok('re' in versionPattern('(?:v)(\\d+)'), 'a non-capturing group does not count')
  assert.deepEqual(versionPattern(`(v)${'x'.repeat(198)}`), { error: 'versionMatch over 200 characters' })
  assert.ok('re' in versionPattern(`(v)${'x'.repeat(197)}`), '200 characters is within the cap')
})

