// Which files may be deployment manifests (lib/manifest-paths.mjs, realm @nick/craft, node #435), by name alone.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { manifestKind } from './manifest-paths.mjs'

test('the named manifests are told by their file name', () => {
  const kinds = Object.fromEntries(
    [
      'charts/a/Chart.yaml',
      'charts/a/values.yaml',
      'values-prod.yml',
      'k/kustomization.yaml',
      'k/Kustomization',
      'docker-compose.yml',
      'deploy/compose.prod.yaml',
      'infra/main.tf',
    ].map(f => [f, manifestKind(f)]),
  )
  assert.deepEqual(kinds, {
    'charts/a/Chart.yaml': 'chart',
    'charts/a/values.yaml': 'values',
    'values-prod.yml': 'values',
    'k/kustomization.yaml': 'kustomization',
    'k/Kustomization': 'kustomization',
    'docker-compose.yml': 'compose',
    'deploy/compose.prod.yaml': 'compose',
    'infra/main.tf': 'terraform',
  })
})

test('another YAML file may be a plain Kubernetes manifest, unless under a dot directory or templates/, or a lockfile; a library lockfile or a flake.lock is none', () => {
  assert.equal(manifestKind('k8s/deployment.yaml'), 'k8s')
  for (const f of [
    '.github/workflows/ci.yml',
    'charts/a/templates/deploy.yaml',
    'pnpm-lock.yaml',
    'Cargo.lock',
    'go.sum',
    'package-lock.json',
    'flake.lock',
    'nix/flake.lock',
    'src/main.rs',
    'README.md',
  ])
    assert.equal(manifestKind(f), '', f)
})
