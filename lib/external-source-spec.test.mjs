// The checks and the spec shared by the engine and lib/craft-source.mjs (realm @nick/craft, nodes #430, #431).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { base64url, cacheSegments, encodeSpec, externalRecords, readRef, refFault, repoUrlParts, versionPattern, EXTERNALS_MAX } from './external-source-spec.mjs'

test('base64url matches Node\'s own, padding dropped, for every tail length and non-ASCII text', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'abcd', '{"system":"kube-ovn"}', 'ü → 𝄞 ~?/+']) {
    assert.equal(base64url(s), Buffer.from(s, 'utf8').toString('base64url'), s)
  }
})

test('the spec carries the four fields the CLI reads, and decodes back to them', () => {
  const rec = { system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn', versionFrom: 'go.mod', versionMatch: 'kube-ovn (v\\S+)', scope: 'src' }
  assert.deepEqual(JSON.parse(Buffer.from(encodeSpec([rec]), 'base64url').toString('utf8')), [{ system: 'kube-ovn', repo: rec.repo, versionFrom: 'go.mod', versionMatch: 'kube-ovn (v\\S+)' }])
})

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
})

test('the cache directory spells a / in the revision as ~ and keeps every segment filename-safe', () => {
  assert.deepEqual(cacheSegments({ host: 'github.com', path: 'k8s/api server' }, 'release/1.2'), ['github.com', 'k8s', 'api_server@release~1.2'])
})
