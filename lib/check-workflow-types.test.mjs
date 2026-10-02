import { test } from 'vitest'
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
  assert.equal(out[offset - 2], 'async function __wf() {')
  assert.equal(out[offset - 1], 'void (() => meta)', 'meta is read before the final return, not after it')
  // line N of the source is line N + offset of the wrapped module (1-based both ways)
  assert.equal(out[offset + 5 - 1], 'return isCount(args)')
  assert.equal(out[offset + 1 - 1], '       const meta = { name: "x" }', 'export becomes spaces: columns unchanged')
  assert.ok(!text.includes('function isCount(v)'), 'the region body is gone')
})


import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkWorkflowTypes } from './check-workflow-types.mjs'
import { ROOT } from './inline-regions.mjs'
import { tscEntry } from './run-tsc.mjs'

// These run the real compiler. Without it they skip locally; in CI they run and fail, so a missing install is never a green
// run (Vitest's skip option carries no reason to report). Needs npm ci --prefix opencode/plugin.
const needsTsc = fs.existsSync(tscEntry(ROOT)) || process.env['CI'] ? {} : { skip: true }

/**
 * A throwaway repo root that borrows lib/ (file by file), the OpenCode tsc and node_modules, with its own
 * workflows/ and an `any` ceiling that fits them (every script at 0 unless `ceiling` says otherwise).
 */
function fakeRoot(/** @type {Record<string, string>} */ scripts, { withTsconfig = true, withNodeModules = true, ceiling = /** @type {Record<string, unknown> | string | undefined} */ (undefined), libFiles = /** @type {Record<string, string>} */ ({}) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-wft-'))
  fs.mkdirSync(path.join(root, 'workflows'))
  for (const [name, src] of Object.entries(scripts)) fs.writeFileSync(path.join(root, 'workflows', name), src)
  fs.symlinkSync(path.join(ROOT, 'opencode'), path.join(root, 'opencode'))
  if (withNodeModules) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'))
  linkLib(root, withTsconfig)
  for (const [name, src] of Object.entries(libFiles)) fs.writeFileSync(path.join(root, 'lib', name), src)
  fs.writeFileSync(path.join(root, 'lib', 'engine-any-ceiling.json'), ceilingBody(scripts, ceiling))
  return root
}

/** The throwaway root's lib/, file by file from this checkout's: never the ceiling, and only the sandbox declaration without a tsconfig. */
function linkLib(/** @type {string} */ root, /** @type {boolean} */ withTsconfig) {
  fs.mkdirSync(path.join(root, 'lib'))
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
    if (f === 'engine-any-ceiling.json' || (!withTsconfig && f !== 'workflow-sandbox.d.ts')) continue
    fs.symlinkSync(path.join(ROOT, 'lib', f), path.join(root, 'lib', f))
  }
}

/** The ceiling file's text: as given, or every script at 0. */
function ceilingBody(/** @type {Record<string, string>} */ scripts, /** @type {Record<string, unknown> | string | undefined} */ ceiling) {
  if (typeof ceiling === 'string') return ceiling
  return JSON.stringify(ceiling ?? Object.fromEntries(Object.keys(scripts).map(n => [`workflows/${n}`, 0])))
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
  // Read only where no unsafe-family rule looks (typeof), so the ceiling alone decides.
  const anyOne = 'const v = /** @type {any} */ (args)\nreturn typeof v'
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

test('typescript-eslint\'s unsafe family refuses an `any` where it is used, at its line of workflows/<file>.js, ceiling or not', needsTsc, () => {
  const run = (/** @type {string} */ src, /** @type {(p: string[]) => void} */ expect) => {
    const root = fakeRoot({ 'x.js': src }, { ceiling: { 'workflows/x.js': 10 } })
    // The ceiling must match the count exactly, which the tests above hold; only the lint's lines are kept here.
    try { expect(checkWorkflowTypes(root).problems.filter(l => !/ `any` types, (?:above|below) the ceiling /.test(l))) } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
  // The planted falsifier: the ceiling admits the one `any` JSON.parse returns; calling through it is refused.
  run("const v = JSON.parse('{}')\nv.x()\nreturn 1", p => {
    assert.ok(p.length > 0, 'the planted call must fail the check')
    assert.ok(p.every(l => /\(@typescript-eslint\/no-unsafe-[a-z-]+\)$/.test(l)), p.join('\n'))
    assert.ok(p.some(l => l.startsWith('workflows/x.js:1:7 ') && l.endsWith('(@typescript-eslint/no-unsafe-assignment)')), p.join('\n'))
    assert.ok(p.some(l => l.startsWith('workflows/x.js:2:1 ') && l.endsWith('(@typescript-eslint/no-unsafe-call)')), p.join('\n'))
  })
  // Each of the five rules, one plant each.
  run([
    "/** @param {number} n */ function f(n) { return n }",
    "f(JSON.parse('1'))",
    "/** @returns {number} */ function g() { return JSON.parse('1') }",
    "/** @type {number} */ const a = JSON.parse('1')",
    "const b = JSON.parse('1').y",
    "JSON.parse('1')()",
    'return [a, b, g()]',
  ].join('\n'), p => {
    const rules = new Set(p.map(l => /\((@typescript-eslint\/[a-z-]+)\)$/.exec(l)?.[1]))
    for (const r of ['argument', 'return', 'assignment', 'member-access', 'call']) assert.ok(rules.has(`@typescript-eslint/no-unsafe-${r}`), `${r}:\n${p.join('\n')}`)
  })
  // An engine may not switch a rule off with a directive.
  run("// eslint-disable-next-line\nJSON.parse('1')()\nreturn 1", p => assert.ok(p.some(l => l.startsWith('workflows/x.js:2:1 ') && /no-unsafe-call/.test(l)), p.join('\n')))
  run("/** @type {unknown} */\nconst v = JSON.parse('{}')\nreturn typeof v === 'number' ? v : 0", p => assert.deepEqual(p, []))
})

test('without ESLint or typescript-eslint the check fails, it does not skip the unsafe rules', needsTsc, () => {
  const root = fakeRoot({ 'x.js': 'return 1' }, { withNodeModules: false })
  try {
    const { problems } = checkWorkflowTypes(root)
    assert.match(problems.join('\n'), /ESLint, typescript-eslint or eslint-plugin-sonarjs is not installed at the repo root .* run npm ci; the engines' unsafe-any and complexity rules did not run/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an engine is held to the complexity bars lint holds lib/ to, its top-level body included', needsTsc, () => {
  const ifs = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => `if (x === ${i}) return ${i}`)
  const run = (/** @type {string} */ src, /** @type {(p: string[]) => void} */ expect) => {
    const root = fakeRoot({ 'x.js': src })
    try { expect(checkWorkflowTypes(root).problems) } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
  const head = ['/** @type {number} */', 'const x = Number(args)']
  // Ten branches make cyclomatic 11 (one more than the bar); at nine the engine passes.
  run([...head, 'function f(/** @type {number} */ x) {', ...ifs(10), 'return -1', '}', 'return f(x)'].join('\n'),
    p => assert.ok(p.some(l => l.startsWith('workflows/x.js:3:1 ') && /complexity of 11/.test(l)), p.join('\n')))
  run([...head, ...ifs(10), 'return -1'].join('\n'),
    p => assert.ok(p.some(l => l.startsWith('workflows/x.js (its top-level body') && /complexity of 11/.test(l)), p.join('\n')))
  run([...head, ...ifs(9), 'return -1'].join('\n'), p => assert.deepEqual(p, []))
  // Cognitive complexity counts nesting: 16 from nested ifs, cyclomatic only 7.
  const nested = ['function g(/** @type {number} */ x) {', 'if (x > 0) { if (x > 1) { if (x > 2) { if (x > 3) { if (x > 4) { return 5 } } } } }', 'if (x < 0) { return -1 }', 'return 0', '}']
  run([...head, ...nested, 'return g(x)'].join('\n'),
    p => assert.ok(p.some(l => l.startsWith('workflows/x.js:3:') && /sonarjs\/cognitive-complexity/.test(l)), p.join('\n')))
})
