import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPORTS, importsOf, layPackage, moduleClosure, packageFiles, packageJson, SKIPPED_SKILLS } from './opencode-package.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** @type {string[]} */
const dirs = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-ocp-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** @param {string} root @param {Record<string, string>} files */
function put(root, files) {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
    fs.writeFileSync(path.join(root, f), text)
  }
}

test('the imports read are the relative value ones: static, re-exported and literal dynamic', () => {
  const text = [
    "import { a } from './a.ts'",
    "import type { T } from './types.js'",
    "export { b } from '../b.mjs'",
    "import fs from 'node:fs'",
    "const c = await import('../../../lib/c.mjs')",
    "/** @type {import('./d.mjs').D} */",
  ].join('\n')
  assert.deepEqual(importsOf(text), ['./a.ts', '../b.mjs', '../../../lib/c.mjs', './d.mjs'])
})

test('the closure follows imports across directories and refuses one that is not there', () => {
  const root = tmp()
  put(root, { 'p/i.ts': "import { x } from './x.ts'\n", 'p/x.ts': "await import('../lib/y.mjs')\n", 'lib/y.mjs': '', 'lib/unused.mjs': '' })
  assert.deepEqual(moduleClosure(root, ['p/i.ts']), ['lib/y.mjs', 'p/i.ts', 'p/x.ts'])
  put(root, { 'p/x.ts': "import { z } from './gone.ts'\n" })
  assert.throws(() => moduleClosure(root, ['p/i.ts']), /p\/x\.ts imports \.\/gone\.ts/)
})

test("the checkout's package carries the entries, what they reach, the binary's scripts and the OpenCode content", () => {
  const files = packageFiles(REPO)
  for (const f of [
    ...Object.values(EXPORTS).map(e => e.slice(2)),
    'integrations/opencode/plugin/plugin-content.ts',
    'lib/craft-review-run.mjs',
    'lib/work-hook-opencode.mjs',
    'lib/cli-review-file.mjs',
    'lib/craft-externals.mjs',
    'integrations/opencode/agents/review-task.md',
    'integrations/opencode/commands/craft-review.md',
    'integrations/claude-code/agents/rust-reviewer.md',
    'skills/rust-review/SKILL.md',
    'skills/review-rules/SKILL.md',
    'content/profiles/rust.json',
    'bin/craft',
  ])
    assert.ok(files.includes(f), f)
  for (const f of files) {
    assert.doesNotMatch(f, /\.test\.mjs$|node_modules|package-lock/, f)
    for (const s of SKIPPED_SKILLS) assert.ok(!f.startsWith(`skills/${s}/`), f)
  }
})

test('install.sh leaves out the same skills', () => {
  const install = fs.readFileSync(path.join(REPO, 'integrations/opencode/install.sh'), 'utf8')
  assert.match(install, new RegExp(`case "\\$\\(basename "\\$d"\\)" in ${SKIPPED_SKILLS.join('\\|')}\\) continue`))
})

test('the package.json has its entries, the plugin pins, and no scripts', () => {
  const pkg = packageJson(REPO, '9.9.9')
  const plugin = JSON.parse(fs.readFileSync(path.join(REPO, 'integrations/opencode/plugin/package.json'), 'utf8'))
  assert.equal(pkg['version'], '9.9.9')
  assert.deepEqual(pkg['exports'], EXPORTS)
  assert.deepEqual(pkg['dependencies'], plugin.dependencies)
  assert.deepEqual(pkg['files'], ['bin', 'content', 'integrations', 'lib', 'skills'])
  assert.equal('scripts' in pkg, false)
})

test('the laid-out package keeps the relative layout and the executable bit', () => {
  const out = layPackage(REPO, tmp())
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'))
  assert.equal(pkg.version, JSON.parse(fs.readFileSync(path.join(REPO, '.release-please-manifest.json'), 'utf8'))['.'])
  assert.ok(fs.statSync(path.join(out, 'bin/craft')).mode & 0o100, 'bin/craft stays executable')
  assert.ok(fs.existsSync(path.join(out, 'integrations/opencode/plugin/index.ts')))
  assert.equal(fs.existsSync(path.join(out, 'skills/develop')), false)
})
