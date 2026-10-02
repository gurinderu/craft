// The complexity bars (realm @nick/craft, #155) admit no exception, so an inline `eslint-disable` must
// not exempt a function from them — in lib/ and the OpenCode plugin as in the engines (lib/engine-lint.mjs).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import { ESLint } from 'eslint'
import { ROOT } from './inline-regions.mjs'

const ifs = Array.from({ length: 10 }, (_, i) => `  if (a === ${i}) return ${i}`).join('\n')
const complex = `export function f(/** @type {number} */ a) {\n${ifs}\n  return -1\n}\n`

test('an inline eslint-disable does not exempt a function from the complexity bar', async () => {
  const eslint = new ESLint({ cwd: ROOT })
  const filePath = path.join(ROOT, 'lib', 'json-object.mjs') // an existing file: the typed rules need it in lib's tsconfig program
  const [plain] = await eslint.lintText(complex, { filePath })
  assert.ok(plain?.messages.some(m => m.ruleId === 'complexity'), 'premise: the probe is over the bar')
  const [disabled] = await eslint.lintText(`// eslint-disable-next-line complexity\n${complex}`, { filePath })
  assert.ok(disabled?.messages.some(m => m.ruleId === 'complexity'), 'the directive must not hide it')
})
