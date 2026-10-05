// The falsifier for .dependency-cruiser.mjs: each rule fires on a planted violation, and the allowed
// shapes (a node: built-in, the plugin's own @opencode-ai/plugin, a type-only import) stay clean.
// A rule that stopped firing would read as a clean run; these fail instead.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs')
const CONFIG = path.join(ROOT, '.dependency-cruiser.mjs')

/** @param {string} root @param {Record<string, string>} files */
function write(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
}

// depcruise colours its report whenever the environment asks (FORCE_COLOR in a CI or a terminal), and the
// matches below read plain text: the child gets no FORCE_COLOR and an explicit NO_COLOR.
function plainEnv() {
  const env = { ...process.env, NO_COLOR: '1' }
  delete env.FORCE_COLOR
  return env
}

/** @param {string} name @param {Record<string, string>} [extra] */
function pkg(name, extra = {}) {
  return { [`${name}/package.json`]: JSON.stringify({ name, main: 'index.js', ...extra }), [`${name}/index.js`]: 'export default 1\n' }
}

/**
 * A tree shaped like craft's: the shipped entries, a helper they import, a test beside it, a devDependency
 * at the root and in the plugin, and @opencode-ai/plugin exporting only an `import` condition, as the real one does.
 * @param {Record<string, string>} plant files replacing the clean ones
 * @returns {{ status: number | null, out: string }}
 */
function cruise(plant) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-depcruise-'))
  try {
    write(root, {
      'package.json': JSON.stringify({ private: true, type: 'module', devDependencies: { devpkg: '1.0.0' } }),
      ...Object.fromEntries(Object.entries(pkg('devpkg')).map(([k, v]) => [`node_modules/${k}`, v])),
      'opencode/plugin/package.json': JSON.stringify({ private: true, type: 'module', dependencies: { '@opencode-ai/plugin': '1.0.0' }, devDependencies: { devpkg2: '1.0.0' } }),
      'opencode/plugin/node_modules/@opencode-ai/plugin/package.json': JSON.stringify({ name: '@opencode-ai/plugin', type: 'module', exports: { '.': { import: './dist/index.js' } } }),
      'opencode/plugin/node_modules/@opencode-ai/plugin/dist/index.js': 'export const tool = 1\n',
      ...Object.fromEntries(Object.entries(pkg('devpkg2')).map(([k, v]) => [`opencode/plugin/node_modules/${k}`, v])),
      'lib/craft-log-run.mjs': "import fs from 'node:fs'\nimport { h } from './helper.mjs'\nvoid fs, h\n",
      'lib/analyze-runs.mjs': "import { h } from './helper.mjs'\nvoid h\n",
      'lib/helper.mjs': 'export const h = 1\n',
      'lib/helper.test.mjs': "import { h } from './helper.mjs'\nvoid h\n",
      'opencode/plugin/index.ts': "import { tool } from '@opencode-ai/plugin'\nimport type { X } from 'devpkg2'\nexport const p: X | number = tool\n",
      ...plant,
    })
    const r = spawnSync(process.execPath, [BIN, '--config', CONFIG, '--output-type', 'err', 'lib', 'opencode/plugin'], { cwd: root, encoding: 'utf8', env: plainEnv() })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('a clean tree passes: built-ins, @opencode-ai/plugin and a type-only import are allowed', () => {
  const r = cruise({})
  assert.equal(r.status, 0, r.out)
})

test('a shipped entry reaching a test file fails shipped-reaches-no-test', () => {
  const r = cruise({ 'lib/helper.mjs': "import './helper.test.mjs'\nexport const h = 1\n" })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /shipped-reaches-no-test: lib\/analyze-runs\.mjs → lib\/helper\.test\.mjs/)
})

test('a shipped entry reaching a root devDependency fails shipped-reaches-no-package', () => {
  const r = cruise({ 'lib/helper.mjs': "import 'devpkg'\nexport const h = 1\n" })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /shipped-reaches-no-package: lib\/craft-log-run\.mjs → node_modules\/devpkg\/index\.js/)
})

test('the plugin reaching its own devDependency at run time fails shipped-reaches-no-package', () => {
  const r = cruise({ 'opencode/plugin/index.ts': "import d from 'devpkg2'\nexport const p = d\n" })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /shipped-reaches-no-package: opencode\/plugin\/index\.ts → opencode\/plugin\/node_modules\/devpkg2\/index\.js/)
})

test('an inline type specifier survives verbatimModuleSyntax as `import {} from`, so it fails shipped-reaches-no-package', () => {
  const r = cruise({ 'opencode/plugin/index.ts': "import { tool } from '@opencode-ai/plugin'\nimport { type X } from 'devpkg2'\nexport const p: X | number = tool\n" })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /shipped-reaches-no-package: opencode\/plugin\/index\.ts → opencode\/plugin\/node_modules\/devpkg2\/index\.js/)
})

test('an import that does not resolve fails resolvable, not a silent pass', () => {
  const r = cruise({ 'lib/helper.mjs': "import 'not-installed'\nexport const h = 1\n" })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /resolvable: lib\/helper\.mjs → not-installed/)
})
