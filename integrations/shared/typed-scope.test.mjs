// How far the strict type check reaches (integrations/shared/typed-scope.mjs): which integrations/shared/ modules a bundled engine may carry,
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
  const strictConfig = {
    compilerOptions: {
      ...Object.fromEntries(['strict', ...STRICT_FLAGS].map(k => [k, true])),
      ...Object.fromEntries(STRICT_OFF_FLAGS.map(k => [k, false])),
      allowJs: true,
      checkJs: true,
    },
  }
  const files = ['/r/integrations/shared/a.mjs', '/r/integrations/shared/b.mjs']
  const read = (/** @type {string} */ s) => (s === 'integrations/shared/b.mjs' ? '// @ts-ignore\nx' : 'ok')
  const run = (/** @type {Partial<Parameters<typeof typedScopeProblems>[0]>} */ over) =>
    typedScopeProblems({ root: ROOTDIR, sources: ['integrations/shared/a.mjs'], typedFiles: files, config: strictConfig, readSource: read, ts: TS, ...over })
  assert.deepEqual(run({}), [])
  assert.match(run({ sources: ['integrations/shared/a.mjs', 'integrations/shared/../x.mjs'] }).join('\n'), /x\.mjs.*not a non-test lib module/)
  assert.match(run({ sources: ['integrations/shared/.c.mjs'] }).join('\n'), /\.c\.mjs.*not a non-test lib module/)
  assert.match(run({ sources: ['integrations/shared/z.mjs'] }).join('\n'), /z\.mjs.*not read by the strict type check/)
  assert.match(run({ sources: ['integrations/shared/b.mjs'] }).join('\n'), /b\.mjs.*@ts-ignore/)
  assert.match(run({ config: { compilerOptions: { ...strictConfig.compilerOptions, strict: false } } }).join('\n'), /strict is not on/)
  assert.match(run({ config: { compilerOptions: { strict: true } } }).join('\n'), /noUncheckedIndexedAccess is not on/)
  assert.match(run({ config: { compilerOptions: { ...strictConfig.compilerOptions, checkJs: false } } }).join('\n'), /checkJs is not on/)
  assert.match(
    run({ config: { compilerOptions: { ...strictConfig.compilerOptions, allowUnreachableCode: undefined } } }).join('\n'),
    /allowUnreachableCode is not false/,
  )
  assert.match(run({ config: { compilerOptions: { ...strictConfig.compilerOptions, allowUnusedLabels: true } } }).join('\n'), /allowUnusedLabels is not false/)
  assert.match(run({ config: { compilerOptions: { ...strictConfig.compilerOptions, noImplicitAny: false } } }).join('\n'), /noImplicitAny is turned off/)
})

test('a bundled source is refused for the directives tsc honours, and only those', needsTs, () => {
  const strictConfig = {
    compilerOptions: {
      ...Object.fromEntries(['strict', ...STRICT_FLAGS].map(k => [k, true])),
      ...Object.fromEntries(STRICT_OFF_FLAGS.map(k => [k, false])),
      allowJs: true,
      checkJs: true,
    },
  }
  const run = (/** @type {string} */ text) =>
    typedScopeProblems({
      root: '/r',
      sources: ['integrations/shared/a.mjs'],
      typedFiles: ['/r/integrations/shared/a.mjs'],
      config: strictConfig,
      readSource: () => text,
      ts: TS,
    })
  // tsc honours a directive glued to more letters; a word-boundary regex did not see it.
  assert.deepEqual(run('// @ts-ignorefoo\nconst a = 1'), [
    'integrations/shared/a.mjs:1 switches the type check off with @ts-ignore (bundled into integrations/claude-code/workflows/)',
  ])
  assert.deepEqual(run('const a = 1\n// @ts-expect-errorx\nconst b = 2'), [
    'integrations/shared/a.mjs:2 switches the type check off with @ts-expect-error (bundled into integrations/claude-code/workflows/)',
  ])
  assert.deepEqual(run('// @ts-nocheck\nconst a = 1'), [
    'integrations/shared/a.mjs:1 switches the type check off with @ts-nocheck (bundled into integrations/claude-code/workflows/)',
  ])
  // A mention tsc does not read as a directive switches nothing off.
  assert.deepEqual(run('const s = "@ts-ignore"\n// note @ts-ignore\nconst a = 1'), [])
})

test('a test file or a path outside integrations/shared/ is never an acceptable bundled source, even when tsc reads it', needsTs, () => {
  const strictConfig = {
    compilerOptions: {
      ...Object.fromEntries(['strict', ...STRICT_FLAGS].map(k => [k, true])),
      ...Object.fromEntries(STRICT_OFF_FLAGS.map(k => [k, false])),
      allowJs: true,
      checkJs: true,
    },
  }
  // tsc's list now holds the tests and the OpenCode run-record (integrations/shared/tsconfig.json reads both).
  const typedFiles = ['/r/integrations/shared/a.mjs', '/r/integrations/shared/a.test.mjs', '/r/integrations/opencode/plugin/run-record.mjs']
  const run = (/** @type {string[]} */ sources) => typedScopeProblems({ root: '/r', sources, typedFiles, config: strictConfig, readSource: () => 'ok', ts: TS })
  assert.deepEqual(run(['integrations/shared/a.mjs']), [])
  assert.match(run(['integrations/shared/a.test.mjs']).join('\n'), /a\.test\.mjs.*not a non-test lib module/)
  assert.match(run(['integrations/opencode/plugin/run-record.mjs']).join('\n'), /run-record\.mjs.*not a non-test lib module/)
})

const STRICT = {
  compilerOptions: {
    ...Object.fromEntries(['strict', ...STRICT_FLAGS].map(k => [k, true])),
    ...Object.fromEntries(STRICT_OFF_FLAGS.map(k => [k, false])),
    allowJs: true,
    checkJs: true,
  },
}

test(
  'typedScopeProblems: a lib module in a subdirectory is one; a path that only contains integrations/shared/ or runs past .mjs is not; problems in path order',
  needsTs,
  () => {
    /** @param {string[]} sources @param {string[]} typed */
    const run = (sources, typed) => typedScopeProblems({ root: '/r', sources, typedFiles: typed, config: STRICT, readSource: () => 'ok', ts: TS })
    assert.deepEqual(run(['integrations/shared/sub/abc.mjs'], ['/r/integrations/shared/sub/abc.mjs']), [])
    assert.match(
      run(['src/integrations/shared/a.mjs'], ['/r/src/integrations/shared/a.mjs']).join('\n'),
      /src\/integrations\/shared\/a\.mjs is bundled into integrations\/claude-code\/workflows\/ but is not a non-test lib module/,
    )
    assert.match(
      run(['integrations/shared/a.mjs.txt'], ['/r/integrations/shared/a.mjs.txt']).join('\n'),
      /integrations\/shared\/a\.mjs\.txt is bundled into integrations\/claude-code\/workflows\/ but is not a non-test lib module/,
    )
    assert.deepEqual(
      run(['integrations/shared/z.mjs', 'integrations/shared/y.mjs'], []).map(p => p.split(' ')[0]),
      ['integrations/shared/y.mjs', 'integrations/shared/z.mjs'],
    )
  },
)
