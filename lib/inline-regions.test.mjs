import { test } from 'vitest'
import assert from 'node:assert/strict'
import { extractDeclaration, renderRegion, findRegions, lineDiff, checkAll, unresolvedSiblings, typedScopeProblems, ROOT, STRICT_FLAGS, STRICT_OFF_FLAGS } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = loadTypescript(ROOT)
// Without the pinned compiler the directive checks skip locally; CI installs it, so there they run.
const needsTs = ts || process.env['CI'] ? {} : { skip: true }
const TS = /** @type {NonNullable<typeof ts>} */ (ts)

const SRC = [
  '// leading note',
  '// second line',
  'export function alpha(x) {',
  '  return `}` + x  // a brace in a template literal must not end the slice',
  '}',
  '',
  'export const BETA = { a: 1 }',
  '',
  'export const DELTA = new Set([',
  "  'a', 'b',",
  '  // a comment inside the table travels with it',
  "  'c',",
  '])',
  '',
  'export function gamma() {',
  '  return /}/.test("}")',
  '}',
  '',
].join('\n')

test('extracts a function with its leading comment block and drops `export`', () => {
  assert.equal(extractDeclaration(SRC, 'alpha'), [
    '// leading note',
    '// second line',
    'function alpha(x) {',
    '  return `}` + x  // a brace in a template literal must not end the slice',
    '}',
  ].join('\n'))
})

test('braces inside strings, template literals and regexes do not confuse the slicer', () => {
  assert.equal(extractDeclaration(SRC, 'gamma'), 'function gamma() {\n  return /}/.test("}")\n}')
})

test('extracts a single-line const', () => {
  assert.equal(extractDeclaration(SRC, 'BETA'), 'const BETA = { a: 1 }')
})

test('extracts a multi-line const table, ending at its closer at column 0', () => {
  assert.equal(extractDeclaration(SRC, 'DELTA'), [
    'const DELTA = new Set([',
    "  'a', 'b',",
    '  // a comment inside the table travels with it',
    "  'c',",
    '])',
  ].join('\n'))
})

test('a multi-line const with no closer at column 0 fails loudly', () => {
  assert.throws(
    () => extractDeclaration("export const OPEN = new Set([\n  'a',", 'OPEN'),
    /unterminated const 'OPEN'/,
  )
})

test('a one-line function ends on its own line; a multi-line one with no `}` at column 0 fails loudly', () => {
  assert.equal(extractDeclaration('/** @param {number} x */\nexport function one(x) { return x }\nexport const NEXT = 1\n}', 'one'), '/** @param {number} x */\nfunction one(x) { return x }')
  assert.throws(() => extractDeclaration('export function open(x) {\n  return x\n  }', 'open'), /unterminated function 'open'/)
})

test('a multi-line const whose brackets do not balance at its closer fails loudly', () => {
  assert.throws(() => extractDeclaration('export const T = new Set([\n  ([\n])', 'T'), /multi-line const 'T' is not extractable/)
})

test('a ` */` line not opened by `/**` above it stops the comment walk', () => {
  assert.equal(extractDeclaration('// note\n/* plain\n */\nexport const A = 1', 'A'), 'const A = 1')
})

test('an unknown name is an error, not a silent empty region', () => {
  assert.throws(() => extractDeclaration(SRC, 'delta'), /no exported declaration named 'delta'/)
})

test('a rendered region is valid JS and joins entries with one blank line', () => {
  assert.equal(renderRegion(SRC, ['BETA', 'gamma']), 'const BETA = { a: 1 }\n\nfunction gamma() {\n  return /}/.test("}")\n}')
})

test('findRegions reads the fence header and the exact bytes between the fences', () => {
  const text = [
    'before',
    '// >>> craft-inline lib/run-record.mjs alpha beta',
    'body line',
    '// <<< craft-inline',
    'after',
  ].join('\n')
  const [r] = findRegions(text)
  assert.ok(r)
  assert.equal(r.source, 'lib/run-record.mjs')
  assert.deepEqual(r.names, ['alpha', 'beta'])
  assert.equal(r.actual, 'body line')
})

test('an unclosed fence fails loudly', () => {
  assert.throws(() => findRegions('// >>> craft-inline lib/run-record.mjs alpha\nbody'), /unclosed craft-inline fence/)
})

test('lineDiff shows the drifted line on both sides', () => {
  assert.equal(lineDiff('a\nb', 'a\nc'), '    - c\n    + b')
})

// Reads lib/ source as text, which Stryker rewrites with its mutant switches: skipped under mutation testing only.
test.skipIf(process.env['STRYKER_MUTATOR_WORKER'] !== undefined)('every inlined region in workflows/ currently matches lib/', () => {
  const res = checkAll()
  assert.deepEqual(res.mismatches, [])
  assert.ok(res.regionCount > 0, 'expected at least one fenced region')
})

// The gate that a green run hid. `usableVote` was added to lib/adversarial-judge.mjs and called from
// `judgeVotes`, but the fence header still named only `judgeVotes` — so the workflow carried a call
// to a function it never defined. `check-workflows` printed "13 inlined region(s) match their
// source" and every unit test passed, because the tests import the lib copy where the definition
// exists and the region really did match the declarations it was told to name. A free identifier is
// a runtime error in JavaScript, so the script parsed too. It would have died at the first call,
// after the whole agent spend and before the run record was written.
test('a region calling a sibling export the fence does not carry is reported', () => {
  const source = `export function helper(x) { return x }\nexport function main(x) { return helper(x) }\n`
  const text = [
    '// >>> craft-inline lib/fake.mjs main',
    'function main(x) { return helper(x) }',
    '// <<< craft-inline',
  ].join('\n')
  const found = unresolvedSiblings(text, findRegions(text), () => source)
  assert.deepEqual(found.map(f => f.name), ['helper'])
})

test('it stays quiet when the fence carries the sibling, or the workflow declares it itself', () => {
  const source = `export function helper(x) { return x }\nexport function main(x) { return helper(x) }\n`
  const carried = [
    '// >>> craft-inline lib/fake.mjs helper main',
    'function helper(x) { return x }',
    'function main(x) { return helper(x) }',
    '// <<< craft-inline',
  ].join('\n')
  assert.deepEqual(unresolvedSiblings(carried, findRegions(carried), () => source), [])

  const declaredOutside = `function helper(x) { return x }\n${['// >>> craft-inline lib/fake.mjs main', 'function main(x) { return helper(x) }', '// <<< craft-inline'].join('\n')}`
  assert.deepEqual(unresolvedSiblings(declaredOutside, findRegions(declaredOutside), () => source), [])
})

test('a sibling named only in a comment is prose, not a call', () => {
  // A marker that fires on a mention would be one people stop reading — the same rule as everywhere
  // else here: it must fire on the failure and stay silent on the healthy case.
  const source = `export function helper(x) { return x }\nexport function main(x) { return x }\n`
  const text = [
    '// >>> craft-inline lib/fake.mjs main',
    '// helper(0) used to be called here, and is not any more',
    'function main(x) { return x }',
    '// <<< craft-inline',
  ].join('\n')
  assert.deepEqual(unresolvedSiblings(text, findRegions(text), () => source), [])
})

test('a JSDoc between the comment block and the declaration does not cut the comment block off', () => {
  const src = [
    '// why it exists',
    '/** @param {string} x */',
    'export function one(x) {',
    '  return x',
    '}',
    '',
    '// why the other exists',
    '/**',
    ' * @param {number} n',
    ' * @returns {number}',
    ' */',
    'export function two(n) {',
    '  return n',
    '}',
  ].join('\n')
  assert.equal(extractDeclaration(src, 'one'), '// why it exists\n/** @param {string} x */\nfunction one(x) {\n  return x\n}')
  assert.equal(extractDeclaration(src, 'two'), [
    '// why the other exists', '/**', ' * @param {number} n', ' * @returns {number}', ' */',
    'function two(n) {', '  return n', '}',
  ].join('\n'))
})

test('stacked JSDoc blocks all travel with the declaration, and the comment above them too', () => {
  const src = [
    '// why',
    '/**',
    ' * What it does.',
    ' */',
    '/** @param {string} x */',
    'export function three(x) {',
    '  return x',
    '}',
  ].join('\n')
  assert.equal(extractDeclaration(src, 'three'), [
    '// why', '/**', ' * What it does.', ' */', '/** @param {string} x */', 'function three(x) {', '  return x', '}',
  ].join('\n'))
})

test('a JSDoc that closes on a content line still carries the comment above it', () => {
  const src = [
    '// why',
    '/** @param {string} x  the input',
    ' * @returns {string} */',
    'export function four(x) {',
    '  return x',
    '}',
  ].join('\n')
  assert.equal(extractDeclaration(src, 'four'), [
    '// why', '/** @param {string} x  the input', ' * @returns {string} */', 'function four(x) {', '  return x', '}',
  ].join('\n'))
})


test('an inlined source the strict type check does not read, or that suppresses it, is named', needsTs, () => {
  const ROOTDIR = '/r'
  const strictConfig = { compilerOptions: { ...Object.fromEntries(['strict', ...STRICT_FLAGS].map(k => [k, true])), ...Object.fromEntries(STRICT_OFF_FLAGS.map(k => [k, false])), allowJs: true, checkJs: true } }
  const files = ['/r/lib/a.mjs', '/r/lib/b.mjs']
  const read = (/** @type {string} */ s) => (s === 'lib/b.mjs' ? '// @ts-ignore\nx' : 'ok')
  const run = (/** @type {Partial<Parameters<typeof typedScopeProblems>[0]>} */ over) =>
    typedScopeProblems({ root: ROOTDIR, sources: ['lib/a.mjs'], typedFiles: files, config: strictConfig, readSource: read, ts: TS, ...over })
  assert.deepEqual(run({}), [])
  assert.match(run({ sources: ['lib/a.mjs', 'lib/../x.mjs'] }).join('\n'), /x\.mjs.*not a non-test lib module/)
  assert.match(run({ sources: ['lib/.c.mjs'] }).join('\n'), /\.c\.mjs.*not a non-test lib module/)
  assert.match(run({ sources: ['lib/z.mjs'] }).join('\n'), /z\.mjs.*not read by the strict type check/)
  assert.match(run({ sources: ['lib/b.mjs'] }).join('\n'), /b\.mjs.*@ts-ignore/)
  assert.match(run({ config: { compilerOptions: { ...strictConfig.compilerOptions, strict: false } } }).join('\n'), /strict is not on/)
  assert.match(run({ config: { compilerOptions: { strict: true } } }).join('\n'), /noUncheckedIndexedAccess is not on/)
  assert.match(run({ config: { compilerOptions: { ...strictConfig.compilerOptions, checkJs: false } } }).join('\n'), /checkJs is not on/)
  assert.match(run({ config: { compilerOptions: { ...strictConfig.compilerOptions, allowUnreachableCode: undefined } } }).join('\n'), /allowUnreachableCode is not false/)
  assert.match(run({ config: { compilerOptions: { ...strictConfig.compilerOptions, allowUnusedLabels: true } } }).join('\n'), /allowUnusedLabels is not false/)
  assert.match(run({ config: { compilerOptions: { ...strictConfig.compilerOptions, noImplicitAny: false } } }).join('\n'), /noImplicitAny is turned off/)
})

test('an inlined source is refused for the directives tsc honours, and only those', needsTs, () => {
  const strictConfig = { compilerOptions: { ...Object.fromEntries(['strict', ...STRICT_FLAGS].map(k => [k, true])), ...Object.fromEntries(STRICT_OFF_FLAGS.map(k => [k, false])), allowJs: true, checkJs: true } }
  const run = (/** @type {string} */ text) =>
    typedScopeProblems({ root: '/r', sources: ['lib/a.mjs'], typedFiles: ['/r/lib/a.mjs'], config: strictConfig, readSource: () => text, ts: TS })
  // tsc honours a directive glued to more letters; a word-boundary regex did not see it.
  assert.deepEqual(run('// @ts-ignorefoo\nconst a = 1'), ['lib/a.mjs:1 switches the type check off with @ts-ignore (inlined into workflows/)'])
  assert.deepEqual(run('const a = 1\n// @ts-expect-errorx\nconst b = 2'), ['lib/a.mjs:2 switches the type check off with @ts-expect-error (inlined into workflows/)'])
  assert.deepEqual(run('// @ts-nocheck\nconst a = 1'), ['lib/a.mjs:1 switches the type check off with @ts-nocheck (inlined into workflows/)'])
  // A mention tsc does not read as a directive switches nothing off.
  assert.deepEqual(run('const s = "@ts-ignore"\n// note @ts-ignore\nconst a = 1'), [])
})

test('a test file or a path outside lib/ is never an acceptable inline source, even when tsc reads it', needsTs, () => {
  const strictConfig = { compilerOptions: { ...Object.fromEntries(['strict', ...STRICT_FLAGS].map(k => [k, true])), ...Object.fromEntries(STRICT_OFF_FLAGS.map(k => [k, false])), allowJs: true, checkJs: true } }
  // tsc's list now holds the tests and the OpenCode run-record (lib/tsconfig.json reads both).
  const typedFiles = ['/r/lib/a.mjs', '/r/lib/a.test.mjs', '/r/opencode/plugin/run-record.mjs']
  const run = (/** @type {string[]} */ sources) => typedScopeProblems({ root: '/r', sources, typedFiles, config: strictConfig, readSource: () => 'ok', ts: TS })
  assert.deepEqual(run(['lib/a.mjs']), [])
  assert.match(run(['lib/a.test.mjs']).join('\n'), /a\.test\.mjs.*not a non-test lib module/)
  assert.match(run(['opencode/plugin/run-record.mjs']).join('\n'), /run-record\.mjs.*not a non-test lib module/)
})
