// The checks and the spec shared by the engine and lib/craft-source.mjs (realm @nick/craft, nodes #430, #431).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { base64url, cacheSegments, encodeSpec, readRef, refFault, repoUrlParts, versionPattern } from './external-source-spec.mjs'

test('base64url matches Node\'s own, padding dropped, for every tail length and non-ASCII text', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'abcd', '{"system":"kube-ovn"}', 'ü → 𝄞 ~?/+']) {
    assert.equal(base64url(s), Buffer.from(s, 'utf8').toString('base64url'), s)
  }
})

test('the spec carries the four fields the CLI reads, and decodes back to them', () => {
  const rec = { system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn', versionFrom: 'go.mod', versionMatch: 'kube-ovn (v\\S+)', scope: 'src' }
  assert.deepEqual(JSON.parse(Buffer.from(encodeSpec([rec]), 'base64url').toString('utf8')), [{ system: 'kube-ovn', repo: rec.repo, versionFrom: 'go.mod', versionMatch: 'kube-ovn (v\\S+)' }])
})

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

test('the cache directory spells a / in the revision as ~ and keeps every segment filename-safe', () => {
  assert.deepEqual(cacheSegments({ host: 'github.com', path: 'k8s/api server' }, 'release/1.2'), ['github.com', 'k8s', 'api_server@release~1.2'])
})
