// The OpenCode plugin is type-checked by its own tsconfig, which no other gate reads: check-workflows
// holds only lib/tsconfig.json's flags. Both are held here to the same maximum strictness (realm
// @nick/craft, #131), so dropping a flag from either fails the tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, STRICT_FLAGS, STRICT_OFF_FLAGS } from './inline-regions.mjs'

for (const config of ['lib/tsconfig.json', 'opencode/plugin/tsconfig.json']) {
  test(`${config} keeps every strictness flag`, () => {
    /** @type {{ compilerOptions?: Record<string, unknown> }} */
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, config), 'utf8'))
    const opts = parsed.compilerOptions ?? {}
    for (const flag of ['strict', 'allowJs', 'checkJs', ...STRICT_FLAGS]) assert.equal(opts[flag], true, `${config}: ${flag} is not on`)
    for (const flag of STRICT_OFF_FLAGS) assert.equal(opts[flag], false, `${config}: ${flag} is not false`)
  })
}
