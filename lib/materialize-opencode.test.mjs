import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run, TAG_PREFIX } from './materialize-opencode.mjs'

/** @type {string[]} */
const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** @param {string} cwd @param {string[]} args @returns {string} */
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A repository with the smallest package the layout accepts, at release `version`. */
function repo(version = '1.2.3') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-mo-')))
  dirs.push(root)
  const files = {
    '.release-please-manifest.json': JSON.stringify({ '.': version }),
    'package.json': '{"name":"craft","scripts":{"prepare":"x"}}',
    'integrations/opencode/plugin/package.json': '{"dependencies":{"@opencode-ai/plugin":"1.0.0"}}',
    'integrations/opencode/plugin/index.ts': "import { x } from './x.ts'\n",
    'integrations/opencode/plugin/x.ts': "await import('../../../lib/run.mjs')\n",
    'integrations/opencode/plugin/x.test.mjs': '',
    'integrations/opencode/plugin/tui/tui.mjs': '',
    'integrations/opencode/agents/a.md': 'agent',
    'integrations/opencode/commands/craft-review.md': 'command',
    'integrations/claude-code/agents/rust-reviewer.md': 'rubric',
    'integrations/claude-code/.claude-plugin/plugin.json': '{"name":"craft"}',
    'integrations/opencode/plugin/package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { '@opencode-ai/plugin': '1.0.0' } }, 'node_modules/@opencode-ai/plugin': { version: '1.0.0' } },
    }),
    'lib/run.mjs': '',
    'lib/cli-review-file.mjs': '',
    'lib/craft-externals.mjs': '',
    'lib/check-other.mjs': '',
    'content/profiles/rust.json': '{}',
    'skills/rust-review/SKILL.md': 'skill',
    'skills/develop/SKILL.md': 'claude code only',
    'bin/craft': '#!/bin/sh\n',
  }
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
    fs.writeFileSync(path.join(root, f), text)
  }
  fs.chmodSync(path.join(root, 'bin/craft'), 0o755)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 't')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

/** @param {string} root @param {string[]} argv */
const runIn = (root, argv) => run(argv, {}, { root })

test("the branch's commit is the package, tagged with the release version", () => {
  const root = repo()
  const r = runIn(root, ['--branch', 'opencode-plugin', '--message', 'v1.2.3'])
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.match(r.stdout.join('\n'), new RegExp(`opencode-plugin at [0-9a-f]{40}, tagged ${TAG_PREFIX}1\\.2\\.3$`))
  const entries = git(root, 'ls-tree', '-r', 'opencode-plugin').split('\n')
  assert.deepEqual(entries.map(l => l.split('\t')[1]).sort(), [
    'bin/craft',
    'content/profiles/rust.json',
    'integrations/claude-code/.claude-plugin/plugin.json',
    'integrations/claude-code/agents/rust-reviewer.md',
    'integrations/opencode/agents/a.md',
    'integrations/opencode/commands/craft-review.md',
    'integrations/opencode/plugin/index.ts',
    'integrations/opencode/plugin/tui/tui.mjs',
    'integrations/opencode/plugin/x.ts',
    'lib/cli-review-file.mjs',
    'lib/craft-externals.mjs',
    'lib/run.mjs',
    'npm-shrinkwrap.json',
    'package.json',
    'skills/rust-review/SKILL.md',
  ])
  assert.ok(entries.some(l => l.startsWith('100755') && l.endsWith('bin/craft')))
  const pkg = JSON.parse(git(root, 'show', 'opencode-plugin:package.json'))
  assert.equal(pkg.name, 'craft-opencode')
  assert.equal(pkg.version, '1.2.3')
  assert.equal('scripts' in pkg, false)
  assert.equal(git(root, 'rev-parse', `${TAG_PREFIX}1.2.3^{commit}`), git(root, 'rev-parse', 'opencode-plugin'))
  assert.equal(git(root, 'status', '--porcelain'), '', "the checkout's index and files are untouched")
})

test('a rerun keeps the commit and its tag; a tag already elsewhere is refused', () => {
  const root = repo()
  runIn(root, ['--branch', 'b', '--message', 'one'])
  const again = runIn(root, ['--branch', 'b', '--message', 'again'])
  assert.equal(again.exitCode, 0, again.stderr.join('\n'))
  assert.match(again.stdout.join('\n'), /b unchanged at /)
  fs.writeFileSync(path.join(root, 'skills/rust-review/SKILL.md'), 'skill 2')
  git(root, 'commit', '-q', '-am', 'two')
  const moved = runIn(root, ['--branch', 'b', '--message', 'two'])
  assert.equal(moved.exitCode, 1)
  assert.match(moved.stderr.join('\n'), /tag opencode-v1\.2\.3 already names [0-9a-f]+, not/)
})

test('a checkout with an untracked file is refused, before any branch or tag', () => {
  const root = repo()
  fs.writeFileSync(path.join(root, 'stray'), 'x')
  const r = runIn(root, ['--branch', 'b', '--message', 'm'])
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr.join('\n'), /not clean/)
  assert.equal(git(root, 'tag', '--list'), '')
})
