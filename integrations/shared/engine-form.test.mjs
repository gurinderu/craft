// The bundled form of an engine and the integrations/shared/ modules each uses (integrations/shared/engine-form.mjs).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import { importSpecifiers, isBundledForm, libModulesOf } from './engine-form.mjs'

test('the bundled form is told by a top-level `export async function __run(`', () => {
  assert.ok(isBundledForm("import x from '../../shared/x.mjs'\nexport const meta = {}\nexport async function __run() {\nreturn 1\n}\n"))
  assert.ok(!isBundledForm('export const meta = {}\nreturn 1\n'))
  assert.ok(!isBundledForm('  export async function __run() {}'), 'only at the start of a line')
})

test('import and re-export specifiers are read, side-effect imports too', () => {
  const src =
    "import { a } from '../../shared/a.mjs'\nimport * as b from \"./b.mjs\"\nimport './c.mjs'\nexport { d } from '../../shared/d.mjs'\nconst s = 'import x from y'\nexport const t = 1\n// read from './nowhere.mjs'\nexport {\n  e,\n  f,\n} from './e.mjs'\n"
  assert.deepEqual(importSpecifiers(src), ['../../shared/a.mjs', './b.mjs', './c.mjs', '../../shared/d.mjs', './e.mjs'])
})

test("an engine's integrations/shared/ modules are its imports, followed through integrations/shared/, packages and built-ins left out", () => {
  /** @type {Record<string, string>} */
  const files = {
    'integrations/claude-code/src/e.js': "import { a } from '../../shared/a.mjs'\nimport fs from 'node:fs'\nexport const meta = {}\n",
    'integrations/shared/a.mjs': "import { b } from './b.mjs'\nimport { a2 } from './a.mjs'\nexport const a = b\n",
    'integrations/shared/b.mjs': "import x from 'esbuild'\nexport const b = 1\n",
  }
  const read = (/** @type {string} */ abs) => /** @type {string} */ (files[path.relative('/r', abs).split(path.sep).join('/')])
  assert.deepEqual(libModulesOf('/r', 'integrations/claude-code/src/e.js', read), ['integrations/shared/a.mjs', 'integrations/shared/b.mjs'])
})
