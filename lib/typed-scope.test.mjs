// How far the strict type check reaches (lib/typed-scope.mjs): which lib/ modules a bundled engine may carry,
// and the directives that would switch the check off in one.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ROOT } from './repo-root.mjs'
import { STRICT_FLAGS, STRICT_OFF_FLAGS, typedScopeProblems } from './typed-scope.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = loadTypescript(ROOT)
// Without the pinned compiler the directive checks skip locally; CI installs it, so there they run.
const needsTs = ts || process.env['CI'] ? {} : { skip: true }
const TS = /** @type {NonNullable<typeof ts>} */ (ts)

test('a bundled source the strict type check does not read, or that suppresses it, is named', needsTs, () => {
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

test('a bundled source is refused for the directives tsc honours, and only those', needsTs, () => {
  const strictConfig = { compilerOptions: { ...Object.fromEntries(['strict', ...STRICT_FLAGS].map(k => [k, true])), ...Object.fromEntries(STRICT_OFF_FLAGS.map(k => [k, false])), allowJs: true, checkJs: true } }
  const run = (/** @type {string} */ text) =>
    typedScopeProblems({ root: '/r', sources: ['lib/a.mjs'], typedFiles: ['/r/lib/a.mjs'], config: strictConfig, readSource: () => text, ts: TS })
  // tsc honours a directive glued to more letters; a word-boundary regex did not see it.
  assert.deepEqual(run('// @ts-ignorefoo\nconst a = 1'), ['lib/a.mjs:1 switches the type check off with @ts-ignore (bundled into workflows/)'])
  assert.deepEqual(run('const a = 1\n// @ts-expect-errorx\nconst b = 2'), ['lib/a.mjs:2 switches the type check off with @ts-expect-error (bundled into workflows/)'])
  assert.deepEqual(run('// @ts-nocheck\nconst a = 1'), ['lib/a.mjs:1 switches the type check off with @ts-nocheck (bundled into workflows/)'])
  // A mention tsc does not read as a directive switches nothing off.
  assert.deepEqual(run('const s = "@ts-ignore"\n// note @ts-ignore\nconst a = 1'), [])
})

test('a test file or a path outside lib/ is never an acceptable bundled source, even when tsc reads it', needsTs, () => {
  const strictConfig = { compilerOptions: { ...Object.fromEntries(['strict', ...STRICT_FLAGS].map(k => [k, true])), ...Object.fromEntries(STRICT_OFF_FLAGS.map(k => [k, false])), allowJs: true, checkJs: true } }
  // tsc's list now holds the tests and the OpenCode run-record (lib/tsconfig.json reads both).
  const typedFiles = ['/r/lib/a.mjs', '/r/lib/a.test.mjs', '/r/opencode/plugin/run-record.mjs']
  const run = (/** @type {string[]} */ sources) => typedScopeProblems({ root: '/r', sources, typedFiles, config: strictConfig, readSource: () => 'ok', ts: TS })
  assert.deepEqual(run(['lib/a.mjs']), [])
  assert.match(run(['lib/a.test.mjs']).join('\n'), /a\.test\.mjs.*not a non-test lib module/)
  assert.match(run(['opencode/plugin/run-record.mjs']).join('\n'), /run-record\.mjs.*not a non-test lib module/)
})

const STRICT = { compilerOptions: { ...Object.fromEntries(['strict', ...STRICT_FLAGS].map(k => [k, true])), ...Object.fromEntries(STRICT_OFF_FLAGS.map(k => [k, false])), allowJs: true, checkJs: true } }

test('typedScopeProblems: a lib module in a subdirectory is one; a path that only contains lib/ or runs past .mjs is not; problems in path order', needsTs, () => {
  /** @param {string[]} sources @param {string[]} typed */
  const run = (sources, typed) => typedScopeProblems({ root: '/r', sources, typedFiles: typed, config: STRICT, readSource: () => 'ok', ts: TS })
  assert.deepEqual(run(['lib/sub/abc.mjs'], ['/r/lib/sub/abc.mjs']), [])
  assert.match(run(['src/lib/a.mjs'], ['/r/src/lib/a.mjs']).join('\n'), /src\/lib\/a\.mjs is bundled into workflows\/ but is not a non-test lib module/)
  assert.match(run(['lib/a.mjs.txt'], ['/r/lib/a.mjs.txt']).join('\n'), /lib\/a\.mjs\.txt is bundled into workflows\/ but is not a non-test lib module/)
  assert.deepEqual(run(['lib/z.mjs', 'lib/y.mjs'], []).map(p => p.split(' ')[0]), ['lib/y.mjs', 'lib/z.mjs'])
})
