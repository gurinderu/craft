// The complexity bars (realm @nick/craft, #155) admit no exception, so an inline `eslint-disable` must
// not exempt a function from them — in lib/ and the OpenCode plugin as in the engines (lib/engine-lint.mjs).
// Read from the effective config ESLint computes per file, so the check needs no type-aware program.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import { ESLint } from 'eslint'
import { ROOT } from './inline-regions.mjs'
import { COMPLEXITY_RULES } from './complexity-rules.mjs'

const linted = ['lib/json-object.mjs', 'lib/json-object.test.mjs', 'opencode/plugin/run-record.mjs', 'opencode/plugin/index.ts', 'knip.config.js']

for (const file of linted) {
  test(`${file}: inline config is refused and both complexity bars apply`, async () => {
    const config = /** @type {{ linterOptions?: { noInlineConfig?: unknown }, rules?: Record<string, unknown> }} */ (
      await new ESLint({ cwd: ROOT }).calculateConfigForFile(path.join(ROOT, file)))
    assert.equal(config.linterOptions?.noInlineConfig, true, 'an inline eslint-disable would waive a bar')
    for (const [rule, [, max]] of Object.entries(COMPLEXITY_RULES)) {
      const setting = config.rules?.[rule]
      assert.ok(Array.isArray(setting) && (setting[0] === 2 || setting[0] === 'error') && setting[1] === max, `${rule} is ${JSON.stringify(setting)}, not error at ${max}`)
    }
  })
}
