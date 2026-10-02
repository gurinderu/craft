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
    '  return [e, g, h, t, r]',
    '}',
    CLOSE,
    'return isCount()',
  ])
  assert.deepEqual(p.map(l => l.split(' :: ')[0]), ['workflows/x.js:4', 'workflows/x.js:5', 'workflows/x.js:6', 'workflows/x.js:7', 'workflows/x.js:8'], p.join('\n'))
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

test('a name outside every region is left to the engine type check', needsTs, () => {
  assert.deepEqual(check([OPEN, 'function isCount() { return 1 }', CLOSE, 'const e = new TextEncoder()', 'return [e, isCount()]']), [])
})

test('every current engine passes', needsTs, () => {
  assert.deepEqual(inlinedNameProblems(ROOT, /** @type {NonNullable<typeof ts>} */ (ts)), [])
})
