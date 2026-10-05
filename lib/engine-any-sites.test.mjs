// implicitAnySites against the real checker, one small program per case: an `any` is one site where
// it enters, and nothing it flows into is another.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { implicitAnySites } from './engine-any-sites.mjs'
import { ROOT } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = loadTypescript(ROOT)
// Without the pinned compiler these skip locally; CI installs it, so there they run.
const needsTs = ts || process.env['CI'] ? {} : { skip: true }
const TS = /** @type {NonNullable<typeof ts>} */ (ts)
const P = "JSON.parse('1')"
/** A function of an `unknown` v, its body from line 2 on. */
const U = (/** @type {string} */ body) => `/** @param {unknown} v */\nexport function f(v) {\n${body}\n}`

/** `line:text` of each site in `src`, within 0-based lines [first, last) (the whole file by default). */
function sites(/** @type {string} */ src, first = 0, last = src.split('\n').length) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-any-'))
  try {
    const file = path.join(dir, 'x.mjs')
    fs.writeFileSync(file, src)
    const program = TS.createProgram([file], { allowJs: true, checkJs: true, strict: true, noEmit: true, types: [], target: TS.ScriptTarget.ES2022, lib: ['lib.es2023.d.ts'] })
    const sf = /** @type {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SourceFile} */ (program.getSourceFile(file))
    return implicitAnySites(TS, program.getTypeChecker(), sf, first, last).map(s => `${s.line}:${s.text}`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('an `any` is one site where it enters, not again at an access, a destructuring or a loop over it', needsTs, () => {
  assert.deepEqual(sites(`const x = ${P}\nexport const y = x.a.b + x[0]`), [`0:${P}`])
  assert.deepEqual(sites(`const { a, b: c } = ${P}\nconst [d] = ${P}\nconst { e: { g } } = ${P}\nexport { a, c, d, g }`), [`0:${P}`, `1:${P}`, `2:${P}`])
  assert.deepEqual(sites(`for (const e of ${P}) e.x()`), [`0:${P}`])
  assert.deepEqual(sites(`export const o = { a: ${P}, b: 1 }\nexport const v = ${P} ?? 1`), [`0:${P}`, `1:${P}`])
  assert.deepEqual(sites(`const o = { k: ${P} }\nexport const { k } = o`), [`0:${P}`])
  assert.deepEqual(sites(`export function h() {\n  const x = ${P}\n  return x\n}`), [`1:${P}`])
})

test('only lines [first, last) count, and a read of a variable declared outside them is counted where it is read', needsTs, () => {
  assert.deepEqual(sites(`const a = ${P}\nconst b = ${P}\nexport { a, b }`, 0, 1), [`0:${P}`])
  assert.deepEqual(sites(`const x = ${P}\nexport const y = x.a\nexport const z = ${P}`, 1, 2), ['1:x'])
  assert.deepEqual(sites(`export function h() { return x.a }\nvar x = ${P}`, 0, 1), ['0:x'])
  assert.deepEqual(sites(`export function h() { return x.a }\nvar x = ${P}`), [`1:${P}`])
})

test('a type carries `any` through a union, an object\'s properties to depth 4, and type arguments', needsTs, () => {
  const ret = (/** @type {string} */ type, /** @type {string} */ body) => sites(`/** @returns {${type}} */\nfunction f() { return ${body} }\nexport const v = f()`)
  assert.deepEqual(ret('{a:{b:{c:{d:any}}}}', '{a:{b:{c:{d:1}}}}'), ['2:f()'])
  assert.deepEqual(ret('{a:{b:{c:{d:{e:any}}}}}', '{a:{b:{c:{d:{e:1}}}}}'), [], 'deeper than the walk goes')
  assert.deepEqual(ret('{a:string}|{b:{c:{d:any}}}', "{a:''}"), ['2:f()'])
  assert.deepEqual(ret('{a:string}|{b:{c:{d:{e:any}}}}', "{a:''}"), [], 'a union is one level too')
  assert.deepEqual(ret('string | number', "'a'"), [])
  assert.deepEqual(ret('Promise<any>', 'Promise.resolve(1)'), ['2:f()'])
  assert.deepEqual(ret('Map<string, any>', 'new Map([["a", 1]])'), ['2:f()'])
  assert.deepEqual(ret('Map<string, string>', 'new Map([["a", "b"]])'), [])
})

test('a narrowing of a variable declared in the lines is one site per outermost narrowing construct', needsTs, () => {
  assert.deepEqual(sites(U('  if (Array.isArray(v)) return v.length + v[0]\n  return 0')), ['2:v'])
  assert.deepEqual(sites(U('  if (Array.isArray(v)) return v[0]\n  if (Array.isArray(v)) return v[1]\n  return 0')), ['2:v', '3:v'])
  assert.deepEqual(sites(U('  if (Array.isArray(v)) { if (v.length) return v[0] }\n  return 0')), ['2:v'])
  assert.deepEqual(sites(U('  return Array.isArray(v) ? v[0] : 0')), ['2:v'])
  assert.deepEqual(sites(U('  return Array.isArray(v) && v[0]')), ['2:v'])
  assert.deepEqual(sites(U('  return !Array.isArray(v) || v[0]')), ['2:v'])
  // With no test above the read (an early return), the nearest construct or function is the key.
  assert.deepEqual(sites(U('  if (!Array.isArray(v)) return 0\n  const a = v[0]\n  return v[1] + a')), ['3:v'])
  assert.deepEqual(sites(U('  if (!Array.isArray(v)) return 0\n  return () => v[1]')), ['3:v'])
  // A parameter that is `any` as declared is one site at its declaration, however often it is read.
  assert.deepEqual(sites('export function k(/** @type {any} */ a) {\n  if (a) return a\n  return a\n}'), ['0:a'])
})

test('a callback parameter inherits from the receiver it is called on or a callback return already counted', needsTs, () => {
  assert.deepEqual(sites(U('  if (!Array.isArray(v)) return 0\n  return v.map(e => e.x)')), ['3:v'])
  assert.deepEqual(sites(U('  if (!Array.isArray(v)) return 0\n  return v.map(function (e) { return e.x })')), ['3:v'])
  assert.deepEqual(sites(`export const t = [${P}].map(e => e.x)`), [`0:${P}`])
  assert.deepEqual(sites('export const p = Promise.resolve(1).catch(e => [e])'), ['0:e'])
  assert.deepEqual(sites('export const p = Promise.resolve(1).catch(function (e) { return [e] })'), ['0:e'])
  assert.deepEqual(sites('export const p = [1].map(n => n + 1)'), [])
  // Called through a plain function, not a method: the parameter is where the `any` enters.
  assert.deepEqual(sites('/** @param {(a: any) => void} cb */\nfunction g(cb) { cb(1) }\ng(e => e.x)'), ['2:e'])
})

test('an evolving untyped `let` or empty array is counted by what it is given, never at its name', needsTs, () => {
  for (const decl of ['let x', 'let x = null', 'let x = undefined']) assert.deepEqual(sites(`${decl}\nx = ${P}\nexport { x }`), [`1:${P}`], decl)
  for (const decl of ['const a = []', 'let a = []']) assert.deepEqual(sites(`${decl}\na.push(${P})\nexport { a }`), [`1:${P}`], decl)
  assert.deepEqual(sites(`let y = 0\ny = ${P}\nexport { y }`), [`1:${P}`])
  // A JSDoc type is not a placeholder: an `any` declared so is a site at its name.
  assert.deepEqual(sites('/** @type {any} */\nlet x\nx = 1\nexport { x }'), ['1:x'])
})

test('a cast to a type without `any` takes the value\'s type, through parentheses, branches, `||` and `??`', needsTs, () => {
  const cast = (/** @type {string} */ e) => sites(`const c = Math.random() > 0.5 ? 1 : undefined\nexport const n = /** @type {number} */ (${e})`)
  for (const e of [P, `(${P})`, `c ? ${P} : 1`, `c ? 1 : ${P}`, `c || ${P}`, `c ?? ${P}`]) assert.deepEqual(cast(e), [], e)
  // A condition and `&&` do not pass their operand's type up to the cast.
  for (const e of [`${P} ? 1 : 2`, `${P} && 1`]) assert.deepEqual(cast(e), [`1:${P}`], e)
  // A cast to `any` is itself the spelled count's; the value under it still entered here.
  assert.deepEqual(sites(`export const n = /** @type {any} */ (${P})`), [`0:${P}`])
})

test('a JSDoc-typed declaration fixes only an argless `new X()` placeholder, never an `any` the value carries', needsTs, () => {
  assert.deepEqual(sites('/** @type {Map<string, number>} */\nexport const m = new Map()'), [])
  assert.deepEqual(sites('export const m = new Map()'), ['0:new Map()'])
  assert.deepEqual(sites('/** @type {Map<string, any>} */\nexport const m = new Map()'), ['1:new Map()'])
  assert.deepEqual(sites(`/** @type {Map<string, number>} */\nexport const m = new Map(${P})`), [`1:${P}`])
  assert.deepEqual(sites(`/** @type {number} */\nexport const n = ${P}`), [`1:${P}`])
})

test('a site is named by its first line, cut to 60 characters', needsTs, () => {
  assert.deepEqual(sites("export const s = JSON.parse(\n  '1',\n)"), ['0:JSON.parse('])
  const long = `JSON.parse('${'a'.repeat(70)}')`
  assert.deepEqual(sites(`export const s = ${long}`), [`0:${long.slice(0, 60)}`])
})

test('each kind of narrowing construct is a key of its own, and one under a test that reads another value is not merged', needsTs, () => {
  const tail = '\n  if (!Array.isArray(v)) return a\n  return v[1]'
  assert.deepEqual(sites(U('  if (Array.isArray(v)) return v[0]\n  if (!Array.isArray(v)) return 0\n  return v[1]')), ['2:v', '4:v'])
  for (const head of ['Array.isArray(v) ? v[0] : 0', 'Array.isArray(v) && v[0]', '!Array.isArray(v) || v[0]']) {
    assert.deepEqual(sites(U(`  const a = ${head}${tail}`)), ['2:v', '4:v'], head)
  }
  assert.deepEqual(sites(U('  return (Array.isArray(v) && v[0]) || (Array.isArray(v) ? v[1] : 0)')), ['2:v'], 'the outer `||` reads v: one site')
  assert.deepEqual(sites(U('  if (Math.random() > 0.5) {\n    if (Array.isArray(v)) return v[0]\n    if (Array.isArray(v)) return v[1]\n  }\n  return 0')), ['3:v', '4:v'])
  // After an early return, each closure that reads the narrowed value is its own site.
  assert.deepEqual(sites(U('  if (!Array.isArray(v)) return 0\n  const g = () => v[0]\n  const h = () => v[1]\n  return [g, h]')), ['3:v', '4:v'])
})

test('an assignment target outside the lines, an argless `new` as an argument, and a bare `let` are judged as such', needsTs, () => {
  assert.deepEqual(sites(`var g\ng = ${P}\nexport { g }`, 1, 2), [`1:${P}`])
  assert.deepEqual(sites('export const s = String(new Map())'), ['0:new Map()'])
  assert.deepEqual(sites('let x\nexport { x }'), [])
  const ret = (/** @type {string} */ type) => sites(`/** @returns {${type}} */\nfunction f() { return /** @type {any} */ (null) }\nexport const v = f()`)
  assert.deepEqual(ret('Map<string, Map<string, Map<string, Map<string, any>>>>'), ['2:f()'])
  assert.deepEqual(ret('Map<string, Map<string, Map<string, Map<string, Map<string, any>>>>>'), [], 'type arguments past the walk\'s depth')
})
