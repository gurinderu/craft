import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anyCeilingProblems, countAny, forbiddenCalls, inlinedAnyProblems } from './engine-source-rules.mjs'

test('forbiddenCalls refuses what the sandbox throws on, in code only', () => {
  const src = [
    'const t = Date.now()',
    'const r = Math . random ()',
    'const d = new Date()',
    'const e = new Date',
    'const ok1 = new Date(ts)',
    'const ok2 = new Intl.DateTimeFormat()',
    'const ok3 = new DateRange()',
    '// Date.now() in a comment',
    ' * Math.random() in JSDoc',
    'const ok4 = 1 // new Date() trailing',
  ].join('\n')
  assert.deepEqual(forbiddenCalls(src, 'w.js'), [
    'w.js:1 calls Date.now(), which the Workflow sandbox throws on',
    'w.js:2 calls Math.random(), which the Workflow sandbox throws on',
    'w.js:3 calls an argless new Date, which the Workflow sandbox throws on',
    'w.js:4 calls an argless new Date, which the Workflow sandbox throws on',
  ])
})

test('forbiddenCalls reaches into craft-inline regions — inlined code runs in the sandbox too', () => {
  const src = ['// >>> craft-inline lib/x.mjs f', 'function f() { return Date.now() }', '// <<< craft-inline'].join('\n')
  assert.equal(forbiddenCalls(src, 'w.js').length, 1)
})

test('countAny counts `any` in JSDoc types only, nested braces included, outside regions', () => {
  const src = [
    '/** @param {any} a @returns {Record<string, any>} */',
    'const x = /** @type {{ a: { b: any[] } }} */ (y)',
    '/** @typedef {{ company: string }} NotAny */',
    'const prompt = `pick any of these`',
    '// >>> craft-inline lib/x.mjs f',
    '/** @param {any} z */',
    'function f(z) { return z }',
    '// <<< craft-inline',
  ].join('\n')
  assert.equal(countAny(src), 3)
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

test('inlinedAnyProblems holds every inlined lib module to zero `any`, counted in its whole source', () => {
  const clean = { text: '/** @param {unknown} v */\nexport function f(v) { return v }', engines: ['workflows/a.js'] }
  assert.deepEqual(inlinedAnyProblems(new Map([['lib/f.mjs', clean]])), [])
  const loose = { text: '/** @param {any} v @returns {Record<string, any>} */\nexport function g(v) { return v }', engines: ['workflows/a.js', 'workflows/b.js'] }
  assert.deepEqual(inlinedAnyProblems(new Map([['lib/g.mjs', loose], ['lib/f.mjs', clean]])),
    ['lib/g.mjs: 2 `any` type(s) in a module inlined into workflows/a.js, workflows/b.js — inlined code is held to zero; type the value instead'])
  assert.match(inlinedAnyProblems(new Map([['lib/gone.mjs', { text: null, engines: ['workflows/a.js'] }]]))[0] ?? '', /lib\/gone\.mjs: unreadable/)
})
