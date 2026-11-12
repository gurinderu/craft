import { test } from 'vitest'
import assert from 'node:assert/strict'
import { shrinkwrapOf } from './opencode-shrinkwrap.mjs'

const lock = (/** @type {Record<string, string>} */ deps) =>
  JSON.stringify({
    name: 'p',
    version: '0.1.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'p', version: '0.1.0', dependencies: deps, devDependencies: { t: '1.0.0' } },
      'node_modules/a': { version: '1.0.0', integrity: 'sha512-a' },
      'node_modules/t': { version: '1.0.0', dev: true },
      'node_modules/o': { version: '2.0.0', optional: true },
    },
  })

test('the shrinkwrap keeps the production entries as locked and re-roots at the package', () => {
  const wrap = shrinkwrapOf(lock({ a: '1.0.0' }), 'pkg', '9.9.9', { a: '1.0.0' })
  assert.deepEqual(wrap, {
    name: 'pkg',
    version: '9.9.9',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'pkg', version: '9.9.9', license: 'MIT', dependencies: { a: '1.0.0' } },
      'node_modules/a': { version: '1.0.0', integrity: 'sha512-a' },
      'node_modules/o': { version: '2.0.0', optional: true },
    },
  })
})

test('a lockfile locked for other dependencies, or of another version, is refused', () => {
  assert.throws(() => shrinkwrapOf(lock({ a: '1.0.0' }), 'pkg', '1.0.0', { a: '2.0.0' }), /locks \{"a":"1\.0\.0"\}/)
  assert.throws(() => shrinkwrapOf(JSON.stringify({ lockfileVersion: 2, packages: {} }), 'pkg', '1.0.0', {}), /not lockfileVersion 3/)
})
