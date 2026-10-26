// The two forms of an engine and the lib/ modules each uses (lib/engine-form.mjs).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import { importSpecifiers, isBundledForm, libModulesOf } from './engine-form.mjs'
import { ROOT } from './inline-regions.mjs'

test('the bundled form is told by a top-level `export async function __run(`', () => {
  assert.ok(isBundledForm("import x from '../lib/x.mjs'\nexport const meta = {}\nexport async function __run() {\nreturn 1\n}\n"))
  assert.ok(!isBundledForm('export const meta = {}\nreturn 1\n'))
  assert.ok(!isBundledForm('  export async function __run() {}'), 'only at the start of a line')
})

test('import and re-export specifiers are read, side-effect imports too', () => {
  const src = "import { a } from '../lib/a.mjs'\nimport * as b from \"./b.mjs\"\nimport './c.mjs'\nexport { d } from '../lib/d.mjs'\nconst s = 'import x from y'\nexport const t = 1\n// read from './nowhere.mjs'\nexport {\n  e,\n  f,\n} from './e.mjs'\n"
  assert.deepEqual(importSpecifiers(src), ['../lib/a.mjs', './b.mjs', './c.mjs', '../lib/d.mjs', './e.mjs'])
})

test('an engine\'s lib/ modules are its fences and its imports, followed through lib/, packages and built-ins left out', () => {
  /** @type {Record<string, string>} */
  const files = {
    'src/e.js': "import { a } from '../lib/a.mjs'\nimport fs from 'node:fs'\n// >>> craft-inline lib/f.mjs f\nfunction f() {}\n// <<< craft-inline\n",
    'lib/a.mjs': "import { b } from './b.mjs'\nimport { a2 } from './a.mjs'\nexport const a = b\n",
    'lib/b.mjs': "import x from 'esbuild'\nexport const b = 1\n",
  }
  const read = (/** @type {string} */ abs) => /** @type {string} */ (files[path.relative('/r', abs).split(path.sep).join('/')])
  assert.deepEqual(libModulesOf('/r', 'src/e.js', read), ['lib/a.mjs', 'lib/b.mjs', 'lib/f.mjs'])
})

test('the moved pins use the arguments parser and the nested launch, as their fences once named', () => {
  for (const pin of ['nix-review', 'rust-review']) assert.deepEqual(libModulesOf(ROOT, `src/${pin}.js`), ['lib/nested-workflow.mjs', 'lib/workflow-args.mjs'])
})
