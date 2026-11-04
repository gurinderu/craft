// Container images in manifests (lib/manifest-images.mjs, realm @nick/craft, node #435).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { guessedRepo, imageLines, kustomizeImages, repositoryTagBlocks, splitImage } from './manifest-images.mjs'

/** @param {string} src @param {string} text */
const read = (src, text) => new RegExp(src, 'm').exec(text)?.[1]

test('an image reference splits into name and tag; no tag, a port only, or latest gives none', () => {
  assert.deepEqual(splitImage('reg:5000/a/b:v1@sha256:abc'), { name: 'reg:5000/a/b', tag: 'v1' })
  for (const ref of ['a/b', 'reg:5000/a/b', 'a/b:latest']) assert.equal(splitImage(ref), null, ref)
  assert.equal(guessedRepo('ghcr.io/kubeovn/kube-ovn/sub'), 'https://github.com/kubeovn/kube-ovn')
  assert.equal(guessedRepo('quay.io/a/b'), '')
})

test('image lines give a candidate each, reading their own tag; a ghcr image suggests its repo, marked guessed', () => {
  const text = 'services:\n  a:\n    image: ghcr.io/acme/app:v1.2.3\n  b:\n    image: "postgres:16"\n  c:\n    image: "{{ .Values.x }}"\n'
  const got = imageLines(text.split('\n'))
  assert.deepEqual(got.map(c => [c.system, c.repo, c.repoGuessed, c.version, read(c.versionMatch, text)]), [
    ['app', 'https://github.com/acme/app', true, 'v1.2.3', 'v1.2.3'],
    ['postgres', '', false, '16', '16'],
  ])
})

test('a values repository with a sibling tag (and registry) is an image; one without a tag is none', () => {
  const text = 'image:\n  registry: ghcr.io\n  repository: kubeovn/kube-ovn\n  tag: v1.12.3\nlone:\n  repository: a/b\n'
  const [c, ...rest] = repositoryTagBlocks(text.split('\n'))
  assert.equal(rest.length, 0)
  assert.deepEqual([c?.system, c?.repo, c?.version, read(String(c?.versionMatch), text)], ['kube-ovn', 'https://github.com/kubeovn/kube-ovn', 'v1.12.3', 'v1.12.3'])
})

test('a kustomization image entry with newTag is one, newName taken as the image when present', () => {
  const text = 'images:\n- name: nginx\n  newName: ghcr.io/acme/nginx-fork\n  newTag: v1.25.3\n- name: busybox\n- name: redis\n  newTag: "7.2"\n'
  const got = kustomizeImages(text.split('\n'))
  assert.deepEqual(got.map(c => [c.system, c.version, read(c.versionMatch, text)]), [['nginx-fork', 'v1.25.3', 'v1.25.3'], ['redis', '7.2', '7.2']])
})
