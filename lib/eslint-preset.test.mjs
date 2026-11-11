import { test } from 'vitest'
import assert from 'node:assert/strict'
import tseslint from 'typescript-eslint'
import { presetRules } from './eslint-preset.mjs'

test('the installed strict-type-checked preset has the entry the lint config reads', () => {
  const rules = presetRules(tseslint.configs.strictTypeChecked, 'typescript-eslint/strict-type-checked')
  assert.ok('@typescript-eslint/no-unsafe-argument' in rules)
})

test('a missing or empty entry throws instead of leaving the lint with no rules', () => {
  assert.throws(() => presetRules([{ name: 'typescript-eslint/base' }], 'typescript-eslint/strict-type-checked'), /renamed or dropped/)
  assert.throws(
    () => presetRules([{ name: 'typescript-eslint/strict-type-checked', rules: {} }], 'typescript-eslint/strict-type-checked'),
    /renamed or dropped/,
  )
})
