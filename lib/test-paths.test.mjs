import { test } from 'vitest'
import assert from 'node:assert/strict'
import { changesProductionCode, isTestPath } from './test-paths.mjs'

const RUST = ["'*.rs'"]

test('test trees and test-file conventions are test code', () => {
  for (const f of ['tests/it.rs', 'crates/a/tests/x.rs', 'src/__tests__/a.ts', 'Fixtures/a.rs', 'src/tests.rs', 'src/foo_test.rs', 'a/foo.test.ts', 'a/foo-spec.js', 'test_foo.py']) {
    assert.ok(isTestPath(f), f)
  }
})

test('production sources are not test code', () => {
  for (const f of ['src/lib.rs', 'src/testing.rs', 'src/latest.rs', 'src/contest/mod.rs', 'lib/attest.mjs']) {
    assert.ok(!isTestPath(f), f)
  }
})

test('a changed production source of the profile is a production change', () => {
  assert.ok(changesProductionCode(['README.md', 'src/lib.rs'], RUST))
  assert.ok(changesProductionCode(['tests/it.rs', 'src/lib.rs'], RUST))
})

test('test-only, docs-only and manifest-only diffs are not', () => {
  assert.ok(!changesProductionCode(['tests/it.rs', 'src/foo_test.rs'], RUST))
  assert.ok(!changesProductionCode(['README.md', 'docs/a.md'], RUST))
  assert.ok(!changesProductionCode(['Cargo.toml', 'Cargo.lock'], RUST))
  assert.ok(!changesProductionCode([], RUST))
})

test('a literal glob matches the basename exactly', () => {
  assert.ok(changesProductionCode(['flake.lock'], ["'*.nix'", "'flake.lock'"]))
  assert.ok(!changesProductionCode(['old.flake.lock'], ["'flake.lock'"]))
})
