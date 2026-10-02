// The byte-compare gate's edges: where a declaration's comments start and its body ends, how a fence
// is read, and checkFile/checkAll over a scratch workflows/ whose region source lives outside lib/ —
// so the comparison reads text no mutation run rewrites.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkAll, checkFile, extractDeclaration, findRegions, lineDiff, renderRegion, ROOT, typedScopeProblems, unresolvedSiblings, STRICT_FLAGS, STRICT_OFF_FLAGS } from './inline-regions.mjs'

test('`export` is stripped from the declaration line, not from a comment that mentions it', () => {
  assert.equal(extractDeclaration('// see export rules\nexport const A = 1', 'A'), '// see export rules\nconst A = 1')
})

test('only `//` lines that start at column 0 travel with a declaration', () => {
  assert.equal(extractDeclaration("export const U = 'http://x'\nexport const A = 1", 'A'), 'const A = 1')
})

test('a one-line JSDoc travels only when it is the whole line, trailing spaces allowed', () => {
  assert.equal(extractDeclaration('/** a */ const X = 1\nexport const A = 1', 'A'), 'const A = 1')
  assert.equal(extractDeclaration('x /** a */\nexport const A = 1', 'A'), 'const A = 1')
  assert.equal(extractDeclaration('/** a */  \nexport const A = 1', 'A'), '/** a */  \nconst A = 1')
})

test('a multi-line JSDoc travels only when opened by `/**` at column 0, every middle line ` *`, closed by ` */` alone', () => {
  assert.equal(extractDeclaration('/** unclosed\nexport const A = 1', 'A'), 'const A = 1')
  assert.equal(extractDeclaration('/**\n * doc\n */ const B = 2\nexport const A = 1', 'A'), 'const A = 1')
  assert.equal(extractDeclaration('/**\na * b\n */\nexport const A = 1', 'A'), 'const A = 1')
  assert.equal(extractDeclaration(' /**\n * doc\n */\nexport const A = 1', 'A'), 'const A = 1')
  assert.equal(extractDeclaration('/**\n * doc\n */  \nexport const A = 1', 'A'), '/**\n * doc\n */  \nconst A = 1')
})

test('a one-line function must balance and end in `}`, trailing spaces allowed', () => {
  assert.equal(extractDeclaration('export function f(x) { return x }  \nexport const B = 1', 'f'), 'function f(x) { return x }  ')
  assert.equal(extractDeclaration('export function f(x) { if (x) {}\n  return x\n}', 'f'), 'function f(x) { if (x) {}\n  return x\n}')
})

test('a multi-line const ends at a column-0 line of closers only, a `;` allowed after them', () => {
  assert.equal(extractDeclaration('export const T = [\n  [1, 2],\n]', 'T'), 'const T = [\n  [1, 2],\n]')
  assert.equal(extractDeclaration('export const T = [\n  1,\n];', 'T'), 'const T = [\n  1,\n];')
  assert.throws(() => extractDeclaration('export const T = [\n  1,\n].map(x => x)', 'T'), /unterminated const 'T'/)
})

test('a region that is not valid JS fails at render, before it is compared or written', () => {
  assert.throws(() => renderRegion('export const T = [\n  1 2,\n]', ['T']), SyntaxError)
})

test('findRegions: a nested fence and an unclosed one name their line; names split on any run of spaces; the body keeps its lines', () => {
  const open = '// >>> craft-inline lib/x.mjs a'
  assert.throws(() => findRegions(`x\n${open}\n${open}\n// <<< craft-inline`), /^Error: nested craft-inline fence at line 3$/)
  assert.throws(() => findRegions(`x\n${open}\nbody`), /^Error: unclosed craft-inline fence opened at line 2$/)
  const [r] = findRegions('// >>> craft-inline lib/x.mjs a  b\nl1\nl2\n// <<< craft-inline')
  assert.deepEqual(r && { names: r.names, actual: r.actual, open: r.open, close: r.close }, { names: ['a', 'b'], actual: 'l1\nl2', open: 0, close: 3 })
})

test('lineDiff lists every line past the shorter side', () => {
  assert.equal(lineDiff('a\nb\nc', 'a'), '    + b\n    + c')
  assert.equal(lineDiff('a', 'a\nb'), '    - b')
})

test('unresolvedSiblings: the fence line, an unreadable source, and every export spelling', () => {
  const text = ['x', '// >>> craft-inline lib/fake.mjs main', 'function main(x) { return [a(x), b(x), c(x), d(x), e(x), f(x), g(x)] }', '// <<< craft-inline'].join('\n')
  const source = [
    'export  function a(x) { return x }', 'export async  function b(x) { return x }', 'export async function c(x) { return x }',
    'export function  d(x) { return x }', 'export const  e = 1', 'export let f = 1', 'export var g = 1',
    'export function main(x) { return x }',
  ].join('\n')
  const found = unresolvedSiblings(text, findRegions(text), () => source)
  assert.deepEqual(found.map(f => f.name), ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  assert.ok(found.every(f => f.line === 2 && f.source === 'lib/fake.mjs'))
  assert.deepEqual(unresolvedSiblings(text, findRegions(text), () => { throw new Error('ENOENT') }), [])
})

test('unresolvedSiblings: block comments of any length and indented line comments are prose, a comment between two tokens is a space', () => {
  const source = 'export function helper(x) { return x }\nexport function main(x) { return x }\n'
  /** @param {string[]} body */
  const run = body => {
    const text = ['// >>> craft-inline lib/fake.mjs main', ...body, '// <<< craft-inline'].join('\n')
    return unresolvedSiblings(text, findRegions(text), () => source).map(f => f.name)
  }
  assert.deepEqual(run(['/* helper(0) was here */', '/**', ' * helper(1)', ' */', 'function main(x) {', '  // helper(2)', '  return x', '}']), [])
  assert.deepEqual(run(['function main(x) {', '  return/* c */helper(x)', '}']), ['helper'])
})

const STRICT = { compilerOptions: { ...Object.fromEntries(['strict', ...STRICT_FLAGS].map(k => [k, true])), ...Object.fromEntries(STRICT_OFF_FLAGS.map(k => [k, false])), allowJs: true, checkJs: true } }

test('typedScopeProblems: a lib module in a subdirectory is one; a path that only contains lib/ or runs past .mjs is not; problems in path order', () => {
  /** @param {string[]} sources @param {string[]} typed */
  const run = (sources, typed) => typedScopeProblems({ root: '/r', sources, typedFiles: typed, config: STRICT, readSource: () => 'ok' })
  assert.deepEqual(run(['lib/sub/abc.mjs'], ['/r/lib/sub/abc.mjs']), [])
  assert.match(run(['src/lib/a.mjs'], ['/r/src/lib/a.mjs']).join('\n'), /src\/lib\/a\.mjs is inlined into workflows\/ but is not a non-test lib module/)
  assert.match(run(['lib/a.mjs.txt'], ['/r/lib/a.mjs.txt']).join('\n'), /lib\/a\.mjs\.txt is inlined into workflows\/ but is not a non-test lib module/)
  assert.deepEqual(run(['lib/z.mjs', 'lib/y.mjs'], []).map(p => p.split(' ')[0]), ['lib/y.mjs', 'lib/z.mjs'])
})

/**
 * A scratch workflows/ dir and a region source outside lib/, named relative to ROOT as a fence names it.
 * @param {(dir: string, rel: string) => void} check
 */
function withWorkflows(check) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-inline-'))
  try {
    const src = path.join(base, 'src.mjs')
    fs.writeFileSync(src, 'export function one(x) {\n  return x\n}\n\nexport const TWO = 2\n')
    const dir = path.join(base, 'workflows')
    fs.mkdirSync(dir)
    check(dir, path.relative(ROOT, src).split(path.sep).join('/'))
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
}

test('checkFile: a drifted region is a mismatch at its fence line, and --fix splices only the regions', () => {
  withWorkflows((dir, rel) => {
    const file = path.join(dir, 'a.js')
    const text = ['head', `// >>> craft-inline ${rel} one`, 'function one(x) {', '  return x', '}', '// <<< craft-inline', 'mid', `// >>> craft-inline ${rel} TWO`, 'const TWO = 3', '// <<< craft-inline', 'tail'].join('\n')
    fs.writeFileSync(file, text)
    const res = checkFile(file)
    assert.equal(res.regions.length, 2)
    assert.deepEqual(res.mismatches, [{ file, source: rel, names: ['TWO'], line: 8, diff: '    - const TWO = 3\n    + const TWO = 2' }])
    assert.equal(res.fixed, null)
    assert.equal(checkFile(file, { fix: true }).fixed, text.replace('const TWO = 3', 'const TWO = 2'))
    fs.writeFileSync(file, text.replace('const TWO = 3', 'const TWO = 2'))
    const clean = checkFile(file, { fix: true })
    assert.deepEqual([clean.mismatches, clean.fixed], [[], null])
  })
})

test('checkAll: every .js engine in order, regions counted, mismatches by file name, --fix writes the file back', () => {
  withWorkflows((dir, rel) => {
    const good = [`// >>> craft-inline ${rel} one TWO`, 'function one(x) {', '  return x', '}', '', 'const TWO = 2', '// <<< craft-inline'].join('\n')
    fs.writeFileSync(path.join(dir, 'b.js'), `${good}\n${good}\n`)
    fs.writeFileSync(path.join(dir, 'a.js'), `${good.replace('const TWO = 2', 'const TWO = 9')}\n`)
    fs.writeFileSync(path.join(dir, 'notes.md'), `${good.replace('const TWO = 2', 'const TWO = 9')}\n`)
    const res = checkAll({ dir })
    assert.deepEqual(res.files, ['a.js', 'b.js'])
    assert.equal(res.regionCount, 3)
    assert.deepEqual(res.mismatches.map(m => [m.file, m.line]), [['a.js', 1]])
    assert.match(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), /TWO = 9/, 'read-only without --fix')
    assert.equal(checkAll({ dir, fix: true }).mismatches.length, 1)
    assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), `${good}\n`)
    assert.deepEqual(checkAll({ dir }).mismatches, [])
  })
})
