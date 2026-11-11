// One manifest's checked candidates (lib/manifest-discover.mjs, realm @nick/craft, node #435): the parser its name
// calls for, and only candidates whose pattern reads back their own version.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { candidatesIn } from './manifest-discover.mjs'

test('a values file: versionFrom the file, scope its directory, one per system', () => {
  const text = 'image:\n  repository: ghcr.io/kubeovn/kube-ovn\n  tag: v1.12.3\nagain:\n  image: ghcr.io/kubeovn/kube-ovn:v1.12.4\n'
  assert.deepEqual(candidatesIn('charts/ovn/values.yaml', text), [
    {
      system: 'kube-ovn',
      repo: 'https://github.com/kubeovn/kube-ovn',
      repoGuessed: true,
      versionFrom: 'charts/ovn/values.yaml',
      versionMatch: '^[ \\t]*(?:-[ \\t]+)?image: ghcr\\.io/kubeovn/kube-ovn:([^"\'\\s#@]+)',
      version: 'v1.12.4',
      scope: 'charts/ovn',
      note: 'repo guessed from the image ghcr.io/kubeovn/kube-ovn',
    },
  ])
})

test('a candidate whose pattern would read another line first is dropped, not shown', () => {
  // Two identical anchors with different tags: the pair pattern of the second reads the first one's tag.
  const text = 'a:\n  repository: x/y\n  tag: v1\nb:\n  repository: x/y\n  tag: v2\n'
  assert.deepEqual(
    candidatesIn('values.yaml', text).map(c => c.version),
    ['v1'],
  )
})

test('a plain YAML file is read for images only when it is a Kubernetes manifest; an unknown file gives none', () => {
  assert.deepEqual(
    candidatesIn('k8s/d.yaml', 'apiVersion: v1\nkind: Pod\nspec:\n  containers:\n    - image: busybox:1.36\n').map(c => c.system),
    ['busybox'],
  )
  assert.deepEqual(candidatesIn('conf/app.yaml', 'image: busybox:1.36\n'), [])
  assert.deepEqual(candidatesIn('src/main.rs', 'image: busybox:1.36\n'), [])
})

test('an unusable repo is blanked, not the candidate dropped', () => {
  const tf = 'source = "git::https://h/../x.git?ref=v1"\n'
  assert.deepEqual(
    candidatesIn('main.tf', tf).map(c => [c.system, c.repo, c.repoGuessed]),
    [['x', '', false]],
  )
})

test('a flake.lock is no manifest: its locked github inputs give no candidate', () => {
  const lock = JSON.stringify(
    {
      nodes: {
        'flake-utils': { locked: { owner: 'numtide', repo: 'flake-utils', rev: 'a'.repeat(40), type: 'github' } },
        root: { inputs: { 'flake-utils': 'flake-utils' } },
      },
      root: 'root',
      version: 7,
    },
    null,
    2,
  )
  assert.deepEqual(candidatesIn('flake.lock', lock), [])
})
