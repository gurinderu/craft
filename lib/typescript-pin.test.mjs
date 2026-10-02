// Two installs of TypeScript, one version. The type checks compile with opencode/plugin's TypeScript;
// typescript-eslint loads the root's, and the engine lint hands it a program the plugin's compiler built
// (lib/engine-lint.mjs). The two pins must be exact and equal, and each lockfile must resolve them so.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './inline-regions.mjs'

/** @param {string} rel @returns {unknown} */
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))

/** @param {unknown} v @param {string[]} keys @returns {unknown} */
function at(v, keys) {
  let cur = v
  for (const k of keys) cur = cur && typeof cur === 'object' ? /** @type {Record<string, unknown>} */ (cur)[k] : undefined
  return cur
}

test('the root and opencode/plugin pin the same exact TypeScript, and their lockfiles resolve it', () => {
  const rootPin = at(readJson('package.json'), ['devDependencies', 'typescript'])
  const pluginPin = at(readJson('opencode/plugin/package.json'), ['devDependencies', 'typescript'])
  assert.equal(typeof rootPin, 'string', 'package.json pins no typescript devDependency')
  assert.match(String(rootPin), /^\d+\.\d+\.\d+$/, 'the root pin is a range, not an exact version')
  assert.equal(pluginPin, rootPin, 'the root TypeScript (typescript-eslint\'s) and opencode/plugin\'s (the type checks\') differ — move them together')
  for (const lock of ['package-lock.json', 'opencode/plugin/package-lock.json'])
    assert.equal(at(readJson(lock), ['packages', 'node_modules/typescript', 'version']), rootPin, `${lock} resolves another TypeScript`)
})
