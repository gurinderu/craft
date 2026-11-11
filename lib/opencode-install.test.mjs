// integrations/opencode/install.sh run over a throwaway checkout and opencode tree, with a fake npm on PATH that logs
// its argv: what it links, what it removes on an upgrade, and when it reinstalls the plugin's dependencies.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeExecutable } from './codex-review-fakes.mjs'

const INSTALL = path.resolve(import.meta.dirname, '..', 'integrations', 'opencode', 'install.sh')
// The fake npm: logs its argv, and `ci --prefix <dir>` lays out an installed tree there as npm would.
const FAKE_NPM = `#!/bin/sh
echo "$*" >> "$NPM_LOG"
[ "$1" = ci ] && [ "$2" = --prefix ] && mkdir -p "$3/node_modules/@opencode-ai/plugin" && echo '{}' > "$3/node_modules/.package-lock.json"
exit 0
`

/** @type {{ dir: string, repo: string, oc: string, project: string, log: string, bin: string }} */
let at

/** @param {string} file @param {string} [text] */
const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

beforeEach(() => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-install-')))
  const repo = path.join(dir, 'repo')
  const oc = path.join(repo, 'integrations', 'opencode')
  at = { dir, repo, oc, project: path.join(dir, 'project'), log: path.join(dir, 'npm.log'), bin: path.join(dir, 'bin') }
  put(path.join(oc, 'install.sh'), fs.readFileSync(INSTALL, 'utf8'))
  for (const f of ['agents/review-task.md', 'commands/review.md', 'plugin/index.ts', 'plugin/package-lock.json']) put(path.join(oc, f))
  for (const s of ['tdd', 'codex-review', 'develop']) put(path.join(repo, 'skills', s, 'SKILL.md'))
  fs.mkdirSync(at.project)
  fs.mkdirSync(at.bin)
  writeExecutable(path.join(at.bin, 'npm'), FAKE_NPM)
})
afterEach(() => fs.rmSync(at.dir, { recursive: true, force: true }))

/** @param {string} [script] */
const install = (script = path.join(at.oc, 'install.sh')) => execFileSync('bash', [script, '--project'], { cwd: at.project, env: { ...process.env, PATH: `${at.bin}:${process.env['PATH']}`, NPM_LOG: at.log }, stdio: 'pipe' })
const npmRuns = () => (fs.existsSync(at.log) ? fs.readFileSync(at.log, 'utf8').trim().split('\n') : [])
/** @param {string} rel */
const linkOf = rel => { const p = path.join(at.project, '.opencode', rel); return fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ? fs.readlinkSync(p) : null }
/** @param {string} rel @param {string} target */
const preLink = (rel, target) => { const p = path.join(at.project, '.opencode', rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.symlinkSync(target, p) }
/** The lockfile moved by a pull: newer than the installed tree. */
const pull = () => { const later = new Date(Date.now() + 60_000); fs.utimesSync(path.join(at.oc, 'plugin', 'package-lock.json'), later, later) }

test('a first install links each file and the plugin entry, leaves out the excluded skills, installs the production closure', () => {
  install()
  assert.equal(linkOf('agents/review-task.md'), path.join(at.oc, 'agents', 'review-task.md'))
  assert.equal(linkOf('commands/review.md'), path.join(at.oc, 'commands', 'review.md'))
  assert.equal(linkOf('plugins/craft-rust.ts'), path.join(at.oc, 'plugin', 'index.ts'))
  assert.deepEqual([linkOf('skills/tdd'), linkOf('skills/codex-review'), linkOf('skills/develop')], [path.join(at.repo, 'skills', 'tdd'), null, null])
  assert.deepEqual(npmRuns(), [`ci --prefix ${path.join(at.oc, 'plugin')} --omit=dev --no-audit --no-fund`])
})

test('a rerun leaves a current tree alone and reinstalls one older than the lockfile, keeping a dev tree whole', () => {
  install()
  install()
  assert.equal(npmRuns().length, 1, 'the tree is current: npm is not run')
  pull()
  install()
  assert.match(npmRuns()[1] ?? '', /^ci --prefix \S+ --omit=dev /)
  fs.writeFileSync(path.join(at.oc, 'plugin', 'node_modules', '.package-lock.json'), '{"packages":{"node_modules/typescript":{"dev": true}}}')
  pull()
  install()
  assert.match(npmRuns()[2] ?? '', /^ci --prefix \S+ --no-audit --no-fund$/, 'a development tree keeps its dev dependencies')
})

test('an upgrade removes this checkout\'s stale links and touches no other link or file', () => {
  const elsewhere = path.join(at.dir, 'elsewhere.md')
  put(elsewhere)
  preLink('plugins/craft-rust', path.join(at.oc, 'plugin'))
  preLink('skills/codex-review', path.join(at.repo, 'skills', 'codex-review'))
  preLink('agents/gone.md', path.join(at.oc, 'agents', 'gone.md'))
  preLink('agents/foreign.md', elsewhere)
  preLink('commands/dead-foreign.md', path.join(at.dir, 'nowhere.md'))
  put(path.join(at.project, '.opencode', 'skills', 'mine', 'SKILL.md'))
  install()
  assert.deepEqual([linkOf('plugins/craft-rust'), linkOf('skills/codex-review'), linkOf('agents/gone.md')], [null, null, null])
  assert.equal(linkOf('agents/foreign.md'), elsewhere)
  assert.equal(linkOf('commands/dead-foreign.md'), path.join(at.dir, 'nowhere.md'))
  assert.ok(fs.existsSync(path.join(at.project, '.opencode', 'skills', 'mine', 'SKILL.md')))
  assert.equal(linkOf('agents/review-task.md'), path.join(at.oc, 'agents', 'review-task.md'))
})

test('a tree with no npm record (another installer) is left alone, and a dev tree without one keeps its dev packages', () => {
  const nm = path.join(at.oc, 'plugin', 'node_modules')
  fs.mkdirSync(path.join(nm, '@opencode-ai', 'plugin'), { recursive: true })
  pull()
  install()
  assert.deepEqual(npmRuns(), [], 'no npm record: not reinstalled over a tree that works')
  fs.rmSync(path.join(nm, '@opencode-ai'), { recursive: true })
  fs.mkdirSync(path.join(nm, 'typescript'))
  install()
  assert.match(npmRuns()[0] ?? '', /^ci --prefix \S+ --no-audit --no-fund$/, 'missing dependencies installed, the dev tree kept whole')
})

test('through a symlinked checkout path, stale links in either spelling are this checkout\'s', () => {
  const alias = path.join(at.dir, 'alias')
  fs.symlinkSync(at.repo, alias)
  preLink('plugins/craft-rust', path.join(at.oc, 'plugin'))
  preLink('skills/codex-review', path.join(alias, 'skills', 'codex-review'))
  install(path.join(alias, 'integrations', 'opencode', 'install.sh'))
  assert.deepEqual([linkOf('plugins/craft-rust'), linkOf('skills/codex-review')], [null, null])
  assert.equal(linkOf('plugins/craft-rust.ts'), path.join(alias, 'integrations', 'opencode', 'plugin', 'index.ts'))
})
