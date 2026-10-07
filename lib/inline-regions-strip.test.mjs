// The engines carry inlined code without its whole-line `//` comments (lib/region-strip.mjs, withoutLineComments):
// what is dropped, what stays, and that a region whose stripping changes its program is refused, not written.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkAll, extractDeclaration, renderRegion, ROOT } from './inline-regions.mjs'
import { withoutLineComments } from './region-strip.mjs'
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

test('withoutLineComments keeps a `//`-starting line inside a block comment', () => {
  const src = '/**\n * Example:\n// not a line comment: inside the block\n */\nconst a = 1\n/* x\n  // also inside\n*/ // after\n// gone\nconst b = 2'
  assert.equal(withoutLineComments(src), '/**\n * Example:\n// not a line comment: inside the block\n */\nconst a = 1\n/* x\n  // also inside\n*/ // after\nconst b = 2')
})

// The reviewer's falsifier: a `// https://…` line inside a template literal is text, not a comment.
const TEMPLATE = 'export function msg() {\n  return `see\n// https://example.com/doc\nthere`\n}\n'

test('renderRegion refuses a declaration whose stripped text parses to another program, naming the declarations', needsTs, () => {
  assert.throws(() => renderRegion(TEMPLATE, ['msg']), /\[msg\].*changes the program/)
})

test('renderRegion fails closed without the compiler: no equivalence check, no region', () => {
  assert.throws(() => renderRegion('export const A = 1', ['A'], null), /tsc is not installed/)
})

test('checkAll --fix refuses the region whose stripping changes its program, names it, and writes nothing', needsTs, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-strip-'))
  try {
    fs.writeFileSync(path.join(base, 'src.mjs'), TEMPLATE)
    const rel = path.relative(ROOT, path.join(base, 'src.mjs')).split(path.sep).join('/')
    const dir = path.join(base, 'workflows')
    fs.mkdirSync(dir)
    const text = `// >>> craft-inline ${rel} msg\n${TEMPLATE.replace('export ', '').trimEnd()}\n// <<< craft-inline\n`
    fs.writeFileSync(path.join(dir, 'a.js'), text)
    const res = checkAll({ dir, fix: true, ts: T })
    assert.deepEqual(res.refusals.map(r => [r.file, r.line, r.names]), [['a.js', 1, ['msg']]])
    assert.match(/** @type {{ reason: string }} */ (res.refusals[0]).reason, /changes the program/)
    assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), text, '--fix leaves a refused region as it was')
    assert.deepEqual(checkAll({ dir, ts: null }).refusals.map(r => r.reason.includes('tsc is not installed')), [true])
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})
