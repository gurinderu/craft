// Direct unit tests of integrations/shared/lens-scope.mjs: the UTF-8 encoder held to the platform's.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { utf8Bytes } from './lens-scope.mjs'

test('utf8Bytes agrees with TextEncoder at every encoding boundary', () => {
  const enc = new TextEncoder()
  for (const cp of [0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000]) {
    const s = String.fromCodePoint(cp)
    assert.deepEqual(utf8Bytes(s), [...enc.encode(s)], cp.toString(16))
  }
  assert.deepEqual(utf8Bytes('\udfff'), [...enc.encode('\udfff')], 'a lone low surrogate is a replacement')
})
