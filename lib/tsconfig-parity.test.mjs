// The OpenCode plugin is type-checked by its own tsconfig, which no other gate reads: check-workflows
// holds only lib/tsconfig.json's flags. Both are held here to the same maximum strictness (realm
// @nick/craft, #131), through the same check the inline gate runs, so dropping a flag from either,
// or switching a strict-family flag off beside `strict`, fails the tests.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, STRICT_FAMILY_FLAGS, strictnessProblems } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = loadTypescript(ROOT)
// Without the compiler these skip locally; in CI they run and fail, so a missing install is never a green
// run (Vitest's skip option carries no reason to report). Needs npm ci --prefix opencode/plugin.
const needsTs = ts || process.env['CI'] ? {} : { skip: true }

/** @param {string} config @returns {Record<string, unknown>} */
function compilerOptions(config) {
  /** @type {{ compilerOptions?: Record<string, unknown> }} */
  const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, config), 'utf8'))
  return parsed.compilerOptions ?? {}
}

for (const config of ['lib/tsconfig.json', 'opencode/plugin/tsconfig.json']) {
  test(`${config} keeps every strictness flag, and switches no strict-family flag off`, () => {
    assert.deepEqual(strictnessProblems(config, compilerOptions(config)), [])
  })

  // `strict` turns its family on, but an explicit `false` beside it wins: each planted config must fail.
  test(`${config}: an explicit false on any strict-family flag is refused`, () => {
    for (const flag of STRICT_FAMILY_FLAGS) {
      assert.deepEqual(strictnessProblems(config, { ...compilerOptions(config), [flag]: false }), [`${config}: ${flag} is turned off`])
    }
  })
}

test('the strict family is exactly the options the installed tsc turns on with `strict`', needsTs, () => {
  // optionDeclarations is on the module at runtime but not in its public typings.
  const declared = /** @type {{ optionDeclarations: { name: string, strictFlag?: boolean }[] }} */ (/** @type {unknown} */ (ts)).optionDeclarations
  assert.deepEqual([...STRICT_FAMILY_FLAGS].sort(), declared.filter(o => o.strictFlag).map(o => o.name).sort())
})
