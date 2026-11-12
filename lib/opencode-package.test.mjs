import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPORTS, importsOf, layPackage, moduleClosure, packageFiles, packageJson, scriptsNamed, SKIPPED_SKILLS } from './opencode-package.mjs'

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

test('a type-only statement does not swallow a later value import, and a multi-line clause is read', () => {
  const text = [
    'export type Shape = { kind: string }',
    "import { a } from './a.ts'",
    "export type { T } from './t.js'",
    'import {',
    '  b,',
    '  c as d,',
    "} from './b.ts'",
    "import * as ns from './ns.mjs'",
  ].join('\n')
  assert.deepEqual(importsOf(text), ['./a.ts', './b.ts', './ns.mjs'])
})

test('the lib scripts a Markdown file names are read, other files ignored', () => {
  const root = tmp()
  put(root, { 's/SKILL.md': 'run `node lib/a.mjs` then lib/b-c.mjs and lib/a.mjs', 's/x.json': '"lib/z.mjs"' })
  assert.deepEqual(scriptsNamed(root, ['s/SKILL.md', 's/x.json']), ['lib/a.mjs', 'lib/b-c.mjs'])
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
    'integrations/claude-code/.claude-plugin/plugin.json',
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
  assert.deepEqual(pkg['files'], ['bin', 'content', 'integrations', 'lib', 'skills', 'npm-shrinkwrap.json'])
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

test('the laid-out package holds what the binary needs to take it as its root', () => {
  const out = layPackage(REPO, tmp())
  // The binary's plugin_root_at: a manifest at the root or under integrations/claude-code; then the parts it reads.
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'integrations/claude-code/.claude-plugin/plugin.json'), 'utf8'))
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(REPO, '.release-please-manifest.json'), 'utf8'))['.'])
  for (const f of ['integrations/claude-code/agents/rust-reviewer.md', 'skills/review-rules/SKILL.md', 'lib/cli-review-file.mjs', 'lib/craft-externals.mjs'])
    assert.ok(fs.existsSync(path.join(out, f)), f)
})

test('every lib script a shipped Markdown file names is in the laid-out package', () => {
  const out = layPackage(REPO, tmp())
  const shipped = packageFiles(REPO)
  const named = scriptsNamed(REPO, shipped)
  assert.ok(named.includes('lib/craft-bin.mjs') && named.includes('lib/finding-post.mjs'), named.join(' '))
  for (const f of named) assert.ok(fs.existsSync(path.join(out, f)), f)
})

test("the laid-out package carries a shrinkwrap of the plugin lockfile's production closure", () => {
  const out = layPackage(REPO, tmp())
  const wrap = JSON.parse(fs.readFileSync(path.join(out, 'npm-shrinkwrap.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'integrations/opencode/plugin/package-lock.json'), 'utf8'))
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'))
  assert.equal(wrap.name, pkg.name)
  assert.equal(wrap.version, pkg.version)
  assert.deepEqual(wrap.packages[''].dependencies, pkg.dependencies)
  /** @type {Record<string, { dev?: boolean }>} */
  const packages = lock.packages
  const prod = Object.entries(packages).filter(([k, v]) => k !== '' && !v.dev)
  assert.deepEqual(
    Object.keys(wrap.packages)
      .filter(k => k !== '')
      .sort(),
    prod.map(([k]) => k).sort(),
  )
  for (const [name, pin] of Object.entries(JSON.parse(fs.readFileSync(path.join(REPO, 'integrations/opencode/plugin/package.json'), 'utf8')).overrides))
    assert.equal(wrap.packages[`node_modules/${name}`].version, pin, name)
})
