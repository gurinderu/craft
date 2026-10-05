// The clock rule's edges, each with the reason it gives: which use of Date, Math and globalThis is a
// read the sandbox would throw on or an alias that reaches one, and which is not.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { forbiddenCalls } from './engine-clock-rule.mjs'
import { ROOT } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = loadTypescript(ROOT)
// Without the compiler these skip locally; in CI they run and fail, so a missing install is never a green
// run (Vitest's skip option carries no reason to report). Needs npm ci --prefix opencode/plugin.
const needsTs = ts || process.env['CI'] ? {} : { skip: true }
const T = /** @type {NonNullable<typeof ts>} */ (ts)

/** The reason of each refusal in `src`, one line per refusal, the `w.js:N reads ` prefix dropped. @param {string} src */
const reasons = src => forbiddenCalls(src, 'w.js', T).map(l => l.replace(/^w\.js:\d+ reads /, ''))

const ALIAS = (/** @type {string} */ g, /** @type {string} */ m) => `${g} as a value (an alias reaches ${g}.${m} out of sight; use ${g}.x directly), which the Workflow sandbox throws on`

test('Date or Math anywhere but a member access, new Date(arg) or the right of instanceof is a value', needsTs, () => {
  assert.deepEqual(reasons('const v = x[Date]'), [ALIAS('Date', 'now')])
  assert.deepEqual(reasons('const v = new Math(1)'), [ALIAS('Math', 'random')])
  assert.deepEqual(reasons('const v = new X(Date)'), [ALIAS('Date', 'now')])
  assert.deepEqual(reasons('const v = Date instanceof X'), [ALIAS('Date', 'now')])
  assert.deepEqual(reasons('const v = x + Date'), [ALIAS('Date', 'now')])
  assert.deepEqual(reasons('const { a = Date } = o'), [ALIAS('Date', 'now')])
})

test('Date called without new is refused as that, with or without arguments', needsTs, () => {
  assert.deepEqual(reasons('const s = Date()'), ['Date() called without new, which the Workflow sandbox throws on'])
  assert.deepEqual(reasons('const s = Date(1)'), ['Date() called without new, which the Workflow sandbox throws on'])
})

test('parentheses around Date are judged by the use of the whole', needsTs, () => {
  assert.deepEqual(reasons('const n = (Date).parse(s) + ((Math)).max(1, 2)'), [])
  assert.deepEqual(reasons('const ok = x instanceof (Date)'), [])
})

const GLOBAL = 'globalThis as a value, through which a destructure, an alias or a computed member reaches Date.now or Math.random out of sight'

test('globalThis is a value unless read through a literal member, typeof, or the right of in', needsTs, () => {
  assert.deepEqual(reasons('const v = globalThis in x'), [GLOBAL])
  assert.deepEqual(reasons('const v = 1 + globalThis'), [GLOBAL])
  assert.deepEqual(reasons("const ok = typeof globalThis + ('a' in globalThis)"), [])
})

test('a host escape is refused once, and what it encloses is not judged again', needsTs, () => {
  assert.equal(forbiddenCalls('const m = import(String(Date.now()))', 'w.js', T).length, 1)
})

test('new.target is not import.meta', needsTs, () => {
  assert.deepEqual(reasons('function F() { return new.target }'), [])
})
