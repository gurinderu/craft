import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ESLint } from 'eslint'
import { risers, setDelta, renderSummary, parseArgs } from './quality-delta.mjs'
import { measureCheckout } from './quality-measure.mjs'
import { engineMessage, TOP_LEVEL } from './quality-engines.mjs'
import { wrapWorkflow } from './check-workflow-types.mjs'
import { lintScope } from './quality-result.mjs'
import { functionsFromMessages, lintProblems, isTestFile } from './quality-eslint.mjs'
import { typeDiagnostics, problemTotal, scriptCwd, testsFromVitest } from './quality-scripts.mjs'
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
  engines: { status: 'ok', value: { total: 4, functions: [] } },
  cognitive: { status: 'not-measured', reason: 'eslint-plugin-sonarjs not installed' },
  lint: { status: 'ok', value: 0 },
  types: { status: 'ok', value: 0 },
  engineChecks: { status: 'ok', value: 0 },
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

// Observed output of the three check:types* scripts with one error planted in opencode/plugin/run-record.mjs
// (checked by check:types and check:types:lib) and one in lib/agent-retry.mjs (inlined into an engine, so
// checked by check:types:lib and check:types:workflows): two errors, each reported twice.
const OBSERVED = {
  'check:types': { status: 2, stdout: "run-record.mjs(788,25): error TS2532: Object is possibly 'undefined'.\n", stderr: '' },
  'check:types:lib': { status: 2, stdout: "lib/agent-retry.mjs(102,25): error TS2532: Object is possibly 'undefined'.\n"
    + "opencode/plugin/run-record.mjs(788,25): error TS2532: Object is possibly 'undefined'.\n", stderr: '' },
  'check:types:workflows': { status: 1, stdout: '1 problem(s): the workflow type check did not pass\n',
    stderr: "lib/agent-retry.mjs(102,25): error TS2532: Object is possibly 'undefined'.\n" },
}
const GATE_SCRIPTS = {
  lint: 'eslint src',
  'check:types': 'npm --prefix opencode/plugin run typecheck',
  'check:types:lib': 'opencode/plugin/node_modules/.bin/tsc -p lib/tsconfig.json',
  'check:types:workflows': 'node lib/check-workflow-types.mjs',
}

test('typeDiagnostics keys tsc and workflow-checker diagnostics by repo file, line and code; problemTotal reads the total line', () => {
  const root = '/r'
  assert.deepEqual(typeDiagnostics(OBSERVED['check:types'], root, '/r/opencode/plugin'), ['opencode/plugin/run-record.mjs:788:TS2532'])
  assert.deepEqual(typeDiagnostics({ status: 1, stdout: '', stderr: "workflows/review.js:12:5 error TS2322: Type 'string' is not assignable.\n"
    + "  Types of property 'a' are incompatible.\n"
    + 'workflows/review.js (lines the checker adds: a craft-inline import or the sandbox wrapper): error TS2304: x\n'
    + 'workflows/review.js: 13 `any` (ceiling 12)\n' }, root, root),
  ['workflows/review.js:12:TS2322', 'workflows/review.js:wrapper:TS2304'])
  assert.equal(problemTotal(OBSERVED['check:types:workflows']), 1)
  assert.equal(problemTotal(OBSERVED['check:types']), null)
  assert.equal(scriptCwd('npm --prefix opencode/plugin run typecheck', root), '/r/opencode/plugin')
  assert.equal(scriptCwd('node lib/check-workflow-types.mjs', root), root)
})

test('type errors: a file checked by two scripts counts once; the engine checker\'s other problems are their own row', async () => {
  const dir = checkout('types', { 'src/a.mjs': '' }, { ...GATE_SCRIPTS, test: 'node --test' })
  /** @param {string[]} args */
  const script = args => /** @type {keyof typeof OBSERVED} */ (/** @type {string} */ (args[args.length - 1]))
  try {
    const m = await measureCheckout(dir, deps({ run: (_cmd, args) => OBSERVED[script(args)] }))
    assert.deepEqual(m.types, { status: 'ok', value: 2 })
    assert.deepEqual(m.engineChecks, { status: 'ok', value: 0 })
    assert.deepEqual(m.tests, { status: 'not-measured', reason: '"npm test" is not Vitest (node --test)' })
    // An `any` over the ceiling and a no-unsafe-* report: engine-check problems, not type errors.
    const ceiling = await measureCheckout(dir, deps({ run: (_cmd, args) => (script(args) === 'check:types:workflows'
      ? { status: 1, stdout: '2 problem(s): the workflow type check did not pass\n',
        stderr: 'workflows/review.js: 13 `any` (ceiling 12)\nworkflows/review.js:5:3 Unsafe call of a(n) `any` typed value. (@typescript-eslint/no-unsafe-call)\n' }
      : { status: 0, stdout: '', stderr: '' }) }))
    assert.deepEqual(ceiling.types, { status: 'ok', value: 0 })
    assert.deepEqual(ceiling.engineChecks, { status: 'ok', value: 2 })
    const broken = await measureCheckout(dir, deps({ run: () => ({ status: 1, stdout: '', stderr: 'tsc: not found' }) }))
    assert.equal(broken.types.status, 'failed')
    assert.equal(broken.engineChecks.status, 'failed')
    const noEngine = checkout('types2', { 'src/a.mjs': '' }, { lint: 'eslint src', 'check:types': 'tsc' })
    try {
      const n = await measureCheckout(noEngine, deps({ run: () => ({ status: 0, stdout: '', stderr: '' }) }))
      assert.deepEqual(n.engineChecks, { status: 'not-measured', reason: 'no check:types:workflows script in package.json' })
    } finally { fs.rmSync(noEngine, { recursive: true, force: true }) }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('parsers: Vitest, Knip and dependency-cruiser reports', () => {
  assert.deepEqual(testsFromVitest({ numPassedTests: 7, numFailedTests: 1, numPendingTests: 2, numTodoTests: 0 }), { passed: 7, failed: 1, skipped: 2 })
  assert.equal(testsFromVitest({ tests: [] }), null)
  assert.deepEqual(knipFromJson({ issues: [{ file: 'lib/x.mjs', files: [{ name: 'lib/x.mjs' }], exports: [{ name: 'a' }], types: [{ name: 'T' }], dependencies: [] },
    { file: 'package.json', files: [], exports: [], dependencies: [{ name: 'left-pad' }] }] }),
  { files: ['lib/x.mjs'], exports: ['lib/x.mjs: T', 'lib/x.mjs: a'], dependencies: ['package.json: left-pad'] })
  assert.equal(knipFromJson('oops'), null)
  assert.equal(cyclesFromDepcruise({ modules: [{ dependencies: [{ circular: true }, { circular: false }] }, { dependencies: [{ circular: true }] }] }), 2)
  assert.equal(cyclesFromDepcruise({}), null)
})

test('dependency-cruiser runs with the checkout\'s own .dependency-cruiser.mjs when there is one', async () => {
  const dir = checkout('cruise', { 'src/a.mjs': '', 'node_modules/.bin/depcruise': '', '.dependency-cruiser.mjs': 'export default {}\n' })
  /** @type {string[][]} */
  const calls = []
  try {
    const m = await measureCheckout(dir, deps({ run: (cmd, args) => {
      if (cmd.endsWith('depcruise')) { calls.push(args); return { status: 0, stdout: JSON.stringify({ modules: [] }), stderr: '' } }
      return { status: 0, stdout: '', stderr: '' }
    } }))
    assert.deepEqual(m.cycles, { status: 'ok', value: 0 })
    assert.deepEqual(calls, [['--config', '.dependency-cruiser.mjs', '--output-type', 'json', 'src']])
    fs.rmSync(path.join(dir, '.dependency-cruiser.mjs'))
    calls.length = 0
    await measureCheckout(dir, deps({ run: (_cmd, args) => { calls.push(args); return { status: 0, stdout: JSON.stringify({ modules: [] }), stderr: '' } } }))
    assert.deepEqual(calls, [['--output-type', 'json', 'src']])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('lint problems at the gate\'s settings: a function over the checkout\'s own complexity threshold is a lint problem', async () => {
  const complex = 'export function route(x) {\n  if (x === 1) return 1\n  if (x === 2) return 2\n  if (x === 3 && x) return 3\n  return 0\n}\n'
  /** @param {string} rules */
  const withRules = rules => {
    const dir = checkout('thr', { 'src/a.mjs': complex, 'src/a.test.mjs': complex })
    fs.writeFileSync(path.join(dir, 'eslint.config.mjs'), `export default [{ rules: ${rules} }]\n`)
    return dir
  }
  const cases = /** @type {const} */ ([
    ["{ complexity: ['error', 4] }", 2],          // 5 > 4, in the source and the test file: lint counts every linted file
    ["{ complexity: ['warn', { max: 5 }] }", 0],  // 5 is allowed
    ["{ complexity: 'off' }", 0],
    ["{ complexity: 'error' }", 0],               // ESLint's default threshold, 20
    ['{}', 0],
  ])
  for (const [rules, want] of cases) {
    const dir = withRules(rules)
    try {
      const m = await measureCheckout(dir, deps({}))
      assert.deepEqual(m.lint, { status: 'ok', value: want }, rules)
      assert.equal(m.complexity.status === 'ok' && m.complexity.value.total, 5, rules)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('lint problems: a cognitive value over the sonarjs threshold the checkout configures is a lint problem', async () => {
  const dir = checkout('cog', { 'src/a.mjs': '' })
  const file = path.join(dir, 'src/a.mjs')
  /** @param {unknown} rules @returns {EslintCtor} */
  const fake = rules => class {
    async lintText() { return [] }
    async calculateConfigForFile() { return { rules } }
    async lintFiles() { return [{ filePath: file, messages: [
      { ruleId: 'complexity', message: "Function 'f' has a complexity of 2. Maximum allowed is 0.", line: 1 },
      { ruleId: 'sonarjs/cognitive-complexity', message: 'Refactor this function to reduce its Cognitive Complexity from 16 to the 0 allowed.', line: 1 },
    ] }] }
  }
  try {
    const sonar = { loadSonar: async () => ({ rules: {} }) }
    const at15 = await measureCheckout(dir, deps({ ...sonar, loadEslint: async () => fake({ 'sonarjs/cognitive-complexity': ['error', 15] }) }))
    assert.deepEqual(at15.lint, { status: 'ok', value: 1 })
    const dflt = await measureCheckout(dir, deps({ ...sonar, loadEslint: async () => fake({ 'sonarjs/cognitive-complexity': [2] }) }))
    assert.deepEqual(dflt.lint, { status: 'ok', value: 1 })   // sonarjs's default threshold, 15
    const off = await measureCheckout(dir, deps({ ...sonar, loadEslint: async () => fake({ 'sonarjs/cognitive-complexity': [0, 15] }) }))
    assert.deepEqual(off.lint, { status: 'ok', value: 0 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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
  loadWrapper: async () => null,
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
  const Fake = class { async lintText() { return [] } async calculateConfigForFile() { return {} } async lintFiles() { return [{ filePath: path.join(dir, 'src/a.mjs'), messages: [
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

test('engineMessage maps a wrapped line back to the engine, and the wrapper to its top level', () => {
  const m = { ruleId: 'complexity', message: "Function 'g' has a complexity of 2. Maximum allowed is 0.", line: 9 }
  assert.deepEqual(engineMessage(m, 4, 20, 3), { ...m, line: 5 })
  const top = { ruleId: 'complexity', message: "Async function '__wf' has a complexity of 3. Maximum allowed is 0.", line: 3 }
  assert.deepEqual(engineMessage(top, 4, 20, 3), { ...top, line: 1, message: `${TOP_LEVEL} has a complexity of 3. Maximum allowed is 0.` })
  // The wrapper's `void (() => meta)` closure is not engine code.
  assert.equal(engineMessage({ ruleId: 'complexity', message: 'Arrow function has a complexity of 1. Maximum allowed is 0.', line: 4 }, 4, 20, 3), null)
})

test('planted: an engine (workflows/*.js) is measured through the real wrapper, its functions at their engine line', async () => {
  const engine = (/** @type {string} */ extra) => [
    "export const meta = { name: 'e', description: 'planted' }",
    'const n = args.n',
    'if (n > 1) log("many")',
    'function pick(a) {',
    '  if (a === 1) return 1',
    `  ${extra}`,
    '  return 0',
    '}',
    'return pick(n)',
    '',
  ].join('\n')
  const base = checkout('ebase', { 'src/a.mjs': '', 'workflows/e.js': engine('') })
  const head = checkout('ehead', { 'src/a.mjs': '', 'workflows/e.js': engine('if (a === 2 || a === 3) return 2') })
  const real = deps({ loadWrapper: async () => wrapWorkflow })
  try {
    const b = await measureCheckout(base, real)
    const h = await measureCheckout(head, real)
    assert.deepEqual(h.engines.status === 'ok' && h.engines.value.functions.map(f => [f.name, f.file, f.line, f.value]), [
      [TOP_LEVEL, 'workflows/e.js', 1, 2], ["Function 'pick'", 'workflows/e.js', 4, 4],
    ])
    assert.equal(h.complexity.status === 'ok' && h.complexity.value.total, 6)
    const out = renderSummary(b, h)
    assert.match(out, /\| … of which engines \(workflows\/\*\.js\) \| 4 \| 6 \| \+2 \|/)
    assert.match(out, /\| Function 'pick' \| `workflows\/e.js:4` \| 2 \| 4 \| \+2 \|/)
    // Without the checkout's wrapper the engines are said to be unmeasured, never silently left out.
    const none = renderSummary(await measureCheckout(base, deps({})), await measureCheckout(head, deps({})))
    assert.match(none, /- engines \(workflows\/\*\.js\): not measured \(the checkout has no engine wrapper/)
    assert.match(none, /\| … of which engines \(workflows\/\*\.js\) \| not measured \| not measured \| — \|/)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(head, { recursive: true, force: true })
  }
})
