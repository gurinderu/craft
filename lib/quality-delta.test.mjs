import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ESLint } from 'eslint'
import { risers, setDelta, renderSummary, parseArgs } from './quality-delta.mjs'
import { measureCheckout } from './quality-measure.mjs'
import { lintScope } from './quality-result.mjs'
import { functionsFromMessages, lintProblems, isTestFile } from './quality-eslint.mjs'
import { typeErrorCount, testsFromVitest } from './quality-scripts.mjs'
import { knipFromJson, cyclesFromDepcruise } from './quality-readers.mjs'

/** @typedef {import('./quality-measure.mjs').Measure} Measure */
/** @typedef {import('./quality-result.mjs').Deps} Deps */
/** @typedef {import('./quality-result.mjs').LintResult} LintResult */
/** @typedef {import('./quality-result.mjs').EslintCtor} EslintCtor */

/** @param {string} key @param {number} value @param {number} [line] */
const fn = (key, value, line = 1) => ({ key, name: key, file: 'a.mjs', line, value })

/** @param {Partial<Measure>} over @returns {Measure} */
const measure = over => ({
  complexity: { status: 'ok', value: { total: 10, functions: [] } },
  cognitive: { status: 'not-measured', reason: 'eslint-plugin-sonarjs not installed' },
  lint: { status: 'ok', value: 0 },
  types: { status: 'ok', value: 0 },
  tests: { status: 'ok', value: { passed: 5, failed: 0, skipped: 0 } },
  knip: { status: 'ok', value: { files: [], exports: [], dependencies: [] } },
  cycles: { status: 'not-measured', reason: 'dependency-cruiser not in the repo' },
  ...over,
})

/** @param {string} dir */
const tmpRepo = dir => fs.mkdtempSync(path.join(os.tmpdir(), `qd-${dir}-`))

test('lintScope reads the paths of a single eslint call and refuses what it cannot reproduce', () => {
  assert.deepEqual(lintScope('eslint lib opencode/plugin knip.config.js --max-warnings 0'), ['lib', 'opencode/plugin', 'knip.config.js'])
  assert.throws(() => lintScope('eslint -c other.mjs lib'), /-c/)
  assert.throws(() => lintScope('eslint lib && tsc'), /single eslint call/)
  assert.throws(() => lintScope(undefined), /no "lint" script/)
  assert.throws(() => lintScope('eslint --max-warnings 0'), /names no paths/)
})

test('functionsFromMessages keys same-named functions by ordinal and lends names to the cognitive rule by line', () => {
  /** @type {LintResult[]} */
  const results = [{ filePath: '/r/lib/a.mjs', messages: [
    { ruleId: 'complexity', message: "Function 'f' has a complexity of 3. Maximum allowed is 0.", line: 2 },
    { ruleId: 'complexity', message: 'Arrow function has a complexity of 1. Maximum allowed is 0.', line: 5 },
    { ruleId: 'complexity', message: 'Arrow function has a complexity of 2. Maximum allowed is 0.', line: 9 },
    { ruleId: 'sonarjs/cognitive-complexity', message: 'Refactor this function to reduce its Cognitive Complexity from 4 to the 0 allowed.', line: 2 },
    { ruleId: 'no-unused-vars', message: "'x' is defined but never used.", line: 3 },
  ] }]
  const names = new Map()
  const c = functionsFromMessages(results, '/r', 'complexity', /complexity of (\d+)/, names)
  assert.equal(c.total, 6)
  assert.deepEqual(c.functions.map(f => f.key), ["lib/a.mjs Function 'f' #1", 'lib/a.mjs Arrow function #1', 'lib/a.mjs Arrow function #2'])
  const g = functionsFromMessages(results, '/r', 'sonarjs/cognitive-complexity', /Complexity from (\d+)/, names)
  assert.deepEqual(g, { total: 4, functions: [{ key: "lib/a.mjs Function 'f' #1", name: "Function 'f'", file: 'lib/a.mjs', line: 2, value: 4 }] })
  assert.equal(lintProblems(results), 1)
})

test('test files are left out of the complexity sums, not out of lint problems', () => {
  assert.equal(isTestFile('lib/a.test.mjs'), true)
  assert.equal(isTestFile('lib/a.mjs'), false)
  assert.equal(isTestFile('lib/test-utils.mjs'), false)
  /** @type {LintResult[]} */
  const results = [{ filePath: '/r/lib/a.test.mjs', messages: [
    { ruleId: 'complexity', message: "Function 'f' has a complexity of 9. Maximum allowed is 0.", line: 1 },
    { ruleId: 'no-undef', message: "'x' is not defined.", line: 2 },
  ] }]
  assert.deepEqual(functionsFromMessages(results, '/r', 'complexity', /complexity of (\d+)/), { total: 0, functions: [] })
  assert.equal(lintProblems(results), 1)
})

test('risers: any rise of an existing function, a new one only above 10, largest rise first', () => {
  const base = { total: 0, functions: [fn('up', 3), fn('down', 9), fn('same', 4), fn('bigup', 2)] }
  const head = { total: 0, functions: [fn('up', 4), fn('down', 1), fn('same', 4), fn('bigup', 8), fn('new10', 10), fn('new11', 11)] }
  assert.deepEqual(risers(base, head).map(r => [r.name, r.base, r.head, r.delta]), [
    ['new11', null, 11, 11], ['bigup', 2, 8, 6], ['up', 3, 4, 1],
  ])
})

test('setDelta names what appeared and what is gone', () => {
  assert.deepEqual(setDelta(['a', 'b'], ['b', 'c']), { appeared: ['c'], disappeared: ['a'] })
})

test('parsers: tsc and the workflow checker counted; a failing run without either is a failure to measure', () => {
  assert.equal(typeErrorCount({ status: 0, stdout: '', stderr: '' }), 0)
  assert.equal(typeErrorCount({ status: 2, stdout: 'a.ts(1,1): error TS2322: x\nb.ts(2,2): error TS7006: y', stderr: '' }), 2)
  assert.equal(typeErrorCount({ status: 1, stdout: '3 problem(s): the workflow type check did not pass', stderr: '' }), 3)
  assert.equal(typeErrorCount({ status: 1, stdout: '', stderr: 'sh: tsc: not found' }), null)
  assert.deepEqual(testsFromVitest({ numPassedTests: 7, numFailedTests: 1, numPendingTests: 2, numTodoTests: 0 }), { passed: 7, failed: 1, skipped: 2 })
  assert.equal(testsFromVitest({ tests: [] }), null)
  assert.deepEqual(knipFromJson({ issues: [{ file: 'lib/x.mjs', files: [{ name: 'lib/x.mjs' }], exports: [{ name: 'a' }], types: [{ name: 'T' }], dependencies: [] },
    { file: 'package.json', files: [], exports: [], dependencies: [{ name: 'left-pad' }] }] }),
  { files: ['lib/x.mjs'], exports: ['lib/x.mjs: T', 'lib/x.mjs: a'], dependencies: ['package.json: left-pad'] })
  assert.equal(knipFromJson('oops'), null)
  assert.equal(cyclesFromDepcruise({ modules: [{ dependencies: [{ circular: true }, { circular: false }] }, { dependencies: [{ circular: true }] }] }), 2)
  assert.equal(cyclesFromDepcruise({}), null)
})

test('renderSummary: a metric not measured or failed is said so, never 0, and the cognitive gap is named', () => {
  const base = measure({ lint: { status: 'failed', reason: 'eslint failed: boom' } })
  const head = measure({ lint: { status: 'ok', value: 2 } })
  const out = renderSummary(base, head)
  assert.match(out, /\| Lint problems \| failed to measure \| 2 \| — \|/)
  assert.match(out, /\| Cognitive complexity \(source only, tests excluded\) \| not measured \| not measured \| — \|/)
  assert.match(out, /- cognitive complexity: not measured \(eslint-plugin-sonarjs not installed\)/)
  assert.match(out, /- import cycles: not measured \(dependency-cruiser not in the repo\)/)
  assert.match(out, /- lint problems on base: eslint failed: boom/)
  assert.match(out, /\| Tests passed \| 5 \| 5 \| 0 \|/)
})

test('renderSummary lists what Knip saw appear and go', () => {
  const base = measure({ knip: { status: 'ok', value: { files: ['lib/old.mjs'], exports: [], dependencies: [] } } })
  const head = measure({ knip: { status: 'ok', value: { files: [], exports: ['lib/a.mjs: dead'], dependencies: [] } } })
  const out = renderSummary(base, head)
  assert.match(out, /unused export appeared: `lib\/a.mjs: dead`/)
  assert.match(out, /unused file gone: `lib\/old.mjs`/)
})

test('parseArgs takes --base and --head, nothing else', () => {
  assert.deepEqual(parseArgs(['--base', '/b', '--head', '/h']), { base: '/b', head: '/h' })
  assert.equal(parseArgs(['--base', '/b']), null)
  assert.equal(parseArgs(['--nope', 'x', '--head', '/h']), null)
})

/** A checkout with a package.json and an empty flat config; only the files given. @param {string} tag @param {Record<string, string>} files @param {Record<string, string>} [scripts] */
function checkout(tag, files, scripts = { lint: 'eslint src' }) {
  const dir = tmpRepo(tag)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: tag, private: true, type: 'module', scripts }))
  fs.writeFileSync(path.join(dir, 'eslint.config.mjs'), 'export default [{ rules: { "no-unused-vars": "error" } }]\n')
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

/** @param {Partial<Deps>} over @returns {Deps} */
const deps = over => ({
  run: () => { throw new Error('no command expected') },
  loadEslint: async () => /** @type {EslintCtor} */ (/** @type {unknown} */ (ESLint)),
  loadSonar: async () => null,
  ...over,
})

test('planted: a function made more complex in head is a top riser, measured by the real ESLint at threshold 0', async () => {
  const simple = 'export function route(x) {\n  if (x) return 1\n  return 0\n}\nexport const id = y => y\n'
  const complex = 'export function route(x) {\n  if (x === 1) return 1\n  if (x === 2) return 2\n  if (x === 3 && x) return 3\n  return 0\n}\nexport const id = y => y\n'
  const base = checkout('base', { 'src/a.mjs': simple })
  // The same complex function in a test file must count nowhere in the sums or the risers.
  const head = checkout('head', { 'src/a.mjs': complex, 'src/a.test.mjs': complex.replace('route', 'scaffold') })
  try {
    const b = await measureCheckout(base, deps({}))
    const h = await measureCheckout(head, deps({}))
    assert.equal(b.complexity.status === 'ok' && b.complexity.value.total, 3)
    assert.equal(h.complexity.status === 'ok' && h.complexity.value.total, 6)
    assert.deepEqual(h.lint, { status: 'ok', value: 0 })
    assert.equal(h.cognitive.status, 'not-measured')
    assert.equal(h.tests.status, 'not-measured')
    assert.equal(h.types.status, 'not-measured')
    assert.equal(h.knip.status, 'not-measured')
    assert.equal(h.cycles.status, 'not-measured')
    const out = renderSummary(b, h)
    assert.match(out, /\| Cyclomatic complexity \(source only, tests excluded\) \| 3 \| 6 \| \+3 \|/)
    assert.match(out, /\| Function 'route' \| `src\/a.mjs:1` \| 2 \| 5 \| \+3 \|/)
    assert.doesNotMatch(out, /Arrow function \|/)
    assert.doesNotMatch(out, /scaffold/)
    assert.match(out, /source only, tests excluded/)
    assert.match(out, /a riser among them can be a shifted pairing/)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(head, { recursive: true, force: true })
  }
})

test('measureCheckout: cognitive measured when the plugin loads, failed when it throws, all ESLint metrics failed without ESLint', async () => {
  const dir = checkout('fake', { 'src/a.mjs': '' })
  /** @type {EslintCtor} */
  const Fake = class { async lintFiles() { return [{ filePath: path.join(dir, 'src/a.mjs'), messages: [
    { ruleId: 'complexity', message: "Function 'f' has a complexity of 2. Maximum allowed is 0.", line: 1 },
    { ruleId: 'sonarjs/cognitive-complexity', message: 'Refactor this function to reduce its Cognitive Complexity from 3 to the 0 allowed.', line: 1 },
  ] }] } }
  try {
    const on = await measureCheckout(dir, deps({ loadEslint: async () => Fake, loadSonar: async () => ({ rules: {} }) }))
    assert.deepEqual(on.cognitive.status === 'ok' && on.cognitive.value.functions.map(f => [f.name, f.value]), [["Function 'f'", 3]])
    const broken = await measureCheckout(dir, deps({ loadEslint: async () => Fake, loadSonar: async () => { throw new Error('bad build') } }))
    assert.deepEqual(broken.cognitive, { status: 'failed', reason: 'eslint-plugin-sonarjs failed to load: bad build' })
    const none = await measureCheckout(dir, deps({ loadEslint: async () => null }))
    for (const k of /** @type {const} */ (['complexity', 'cognitive', 'lint'])) assert.equal(none[k].status, 'failed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('measureCheckout: types summed over check:types scripts; a non-Vitest test script is not measured', async () => {
  const dir = checkout('types', { 'src/a.mjs': '' }, { lint: 'eslint src', 'check:types': 'tsc', 'check:types:lib': 'tsc -p lib', test: 'node --test' })
  try {
    const m = await measureCheckout(dir, deps({
      run: (_cmd, args) => (args.includes('check:types:lib')
        ? { status: 2, stdout: 'x.mjs(1,1): error TS2322: no', stderr: '' }
        : { status: 0, stdout: '', stderr: '' }),
    }))
    assert.deepEqual(m.types, { status: 'ok', value: 1 })
    assert.deepEqual(m.tests, { status: 'not-measured', reason: '"npm test" is not Vitest (node --test)' })
    const broken = await measureCheckout(dir, deps({ run: () => ({ status: 1, stdout: '', stderr: 'tsc: not found' }) }))
    assert.equal(broken.types.status, 'failed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
