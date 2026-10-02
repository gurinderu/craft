import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inlinedNameProblems } from './inlined-sandbox-names.mjs'
import { ROOT } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = loadTypescript(ROOT)
const needsTs = ts ? {} : { skip: 'needs npm ci --prefix opencode/plugin' }

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

test('a name outside every region is left to the engine type check', needsTs, () => {
  assert.deepEqual(check([OPEN, 'function isCount() { return 1 }', CLOSE, 'const e = new TextEncoder()', 'return [e, isCount()]']), [])
})

test('every current engine passes', needsTs, () => {
  assert.deepEqual(inlinedNameProblems(ROOT, /** @type {NonNullable<typeof ts>} */ (ts)), [])
})
