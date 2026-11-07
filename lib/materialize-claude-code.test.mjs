import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DELIVERY, materialize, parseArgs, run } from './materialize-claude-code.mjs'

/** @type {string[]} */
const dirs = []
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-mcc-'))); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** @param {string} cwd @param {string[]} args @returns {string} */
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A repository whose delivery reaches shared directories through symlinks, as integrations/claude-code does. */
function repo() {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'skills', 'a'), { recursive: true })
  fs.writeFileSync(path.join(root, 'skills', 'a', 'SKILL.md'), 'body')
  fs.mkdirSync(path.join(root, 'lib'))
  fs.writeFileSync(path.join(root, 'lib', 'hook.mjs'), '// hook')
  fs.chmodSync(path.join(root, 'lib', 'hook.mjs'), 0o755)
  fs.writeFileSync(path.join(root, 'README.md'), 'readme')
  fs.mkdirSync(path.join(root, DELIVERY, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(path.join(root, DELIVERY, '.claude-plugin', 'plugin.json'), '{"version":"1.0.0"}')
  fs.symlinkSync('../../skills', path.join(root, DELIVERY, 'skills'))
  fs.symlinkSync('../../lib', path.join(root, DELIVERY, 'lib'))
  fs.symlinkSync('../../README.md', path.join(root, DELIVERY, 'README.md'))
  git(root, 'init', '-q', '-b', 'main')
  // The identity the release job sets, in the repository the script commits in.
  git(root, 'config', 'user.name', 't')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

/** @param {string} root @param {string[]} argv */
const runIn = (root, argv) => run(argv, {}, { root })

test('the copy holds real directories and files where the delivery has symlinks', () => {
  const copy = materialize(repo(), tmp())
  for (const name of ['skills', 'lib', 'README.md']) assert.equal(fs.lstatSync(path.join(copy, name)).isSymbolicLink(), false, name)
  assert.equal(fs.readFileSync(path.join(copy, 'skills', 'a', 'SKILL.md'), 'utf8'), 'body')
})

test('the branch\'s commit holds the delivery at its root with no symlink, and keeps the executable bit', async () => {
  const root = repo()
  const r = await runIn(root, ['--branch', 'claude-code-plugin', '--message', 'v1.0.0'])
  assert.equal(r.exitCode, 0, r.stderr.join('\n'))
  assert.match(r.stdout.join('\n'), /claude-code-plugin at [0-9a-f]{40}$/)
  const entries = git(root, 'ls-tree', '-r', 'claude-code-plugin').split('\n')
  assert.deepEqual(entries.map(l => l.split('\t')[1]).sort(), ['.claude-plugin/plugin.json', 'README.md', 'lib/hook.mjs', 'skills/a/SKILL.md'])
  assert.ok(entries.every(l => !l.startsWith('120000')), 'no symlink in the tree')
  assert.ok(entries.some(l => l.startsWith('100755') && l.endsWith('lib/hook.mjs')), 'the executable stays one')
  assert.equal(git(root, 'show', 'claude-code-plugin:skills/a/SKILL.md'), 'body')
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the checkout stays on its branch')
  assert.equal(git(root, 'status', '--porcelain'), '', 'the checkout\'s index and files are untouched')
})

test('the next release is a child of the branch head; an unchanged tree commits nothing', async () => {
  const root = repo()
  await runIn(root, ['--branch', 'b', '--message', 'one'])
  const first = git(root, 'rev-parse', 'b')
  const same = await runIn(root, ['--branch', 'b', '--message', 'again'])
  assert.equal(same.exitCode, 0)
  assert.match(same.stdout.join('\n'), /b unchanged at /)
  assert.equal(git(root, 'rev-parse', 'b'), first)
  fs.writeFileSync(path.join(root, 'skills', 'a', 'SKILL.md'), 'body 2')
  git(root, 'commit', '-q', '-am', 'two')
  const next = await runIn(root, ['--branch', 'b', '--message', 'two'])
  assert.equal(next.exitCode, 0, next.stderr.join('\n'))
  assert.equal(git(root, 'rev-parse', 'b^'), first, 'the earlier release stays reachable')
  assert.equal(git(root, 'show', 'b:skills/a/SKILL.md'), 'body 2')
})

test('a checkout with an untracked or ignored file is refused', async () => {
  const root = repo()
  fs.writeFileSync(path.join(root, 'skills', 'a', 'stray.md'), 'x')
  const r = await runIn(root, ['--branch', 'b', '--message', 'm'])
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr.join('\n'), /not clean.*\n.*stray\.md/s)
  assert.equal(git(root, 'branch', '--list', 'b'), '', 'no branch made')
})

test('the arguments are both required', () => {
  assert.deepEqual(parseArgs(['--branch', 'b', '--message', 'm']), { branch: 'b', message: 'm' })
  for (const bad of [[], ['--branch', 'b'], ['--message', 'm'], ['--branch', '', '--message', 'm'], ['--ref', 'b', '--message', 'm']]) {
    assert.throws(() => parseArgs(bad), /usage:/, bad.join(' '))
  }
})

test('a bad branch name fails with one line', async () => {
  const r = await runIn(repo(), ['--branch', 'a..b', '--message', 'm'])
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr.join('\n'), /^materialize-claude-code: git check-ref-format/)
})

test('the marketplace entry installs the in-repo delivery, and leaves the version to its plugin.json', () => {
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const market = JSON.parse(fs.readFileSync(path.join(here, '.claude-plugin', 'marketplace.json'), 'utf8'))
  const entry = market.plugins.find((/** @type {{ name: string }} */ p) => p.name === 'craft')
  const job = fs.readFileSync(path.join(here, '.github', 'workflows', 'claude-code-plugin.yml'), 'utf8')
  const branch = /^ {6}BRANCH: (\S+)$/m.exec(job)?.[1]
  assert.ok(branch, 'the job names its branch')
  // Staged: the in-repo source until a release's claude-code-plugin job has created the branch (a dispatch cannot
  // run before the workflow file is on the default branch). The follow-up switches the entry to
  // { source: 'url', url: 'https://github.com/gurinderu/craft.git', ref: branch } and pins that form here; a `url`
  // source over HTTPS, since a `github` source tries SSH first, which a consumer without a GitHub key fails.
  assert.equal(entry.source, './integrations/claude-code')
  const plugin = JSON.parse(fs.readFileSync(path.join(here, entry.source, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(plugin.version, market.version, 'release-please moves the plugin.json version with the marketplace')
  // An entry version would be read before the plugin's own: with the branch source, an update between the release
  // commit and the job's push could then cache the previous release under the new version.
  assert.equal(entry.version, undefined)
})
