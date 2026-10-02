import { test } from 'vitest'
import assert from 'node:assert/strict'
import { anyCeilingProblems, countAny, forbiddenCalls, inlinedAnyProblems, parseEngine } from './engine-source-rules.mjs'
import { ROOT } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = loadTypescript(ROOT)
const needsTs = ts ? {} : { skip: true } // needs npm ci --prefix opencode/plugin
const T = /** @type {NonNullable<typeof ts>} */ (ts)

test('forbiddenCalls refuses every read of the clock or randomness the sandbox throws on, in code only', needsTs, () => {
  const src = [
    'const t = Date.now()',
    'const r = Math . random ()',
    'const d = new Date()',
    'const e = new Date',
    'const ok1 = new Date(ts)',
    'const ok2 = new Intl.DateTimeFormat()',
    'const ok3 = new DateRange()',
    '// Date.now() in a comment',
    '/** Math.random() in JSDoc */',
    'const ok4 = 1 // new Date() trailing',
    'const now = Date.now',
    "const r2 = Math['random']",
    'const s = Date()',
    "const ok5 = 'a // b'; const t2 = Date.now()",
    'const x = 2',
    '  * Math.random()',
    '/* t */ const t3 = Date.now()',
    'const re = /`/; const t4 = Date.now()',
  ].join('\n')
  assert.deepEqual(forbiddenCalls(src, 'w.js', T).map(l => Number(/w\.js:(\d+)/.exec(l)?.[1])), [1, 2, 3, 4, 11, 12, 13, 14, 16, 17, 18])
})

test('forbiddenCalls reaches into craft-inline regions — inlined code runs in the sandbox too', needsTs, () => {
  const src = ['// >>> craft-inline lib/x.mjs f', 'function f() { return Date.now() }', '// <<< craft-inline'].join('\n')
  assert.equal(forbiddenCalls(src, 'w.js', T).length, 1)
})

test('countAny counts every JSDoc type tsc reads as any — any, *, ?, Function — once each, outside regions', needsTs, () => {
  const src = [
    '/** @param {any} a @returns {Record<string, any>} */',
    'function h(a) { return a }',
    'const x = /** @type {{ a: { b: any[] } }} */ (y)',
    '/** @typedef {{ company: string }} NotAny */',
    'const prompt = `pick any of these`',
    'const s = /** @type {*} */ (y), q = /** @type {?} */ (y), g = /** @type {Function} */ (y), arr = /** @type {Array<*>} */ (y)',
    '// >>> craft-inline lib/x.mjs f',
    '/** @param {any} z */',
    'function f(z) { return z }',
    '// <<< craft-inline',
  ].join('\n')
  assert.equal(countAny(src, T), 7)
})

test('anyCeilingProblems: above fails, below fails as stale, equal passes, gaps are named', () => {
  assert.deepEqual(anyCeilingProblems({ 'a.js': 2 }, { 'a.js': 2 }), [])
  assert.match(anyCeilingProblems({ 'a.js': 3 }, { 'a.js': 2 })[0] ?? '', /above the ceiling 2/)
  assert.match(anyCeilingProblems({ 'a.js': 1 }, { 'a.js': 2 })[0] ?? '', /lower the ceiling to 1/)
  assert.match(anyCeilingProblems({ 'a.js': 0 }, {})[0] ?? '', /no ceiling/)
  assert.match(anyCeilingProblems({ 'a.js': 0 }, { 'a.js': '0' })[0] ?? '', /no ceiling/)
  assert.match(anyCeilingProblems({}, { 'gone.js': 0 })[0] ?? '', /not an engine/)
  assert.deepEqual(anyCeilingProblems({}, { 'broken.js': 0 }, ['broken.js']), [], 'an uncounted engine is not "not an engine"')
})

test('inlinedAnyProblems holds every inlined lib module to zero `any`, counted in its whole source', needsTs, () => {
  const clean = { text: '/** @param {unknown} v */\nexport function f(v) { return v }', engines: ['workflows/a.js'] }
  assert.deepEqual(inlinedAnyProblems(new Map([['lib/f.mjs', clean]]), T), [])
  const loose = { text: '/** @param {any} v @returns {Record<string, any>} */\nexport function g(v) { return v }', engines: ['workflows/a.js', 'workflows/b.js'] }
  assert.deepEqual(inlinedAnyProblems(new Map([['lib/g.mjs', loose], ['lib/f.mjs', clean]]), T),
    ['lib/g.mjs: 2 `any` type(s) in a module inlined into workflows/a.js, workflows/b.js — inlined code is held to zero; type the value instead'])
  assert.match(inlinedAnyProblems(new Map([['lib/gone.mjs', { text: null, engines: ['workflows/a.js'] }]]), T)[0] ?? '', /lib\/gone\.mjs: unreadable/)
})

test('countAny reads every block of a stacked JSDoc run, not only the last one', needsTs, () => {
  // ts.getJSDocCommentsAndTags hands back only @overload tags for all but the last block of a run,
  // which is exactly how review.js stacks its typedefs (Plan, Finding, the *Answer shapes).
  const src = [
    '/** @typedef {{ churn: any[] }} Plan */',
    '/** @typedef {{ lens: string }} Lens */',
    '/** @typedef {*} Loose */',
    'const x = 1',
  ].join('\n')
  assert.equal(countAny(src, T), 2)
})

test('countAny counts the type names tsc reads as untyped: function in either case, bare array and promise', needsTs, () => {
  const src = [
    'const a = /** @type {function} */ (y), b = /** @type {Function} */ (y)',
    'const c = /** @type {array} */ (y), d = /** @type {promise} */ (y)',
    'const ok = /** @type {Array<string>} */ (y), ok2 = /** @type {Promise<number>} */ (y), ok3 = /** @type {() => void} */ (y)',
  ].join('\n')
  assert.equal(countAny(src, T), 4)
})

test('forbiddenCalls sees through aliases, parentheses, spreads and globalThis', needsTs, () => {
  const bad = [
    'const { now } = Date',
    'const D = Date; D.now()',
    '(Date).now()',
    'new (Date)()',
    'new Date(...[])',
    'globalThis.Date.now()',
    "globalThis['Math'].random()",
    'const k = "now"; Date[k]()',
    'const o = { Date }',
    'f(Math)',
    '(globalThis.Date)()',
  ]
  const lines = forbiddenCalls(bad.join('\n'), 'w.js', T).map(l => Number(/w\.js:(\d+)/.exec(l)?.[1]))
  assert.deepEqual([...new Set(lines)], bad.map((_, i) => i + 1), forbiddenCalls(bad.join('\n'), 'w.js', T).join('\n'))
  const ok = [
    'const t = new Date(ts)',
    'const u = new Date(...parts, 1)',
    'const v = x instanceof Date',
    'const n = Date.parse(s) + Math.max(1, 2) + Date.UTC(2020, 1)',
    'const s = { Date: 1, Math: 2 }.Date',
    'const m = obj.Date.now()',
    'const g = globalThis.Date.parse(s)',
  ].join('\n')
  assert.deepEqual(forbiddenCalls(ok, 'w.js', T), [])
})

test('parseEngine: one parse feeds both rules, as the string form does', needsTs, () => {
  const src = '/** @param {any} a */\nfunction f(a) { return Date.now() + a }'
  const p = parseEngine(src, T)
  assert.equal(countAny(p, T), countAny(src, T))
  assert.deepEqual(forbiddenCalls(p, 'w.js', T), forbiddenCalls(src, 'w.js', T))
})
