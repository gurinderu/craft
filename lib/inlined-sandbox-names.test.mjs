import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inlinedNameProblems } from './inlined-sandbox-names.mjs'
import { ROOT } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = loadTypescript(ROOT)
// Without the compiler these skip locally; in CI they run and fail, so a missing install is never a green
// run (Vitest's skip option carries no reason to report). Needs npm ci --prefix opencode/plugin.
const needsTs = ts || process.env['CI'] ? {} : { skip: true }

/** Problems for one engine whose body is `lines`, in a throwaway root that borrows lib/. @param {string[]} lines */
function check(lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-wfn-'))
  try {
    fs.mkdirSync(path.join(root, 'workflows'))
    fs.symlinkSync(path.join(ROOT, 'lib'), path.join(root, 'lib'))
    fs.symlinkSync(path.join(ROOT, 'opencode'), path.join(root, 'opencode'))
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'))
    fs.writeFileSync(path.join(root, 'workflows', 'x.js'), lines.join('\n'))
    return inlinedNameProblems(root, /** @type {NonNullable<typeof ts>} */ (ts))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
const OPEN = '// >>> craft-inline lib/run-record.mjs isCount'
const CLOSE = '// <<< craft-inline'

test('a name the sandbox lacks is refused in inlined code, however it is reached', needsTs, () => {
  const p = check([
    'export const meta = { name: "x" }',
    OPEN,
    'function isCount() {',
    '  const e = new TextEncoder()',
    '  const g = globalThis.TextDecoder',
    "  const h = globalThis['process']",
    '  const t = performance.now()',
    '  const r = require("x")',
    '  const o = { performance }',
    '  return [e, g, h, t, r, o]',
    '}',
    'class C { process() { return process.env } }',
    CLOSE,
    'return [isCount(), C]',
  ])
  const at = p.map(l => Number(/x\.js:(\d+)/.exec(l)?.[1])).sort((a, b) => a - b)
  assert.deepEqual(at, [4, 5, 6, 7, 8, 9, 12], p.join('\n'))
})

test('comments, strings, regex literals, JSDoc type names and property names are not uses', needsTs, () => {
  const p = check([
    OPEN,
    '/** @param {SomeLibOnlyType} v @returns {ProcessInfo} */',
    'function isCount(v) {',
    '  // new TextEncoder() in a comment',
    "  const s = 'process the require list' + `to process ${String(v)}` + /[#`*_'\"]/.source",
    '  const o = { process: 1, require: 2 }',
    '  const { process: p } = o',
    '  return [s, o.process, p]',
    '}',
    CLOSE,
    'return isCount(1)',
  ])
  assert.deepEqual(p, [])
})

test('a line break JS counts and findRegions does not (U+2028) shifts no report and hides no use', needsTs, () => {
  const p = check(['const a = "x\u2028y\u2029z"', OPEN, 'function isCount() {', '  return new TextEncoder()', '}', CLOSE, 'return [a, isCount()]'])
  assert.deepEqual(p.map(l => l.split(' :: ')[0]), ['workflows/x.js:4'], p.join('\n'))
})

test('a program that compiles anything beyond the engines, the ES library and the sandbox fails', needsTs, () => {
  // An absolute path, so the import resolves from wherever the check compiles: this is the program leak itself.
  const p = check([`/** @typedef {import(${JSON.stringify(path.join(ROOT, 'node_modules', '@types', 'node', 'index.d.ts'))}).Buffer} B */`, OPEN, 'function isCount() { return 1 }', CLOSE, 'return isCount()'])
  assert.ok(p.some(l => /its program must hold only/.test(l)), p.join('\n'))
})

test('routes to the host with no unresolved name are refused: import(), import.meta, eval, Function', needsTs, () => {
  const p = check([
    OPEN,
    'async function isCount() {',
    '  const u = await import("node:util")',
    '  const m = import.meta.url',
    '  const e = eval("TextEncoder")',
    '  const f = new Function("return process")()',
    '  return [u, m, e, f]',
    '}',
    CLOSE,
    'return isCount()',
  ])
  assert.deepEqual(p.map(l => Number(/x\.js:(\d+)/.exec(l)?.[1])).sort((a, b) => a - b), [3, 4, 5, 6], p.join('\n'))
})

test('a value use of a host global that a JSDoc typedef also names is refused (TS2693)', needsTs, () => {
  const p = check(['/** @typedef {{ href: string }} URL */', OPEN, 'function isCount() {', '  return new URL("http://x")', '}', CLOSE, 'return isCount()'])
  assert.deepEqual(p.map(l => l.split(' :: ')[0]), ['workflows/x.js:4'], p.join('\n'))
})

test('a property merely named globalThis, eval or Function is not a use', needsTs, () => {
  assert.deepEqual(check([OPEN, 'function isCount(o) {', '  const { globalThis: g, eval: e } = o', '  return [o.globalThis, o.Function, { globalThis: 1 }, g, e]', '}', CLOSE, 'return isCount({})']), [])
})

test('a name outside every region is left to the engine type check', needsTs, () => {
  assert.deepEqual(check([OPEN, 'function isCount() { return 1 }', CLOSE, 'const e = new TextEncoder()', 'return [e, isCount()]']), [])
})

test('a use before a region, or at the very start of the line after it, is outside it', needsTs, () => {
  assert.deepEqual(check(['const e = new TextEncoder()', OPEN, 'function isCount() { return 1 }', CLOSE, 'performance.now()', 'return [e, isCount()]']), [])
})

test('regions are located by offset however far down the engine they sit, the meta line included', needsTs, () => {
  const pad = Array.from({ length: 30 }, (_, i) => `const pad${i} = 'a line long enough to move every offset after it'`)
  const p = check(['export const meta = { name: "x" }', ...pad, OPEN, 'function isCount() { return new TextEncoder() }', CLOSE, 'performance.now()', 'return [isCount(), pad0]'])
  assert.deepEqual(p.map(l => l.split(' :: ')[0]), ['workflows/x.js:33'], p.join('\n'))
})

test('only name resolution is judged: a type error in a region is lib/\'s to report', needsTs, () => {
  assert.deepEqual(check([OPEN, 'function isCount() {', '  /** @type {number} */', "  const n = 'x'", '  return n', '}', CLOSE, 'return isCount()']), [])
})

test('globalThis, eval and Function as values are refused: a declared name, an object value, a destructuring default', needsTs, () => {
  const p = check([
    OPEN,
    'function isCount(o) {',
    '  const Function = 1',
    '  const v = { x: globalThis }',
    '  const { a = eval } = o',
    '  return [Function, v, a]',
    '}',
    CLOSE,
    'return isCount({})',
  ])
  assert.deepEqual([...new Set(p.map(l => Number(/x\.js:(\d+)/.exec(l)?.[1])))].sort((a, b) => a - b), [3, 4, 5, 6], p.join('\n'))
})

test('an engine without a region is not compiled, so what it imports cannot leak into the program', needsTs, () => {
  const types = JSON.stringify(path.join(ROOT, 'node_modules', '@types', 'node', 'index.d.ts'))
  assert.deepEqual(check([`/** @typedef {import(${types}).Buffer} B */`, 'return 1']), [])
})

test('only workflows/*.js are engines', needsTs, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-wfn-'))
  try {
    fs.mkdirSync(path.join(root, 'workflows'))
    fs.symlinkSync(path.join(ROOT, 'lib'), path.join(root, 'lib'))
    fs.writeFileSync(path.join(root, 'workflows', 'notes.md'), [OPEN, 'function isCount() { return new TextEncoder() }', CLOSE].join('\n'))
    assert.deepEqual(inlinedNameProblems(root, /** @type {NonNullable<typeof ts>} */ (ts)), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

/** Problems for a root whose lib/ holds only `tsconfig` (null: none) and the sandbox declaration. @param {string | null} tsconfig */
function withConfig(tsconfig) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-wfn-'))
  try {
    fs.mkdirSync(path.join(root, 'workflows'))
    fs.mkdirSync(path.join(root, 'lib'))
    fs.copyFileSync(path.join(ROOT, 'lib', 'workflow-sandbox.d.ts'), path.join(root, 'lib', 'workflow-sandbox.d.ts'))
    if (tsconfig != null) fs.writeFileSync(path.join(root, 'lib', 'tsconfig.json'), tsconfig)
    fs.writeFileSync(path.join(root, 'workflows', 'x.js'), [OPEN, 'function isCount() { return 1 }', CLOSE, 'return isCount()'].join('\n'))
    return inlinedNameProblems(root, /** @type {NonNullable<typeof ts>} */ (ts))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('a lib/tsconfig.json that cannot be read or parsed compiles nothing, and says so', needsTs, () => {
  const absent = withConfig(null)
  assert.equal(absent.length, 1, absent.join('\n'))
  assert.match(absent[0] ?? '', /^lib\/tsconfig\.json: Cannot read file .* — the inlined-name check compiled nothing$/)
  const unknown = withConfig(JSON.stringify({ compilerOptions: { bogusOption: true } }))
  assert.equal(unknown.length, 1, unknown.join('\n'))
  assert.match(unknown[0] ?? '', /^lib\/tsconfig\.json: Unknown compiler option 'bogusOption'\. — the inlined-name check compiled nothing$/)
})

test('the engine copies are written outside the repo and removed after the check', needsTs, () => {
  const made = vi.spyOn(fs, 'mkdtempSync')
  try {
    check([OPEN, 'function isCount() { return 1 }', CLOSE, 'return isCount()'])
    const dirs = made.mock.results.map(r => String(r.value)).filter(d => path.basename(d).startsWith('craft-wfn-'))
    assert.equal(dirs.length, 2, 'the fixture root, then the check\'s own copies')
    assert.ok(dirs.every(d => !fs.existsSync(d)), dirs.join('\n'))
  } finally { made.mockRestore() }
})

test('every current engine passes', needsTs, () => {
  assert.deepEqual(inlinedNameProblems(ROOT, /** @type {NonNullable<typeof ts>} */ (ts)), [])
})
