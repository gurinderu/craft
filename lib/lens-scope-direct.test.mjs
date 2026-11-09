// Direct unit tests of lib/lens-scope.mjs: the UTF-8 encoder held to the platform's.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { isShared, utf8Bytes } from './lens-scope.mjs'

test('utf8Bytes agrees with TextEncoder at every encoding boundary', () => {
  const enc = new TextEncoder()
  for (const cp of [0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000]) {
    const s = String.fromCodePoint(cp)
    assert.deepEqual(utf8Bytes(s), [...enc.encode(s)], cp.toString(16))
  }
  assert.deepEqual(utf8Bytes('\udfff'), [...enc.encode('\udfff')], 'a lone low surrogate is a replacement')
})

test('isShared: a manifest, a lockfile or a schema is shared, a source file is not', () => {
  for (const f of ['Cargo.lock', 'a/values.yaml', 'b.yml', 'Cargo.toml', 'x/schema.json']) assert.ok(isShared(f), f)
  for (const f of ['src/lib.rs', 'flake.nix', 'README.md']) assert.ok(!isShared(f), f)
})
