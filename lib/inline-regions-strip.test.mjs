// The engines carry inlined code without its whole-line `//` comments (lib/inline-regions.mjs,
// withoutLineComments): what is dropped, what stays, and that dropping changes no token of any region shipped.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { extractDeclaration, findRegions, renderRegion, ROOT, withoutLineComments } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = loadTypescript(ROOT)
// Without the compiler this skips locally; in CI it runs and fails, so a missing install is never a green run.
const needsTs = ts || process.env['CI'] ? {} : { skip: true }
const T = /** @type {NonNullable<typeof ts>} */ (ts)

test('withoutLineComments drops whole-line comments and the blank lines that only separated them', () => {
  const src = [
    '// header',
    '/** @param {number} x */',
    'function f(x) {',
    '  const a = x // kept: after code',
    '',
    '  // why b',
    '',
    '  // more',
    '  const b = a',
    '  //',
    '  return b',
    '}',
  ].join('\n')
  assert.equal(withoutLineComments(src), [
    '/** @param {number} x */',
    'function f(x) {',
    '  const a = x // kept: after code',
    '',
    '  const b = a',
    '  return b',
    '}',
  ].join('\n'))
})

test('withoutLineComments keeps the directives a tool reads in the engine, and JSDoc', () => {
  const src = '  // @ts-expect-error reason\n  //eslint-disable-next-line x\n  // nosemgrep: rule\n  /**\n   * @type {number}\n   */\n  // gone\nconst a = 1'
  assert.equal(withoutLineComments(src), '  // @ts-expect-error reason\n  //eslint-disable-next-line x\n  // nosemgrep: rule\n  /**\n   * @type {number}\n   */\nconst a = 1')
})

test('renderRegion carries the declarations without their line comments; the source keeps them', () => {
  const src = '// lead\nexport function f() {\n  // inner\n  return 1\n}\n// b\nexport const B = 2'
  assert.equal(renderRegion(src, ['f', 'B']), 'function f() {\n  return 1\n}\n\nconst B = 2')
  assert.equal(extractDeclaration(src, 'f'), '// lead\nfunction f() {\n  // inner\n  return 1\n}')
})

/** `text` as tsc parses it, printed without comments: equal for two texts that differ only in comments and layout. @param {string} text */
function code(text) {
  const sf = T.createSourceFile('region.js', text, T.ScriptTarget.Latest, false, T.ScriptKind.JS)
  return T.createPrinter({ removeComments: true }).printFile(sf)
}

test('dropping line comments changes no code of any region a workflow carries, as tsc parses it', needsTs, () => {
  const dir = path.join(ROOT, 'workflows')
  let checked = 0
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    for (const r of findRegions(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      const source = fs.readFileSync(path.join(ROOT, r.source), 'utf8')
      const whole = r.names.map(n => extractDeclaration(source, n)).join('\n\n')
      assert.equal(code(renderRegion(source, r.names)), code(whole), `${f}: region from ${r.source}`)
      checked++
    }
  }
  assert.ok(checked > 0)
})
