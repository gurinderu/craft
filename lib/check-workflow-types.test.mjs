import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrapWorkflow } from './check-workflow-types.mjs'

test('a workflow is wrapped as the sandbox runs it, its inlined regions swapped for imports, lines kept', () => {
  const src = [
    'export const meta = { name: "x" }',
    '// >>> craft-inline lib/run-record.mjs isCount',
    'function isCount(v) { return v }',
    '// <<< craft-inline',
    'return isCount(args)',
  ].join('\n')
  const { text, offset } = wrapWorkflow(src, '/r')
  const out = text.split('\n')
  assert.equal(out[0], 'import { isCount } from "/r/lib/run-record.mjs"')
  assert.equal(out[offset - 1], 'async function __wf() {')
  // line N of the source is line N + offset of the wrapped module (1-based both ways)
  assert.equal(out[offset + 5 - 1], 'return isCount(args)')
  assert.equal(out[offset + 1 - 1], '       const meta = { name: "x" }', 'export becomes spaces: columns unchanged')
  assert.ok(!text.includes('function isCount(v)'), 'the region body is gone')
  assert.ok(text.includes('void meta'))
})


import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkWorkflowTypes } from './check-workflow-types.mjs'
import { ROOT } from './inline-regions.mjs'
import { tscEntry } from './run-tsc.mjs'

// These run the real compiler; without it they say so instead of failing on a misleading assertion.
const needsTsc = fs.existsSync(tscEntry(ROOT)) ? {} : { skip: 'needs npm ci --prefix opencode/plugin' }

/**
 * A throwaway repo root that borrows lib/ (file by file), the OpenCode tsc and node_modules, with its own
 * workflows/ and an `any` ceiling that fits them (every script at 0 unless `ceiling` says otherwise).
 */
function fakeRoot(/** @type {Record<string, string>} */ scripts, { withTsconfig = true, ceiling = /** @type {Record<string, unknown> | string | undefined} */ (undefined), libFiles = /** @type {Record<string, string>} */ ({}) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-wft-'))
  fs.mkdirSync(path.join(root, 'workflows'))
  for (const [name, src] of Object.entries(scripts)) fs.writeFileSync(path.join(root, 'workflows', name), src)
  fs.symlinkSync(path.join(ROOT, 'opencode'), path.join(root, 'opencode'))
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'))
  fs.mkdirSync(path.join(root, 'lib'))
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
    if (f === 'engine-any-ceiling.json' || (!withTsconfig && f !== 'workflow-sandbox.d.ts')) continue
    fs.symlinkSync(path.join(ROOT, 'lib', f), path.join(root, 'lib', f))
  }
  for (const [name, src] of Object.entries(libFiles)) fs.writeFileSync(path.join(root, 'lib', name), src)
  const fit = Object.fromEntries(Object.keys(scripts).map(n => [`workflows/${n}`, 0]))
  const body = ceiling === undefined ? JSON.stringify(fit) : typeof ceiling === 'string' ? ceiling : JSON.stringify(ceiling)
  fs.writeFileSync(path.join(root, 'lib', 'engine-any-ceiling.json'), body)
  return root
}

test('a planted type error is reported at its own line of workflows/<file>.js', needsTsc, () => {
  const root = fakeRoot({ 'x.js': ['export const meta = { name: "x" }', 'const n = 1', 'const bad = [1][0].toFixed()', 'return n'].join('\n') })
  try {
    const { problems } = checkWorkflowTypes(root)
    assert.ok(problems.some(p => p.startsWith('workflows/x.js:3:')), problems.join('\n'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a tsc failure with no file location (a missing config) fails the check, never passes it', needsTsc, () => {
  const root = fakeRoot({ 'x.js': 'return 1' }, { withTsconfig: false })
  try {
    const { problems } = checkWorkflowTypes(root)
    assert.ok(problems.length > 0, 'nothing was type-checked, so the check must not pass')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the check never passes having checked nothing, and an engine may not switch it off', needsTsc, () => {
  const run = (/** @type {Record<string, string>} */ scripts, /** @type {(p: string[]) => void} */ expect) => {
    const root = fakeRoot(scripts)
    try { expect(checkWorkflowTypes(root).problems) } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
  run({}, p => assert.match(p.join('\n'), /no workflow scripts found/))
  run({ 'x.js': 'const n = 1\n// @ts-ignore\nconst bad = [1][0].toFixed()\nreturn n + bad' }, p => assert.match(p.join('\n'), /workflows\/x\.js:2 switches the type check off with @ts-ignore/))
  run({ 'x.js': 'const p = process.env\nreturn p' }, p => assert.match(p.join('\n'), /x\.js:1:.*process/), )
  run({ 'x.js': "/** @type {import('../lib/run-record.mjs').RunRecord} */\nconst r = {}\nreturn r" }, p => assert.deepEqual(p, []))
})

test('only a directive in comment position counts, and a broken fence is reported against its file', needsTsc, () => {
  const run = (/** @type {Record<string, string>} */ scripts, /** @type {(p: string[]) => void} */ expect) => {
    const root = fakeRoot(scripts)
    try { expect(checkWorkflowTypes(root).problems) } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
  run({ 'x.js': 'const prompt = `flag any @ts-ignore that hides a type error`\nreturn prompt' }, p => assert.deepEqual(p, []))
  run({ 'x.js': '/* @ts-nocheck */\nreturn 1' }, p => assert.match(p.join('\n'), /x\.js:1 switches the type check off with @ts-nocheck/))
  run({ 'x.js': '// >>> craft-inline lib/run-record.mjs isCount\nfunction isCount(v) { return v }\nreturn 1' }, p => assert.match(p.join('\n'), /^workflows\/x\.js: unclosed craft-inline fence/m))
})

test('the source rules run with the type check: a clock call and an `any` over the ceiling fail it', needsTsc, () => {
  const run = (/** @type {Record<string, string>} */ scripts, /** @type {Record<string, unknown> | string | undefined} */ ceiling, /** @type {(p: string[]) => void} */ expect) => {
    const root = fakeRoot(scripts, { ceiling })
    try { expect(checkWorkflowTypes(root).problems) } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
  run({ 'x.js': 'const t = Date.now()\nreturn t' }, undefined, p => assert.match(p.join('\n'), /workflows\/x\.js:1 reads Date\.now/))
  const anyOne = 'const v = /** @type {any} */ (args)\nreturn v'
  run({ 'x.js': anyOne }, undefined, p => assert.match(p.join('\n'), /workflows\/x\.js: 1 `any` types, above the ceiling 0/))
  run({ 'x.js': anyOne }, { 'workflows/x.js': 1 }, p => assert.deepEqual(p, []))
  run({ 'x.js': 'return 1' }, '[1]', p => assert.match(p.join('\n'), /engine-any-ceiling\.json unreadable/))
})

test('a missing compiler is named as such, with the install to run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-wft-notsc-'))
  try {
    fs.mkdirSync(path.join(root, 'workflows'))
    fs.writeFileSync(path.join(root, 'workflows', 'x.js'), 'return 1')
    fs.symlinkSync(path.join(ROOT, 'lib'), path.join(root, 'lib'))
    const { problems } = checkWorkflowTypes(root)
    assert.match(problems.join('\n'), /tsc is not installed at opencode\/plugin\/node_modules\/typescript\/bin\/tsc — run npm ci --prefix opencode\/plugin/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an `any` in a lib module an engine inlines fails the check, though the region text is skipped by the engine count', needsTsc, () => {
  const run = (/** @type {string} */ lib, /** @type {(p: string[]) => void} */ expect) => {
    const root = fakeRoot({
      'x.js': ['// >>> craft-inline lib/planted.mjs planted', 'function planted(v) { return v }', '// <<< craft-inline', 'return planted(1)'].join('\n'),
    }, { libFiles: { 'planted.mjs': lib } })
    try { expect(checkWorkflowTypes(root).problems) } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
  run('/** @param {number} v */\nexport function planted(v) { return v }\n', p => assert.deepEqual(p, []))
  run('/** @param {number} v */\nexport function planted(v) { return v }\n/** @type {any} */\nexport const loose = 1\n',
    p => assert.match(p.join('\n'), /^lib\/planted\.mjs: 1 `any` type\(s\) in a module inlined into workflows\/x\.js — inlined code is held to zero/m))
})

test('the ceiling counts the `any` the checker sees, spelled or not, where it enters the engine', needsTsc, () => {
  const count = (/** @type {string} */ src, /** @type {Record<string, string>} */ libFiles = {}) => {
    const root = fakeRoot({ 'x.js': src }, { libFiles })
    try {
      const p = checkWorkflowTypes(root).problems.join('\n')
      const m = /workflows\/x\.js: (\d+) `any` types, above the ceiling 0/.exec(p)
      return { n: m ? Number(m[1]) : 0, p }
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
  // The planted hole: no `any` is spelled anywhere, and the untyped Map's read is one.
  const planted = count("const m = new Map()\nm.set('x', { foo: 1 })\nconst v = m.get('x').foo\nreturn v")
  assert.equal(planted.n, 1, planted.p)
  assert.match(planted.p, /workflows\/x\.js:1 new Map\(\)/, 'the site is listed with its line: where the untyped Map is made')
  assert.equal(count("/** @type {Map<string, { foo: number }>} */\nconst m = new Map()\nreturn m.get('x')?.foo").n, 0)
  // An untyped callback parameter is one site however often it is read; a typed one is none.
  assert.equal(count('return Promise.resolve(1).catch(e => [e, e, e.message])').n, 1)
  assert.equal(count('return Promise.resolve(1).catch((/** @type {unknown} */ e) => [e, e])').n, 0)
  assert.equal(count("const v = JSON.parse('1')\nreturn [v, v]").n, 1)
  // An evolving `let` is typed by flow: its placeholder declaration is no site, an `any` assigned to it is.
  assert.equal(count("let x = null\nif (args) x = 'a'\nreturn x").n, 0)
  assert.equal(count("let x = null\nif (args) x = JSON.parse('1')\nreturn x").n, 1)
  // A spelled cast is the spelled count's, not counted twice.
  assert.equal(count('return /** @type {any} */ (args)').n, 1)
  // An implicit `any` exported by an inlined lib module reaches the engine at the read.
  const lib = 'export function loose() { return JSON.parse(\'1\') }\n'
  assert.equal(count(['// >>> craft-inline lib/loose.mjs loose', 'function loose() { return JSON.parse(\'1\') }', '// <<< craft-inline', 'return loose()'].join('\n'), { 'loose.mjs': lib }).n, 1)
  // pipeline's stage parameters are `unknown`, never `any`, so an untyped stage reads nothing loose.
  assert.equal(count('return pipeline([1], (prev, item) => [prev, item])').n, 0)
  // A cast to a concrete type is where the parsed value gets its type: the `any` never enters the engine.
  assert.equal(count("const v = /** @type {{ a: number }} */ (JSON.parse('1'))\nreturn v.a").n, 0)
  assert.equal(count("return (/** @type {number[]} */ (JSON.parse('[1]')))[0]").n, 0)
  // An `any` inside a type — any[] by narrowing unknown, Promise<any> — is one where it enters, at the read.
  assert.equal(count('const v = /** @type {unknown} */ (args)\nif (Array.isArray(v)) return [v, v]\nreturn null').n, 1)
  assert.equal(count('const v = /** @type {unknown} */ (args)\nif (Array.isArray(v)) return v.map(e => e)\nreturn null').n, 1)
  assert.equal(count("const v = /** @type {unknown} */ (args)\nif (Array.isArray(v)) return /** @type {unknown[]} */ (v)\nreturn null").n, 0)
  assert.equal(count("return Promise.resolve(JSON.parse('1'))").n, 1)
  // A JSDoc-typed declaration types its initializer, through a conditional and `||` too.
  assert.equal(count("/** @type {Map<string, number>} */\nconst m = new Map()\nreturn m.get('x')").n, 0)
  // …but only the checker's placeholder (an argless `new Map()`/`new Set()`): an `any` a value carries,
  // such as any[] from narrowing, is not discharged by a declaration — that would be a silent assertion.
  assert.equal(count("/** @type {{ a: number }[]} */\nconst a = Array.isArray(args) ? args : []\nreturn a").n, 1)
  assert.equal(count("/** @type {{ a: number }[]} */\nconst a = Array.isArray(args) ? /** @type {{ a: number }[]} */ (args) : []\nreturn a").n, 0)
  // A typed declaration asserts nothing about a bare `any` it is given: that still enters, and counts.
  assert.equal(count("/** @type {{ a: number }} */\nconst v = JSON.parse('1')\nreturn v").n, 1)
  assert.equal(count("/** @type {{ a: number }} */\nconst v = args ? JSON.parse('1') : { a: 1 }\nreturn v").n, 1)
  // Each narrowing is its own site: a second, independent narrowing of the same variable adds one.
  assert.equal(count('const v = /** @type {unknown} */ (args)\nif (Array.isArray(v)) log(v)\nif (Array.isArray(v)) log(v)\nreturn null').n, 2)
  // …but one narrowing is one site, however its reads nest: a read under a nested `if`, inside the
  // narrowing's own `&&`, or in a closure within the narrowed branch is the same narrowing.
  assert.equal(count('const v = /** @type {unknown} */ (args)\nif (Array.isArray(v)) { log(v); if (args) log(v) }\nreturn null').n, 1)
  assert.equal(count('const v = /** @type {unknown} */ (args)\nif (Array.isArray(v) && v.length > 0) log(v)\nreturn null').n, 1)
  assert.equal(count('const v = /** @type {unknown} */ (args)\nif (Array.isArray(v)) log(v, () => v)\nreturn null').n, 1)
  // An element taken by for-of out of a narrowed any[] is the same site as the array.
  assert.equal(count('const v = /** @type {unknown} */ (args)\nif (Array.isArray(v)) { for (const e of v) log(e) }\nreturn null').n, 1)
  // An any inside an object literal is one site, where it is made; a destructured for-of binding inherits.
  assert.equal(count("const o = { m: new Map() }\nreturn [o.m.get('x'), o.m.get('y')]").n, 1)
  assert.equal(count("const m = new Map()\nfor (const [k, v] of m) log([k, v])\nreturn null").n, 1)
  assert.equal(count("const s = new Set()\nreturn s").n, 1)
  // An empty array evolves by its pushes: typed pushes leave nothing, an `any` pushed is the site.
  assert.equal(count("const a = []\na.push(1)\nreturn a").n, 0)
  assert.equal(count("const a = []\na.push(JSON.parse('1'))\nreturn a").n, 1)
})
