// The engine lint loads ESLint and typescript-eslint from the repo root's own node_modules, never a
// parent directory's: a checkout nested inside another (.claude/worktrees/*) must not lint with the
// outer checkout's packages.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadEngineLinter, unsafeAnyProblems } from './engine-lint.mjs'
import { ROOT } from './inline-regions.mjs'

// Without the root install these skip locally; in CI they run and fail, so a missing install is never a
// green run (Vitest's skip option carries no reason to report). Needs npm ci.
const needsRootInstall = fs.existsSync(path.join(ROOT, 'node_modules', 'eslint', 'package.json')) || process.env['CI'] ? {} : { skip: true }

test('a root without its own install fails closed, even under a parent that has ESLint', needsRootInstall, () => {
  // Nested under this checkout, whose node_modules holds ESLint: a parent-walking lookup would find it.
  const nested = fs.mkdtempSync(path.join(ROOT, '.engine-lint-nested-'))
  try {
    fs.writeFileSync(path.join(nested, 'package.json'), '{"private":true}')
    const got = loadEngineLinter(nested)
    assert.equal(typeof got, 'string', 'the parent checkout\'s ESLint was used')
    assert.match(String(got), /node_modules\/eslint/)
    assert.match(String(got), /run npm ci/)
  } finally { fs.rmSync(nested, { recursive: true, force: true }) }
})

test('a root with its own install loads its linter', needsRootInstall, () => {
  assert.notEqual(typeof loadEngineLinter(ROOT), 'string')
})

/** A scratch root holding the three packages; `main` is each one's entry source. @param {string} main @returns {string} */
function rootWithPackages(main) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-englint-'))
  for (const n of ['eslint', 'typescript-eslint', 'eslint-plugin-sonarjs']) {
    fs.mkdirSync(path.join(root, 'node_modules', n), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', n, 'package.json'), JSON.stringify({ name: n, main: 'index.js' }))
    fs.writeFileSync(path.join(root, 'node_modules', n, 'index.js'), main)
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}')
  return root
}

test('a package directory without its package.json is absent, and named', () => {
  const root = rootWithPackages('module.exports = {}')
  try {
    fs.rmSync(path.join(root, 'node_modules', 'typescript-eslint', 'package.json'))
    assert.match(String(loadEngineLinter(root)), /\(node_modules\/typescript-eslint absent\) — run npm ci/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an install that is there but fails to load is reported with its first line, not thrown', () => {
  const root = rootWithPackages("throw new Error('boom\\nsecond line')")
  try {
    const got = loadEngineLinter(root)
    assert.equal(typeof got, 'string')
    assert.match(String(got), /is not installed at the repo root \(boom\) — run npm ci; the engines' unsafe-any and complexity rules did not run$/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the root linter runs flat config: a rule handed to it reports', needsRootInstall, () => {
  const got = loadEngineLinter(ROOT)
  assert.notEqual(typeof got, 'string')
  const { linter } = /** @type {import('./engine-lint.mjs').EngineLinter} */ (got)
  const messages = linter.verify('export function f(a) { if (a) a() }\n', [{ files: ['**/*.mjs'], rules: { complexity: ['error', 1] } }], { filename: 'x.mjs' })
  assert.deepEqual(messages.map(m => m.ruleId), ['complexity'])
})

/** @typedef {import('./engine-lint.mjs').LintMessage} LintMessage */
/**
 * An engine linter whose verify returns `messages` (or throws one), and a program holding `files`.
 * @param {LintMessage[] | Error} messages @param {string[]} files
 */
function fakes(messages, files) {
  /** @type {unknown[]} */
  const seen = []
  const engineLinter = {
    linter: {
      verify: (/** @type {string} */ text, /** @type {unknown} */ config, /** @type {{ filename: string }} */ o) => {
        seen.push([text, config, o.filename])
        if (messages instanceof Error) throw messages
        return messages
      },
    },
    config: (/** @type {unknown} */ program) => [{ program }],
  }
  const program = { getSourceFile: (/** @type {string} */ f) => (files.includes(f) ? { text: `text of ${f}` } : undefined) }
  return { engineLinter, program, seen }
}

const AT = { file: 'workflows/e.js', offset: 3, lines: 10 }

test('unsafeAnyProblems: each message at its line of the engine, or named as the wrapper\'s or the top-level body\'s', () => {
  /** @param {number} line @param {string | null} ruleId @returns {LintMessage} */
  const msg = (line, ruleId) => ({ ruleId, message: `m${line}`, line, column: 5 })
  const { engineLinter, program, seen } = fakes([
    msg(4, '@typescript-eslint/no-unsafe-call'), msg(13, '@typescript-eslint/no-unsafe-call'), msg(3, '@typescript-eslint/no-unsafe-call'),
    msg(14, 'complexity'), msg(2, null),
  ], ['/w/e.mjs'])
  assert.deepEqual(unsafeAnyProblems(engineLinter, program, new Map([['/w/e.mjs', AT]])), [
    'workflows/e.js:1:5 m4 (@typescript-eslint/no-unsafe-call)',
    'workflows/e.js:10:5 m13 (@typescript-eslint/no-unsafe-call)',
    'workflows/e.js (lines the checker adds: a craft-inline import or the sandbox wrapper) m3 (@typescript-eslint/no-unsafe-call)',
    'workflows/e.js (its top-level body, run as the sandbox\'s async function) m14 (complexity)',
    'workflows/e.js (lines the checker adds: a craft-inline import or the sandbox wrapper) m2',
  ])
  assert.deepEqual(seen, [['text of /w/e.mjs', [{ program }], '/w/e.mjs']])
})

test('unsafeAnyProblems: an engine missing from the program, or a linter that throws, is a problem, never a skip', () => {
  const missing = fakes([], [])
  assert.deepEqual(unsafeAnyProblems(missing.engineLinter, missing.program, new Map([['/w/e.mjs', AT]])),
    ['workflows/e.js: not in the compiled program, so the unsafe-any and complexity rules did not read it'])
  const threw = fakes(new Error('parser crashed\nstack'), ['/w/e.mjs'])
  assert.deepEqual(unsafeAnyProblems(threw.engineLinter, threw.program, new Map([['/w/e.mjs', AT]])),
    ['workflows/e.js: ESLint threw: parser crashed — the unsafe-any and complexity rules did not run'])
})
