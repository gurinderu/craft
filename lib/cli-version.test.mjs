// The craft CLI carries the plugin's version (lib/craft-bin.mjs fetches the binary of the plugin's version from
// that release): release-please moves cli/Cargo.toml and cli/Cargo.lock's workspace packages with the manifest,
// and `cargo build --locked` in the release workflow refuses a lockfile left behind.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/** @param {string} file */
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

test('cli/Cargo.toml and the workspace packages in cli/Cargo.lock are at the plugin version', () => {
  const version = JSON.parse(read('.release-please-manifest.json'))['.']
  assert.equal(/\[workspace\.package\]\nversion = "([^"]+)"/.exec(read('cli/Cargo.toml'))?.[1], version)
  const local = read('cli/Cargo.lock').split('[[package]]').filter(p => /^name = "craft/m.test(p) && !/^source = /m.test(p))
  assert.deepEqual(local.map(p => /^version = "([^"]+)"/m.exec(p)?.[1]), [version, version, version, version])
})

test('release-please moves both files', () => {
  const extra = JSON.parse(read('release-please-config.json')).packages['.']['extra-files']
  assert.deepEqual(extra.filter((/** @type {{ path: string }} */ f) => f.path.startsWith('cli/')), [
    { type: 'toml', path: 'cli/Cargo.toml', jsonpath: '$.workspace.package.version' },
    { type: 'toml', path: 'cli/Cargo.lock', jsonpath: '$.package[?(!@.source)].version' },
  ])
})
