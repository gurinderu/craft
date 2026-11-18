// The PreToolUse Bash hook in hooks/hooks.json, lib/pre-pr-hook.sh, which runs `craft hook pre-pr` (realm
// @nick/craft, node #541), run as the harness runs it: the command line through `sh -c`, CLAUDE_PLUGIN_ROOT the
// Claude Code delivery, HOME a fresh one, the hook input on stdin. The binary's own decision is the CLI's tests'
// (cli/bin/craft/tests/pre_pr_hook.rs); this holds what the script around it does.
import { beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(ROOT, 'lib', 'pre-pr-hook.sh')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.release-please-manifest.json'), 'utf8'))['.']
const HOOKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', 'claude-code', 'hooks', 'hooks.json'), 'utf8'))

/** The one PreToolUse Bash hook that runs the script. @returns {{ command: string, timeout: number }} */
function prePr() {
  /** @type {{ matcher: string, hooks: { command: string, timeout: number }[] }[]} */
  const groups = HOOKS.hooks.PreToolUse
  const found = groups.filter(g => g.matcher === 'Bash').flatMap(g => g.hooks.filter(h => h.command.includes('lib/pre-pr-hook.sh')))
  assert.equal(found.length, 1)
  return /** @type {{ command: string, timeout: number }} */ (found[0])
}

let HOME = ''
beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prpr-home-'))
})

/** The hook run on `command`; its exit code and stdout. @param {string} command @param {Record<string, string>} [extra] */
function run(command, extra = {}) {
  const input = JSON.stringify({ cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
  const env = { PATH: process.env['PATH'] ?? '', HOME, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'integrations', 'claude-code'), ...extra }
  try {
    return { code: 0, stdout: execFileSync('sh', ['-c', prePr().command], { input, env, encoding: 'utf8' }) }
  } catch (e) {
    const err = /** @type {{ status: number, stdout: string }} */ (e)
    return { code: err.status, stdout: err.stdout }
  }
}

/** The binary of this version in the cache, a script with `body`. @param {string} body */
function cache(body) {
  const dir = path.join(HOME, '.craft', 'bin', VERSION)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'craft'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/** @param {string} stdout */
const human = stdout => /** @type {{ systemMessage: string }} */ (JSON.parse(stdout)).systemMessage

test('a command that opens no pull request runs nothing and says nothing', () => {
  cache('echo ran')
  assert.deepEqual(run('git status'), { code: 0, stdout: '' })
})

test('with no binary cached it says the check did not run, downloads nothing, and lets the command go', () => {
  const got = run('gh pr create --fill')
  assert.equal(got.code, 0)
  assert.equal(
    human(got.stdout),
    `craft: the pre-PR review check did not run (the craft binary ${VERSION} is not on this machine yet (${HOME}/.craft/bin/${VERSION}/craft); a craft review fetches it), so whether this head has a full craft review is unknown.`,
  )
  assert.deepEqual(fs.readdirSync(HOME), [])
})

test("the cached binary of this version gets the input, its output is the hook's, and its failure is said", () => {
  cache('cat > "$HOME/input"; printf "%s" "$*"')
  assert.deepEqual(run('rtk gh pr create'), { code: 0, stdout: 'hook pre-pr' })
  assert.equal(JSON.parse(fs.readFileSync(path.join(HOME, 'input'), 'utf8')).tool_input.command, 'rtk gh pr create')
  cache('exit 3')
  const failed = run('gh pr create')
  assert.equal(failed.code, 0)
  assert.match(human(failed.stdout), new RegExp(`did not run \\(the craft binary ${VERSION.replace(/\./g, '\\.')} failed\\)`))
})

test('CRAFT_BIN runs a local build; a path with a quote is escaped in the notice', () => {
  const local = path.join(HOME, 'my"craft')
  assert.match(human(run('gh pr create', { CRAFT_BIN: local }).stdout), /not on this machine yet \(.*my"craft\)/)
  fs.writeFileSync(local, '#!/bin/sh\nprintf local\n', { mode: 0o755 })
  assert.equal(run('gh pr create', { CRAFT_BIN: local }).stdout, 'local')
})

test('it carries the plugin version on the line release-please moves, and is bounded like the other craft hooks', () => {
  const lines = fs
    .readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter(l => l.includes('x-release-please-version'))
  assert.deepEqual(lines, [`version=${VERSION} # x-release-please-version`])
  const extra = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-please-config.json'), 'utf8')).packages['.']['extra-files']
  assert.ok(extra.some((/** @type {{ type: string, path: string }} */ f) => f.type === 'generic' && f.path === 'lib/pre-pr-hook.sh'))
  assert.equal(prePr().timeout, 10)
})

test('the text test before the binary stays cheap on a long command that opens no pull request', () => {
  cache('echo ran')
  // Measured with dash: 21.6 KB of such words took about 30 s under a three-star glob, and 0.00 s with this test.
  const long = 'through print high process '.repeat(800)
  const began = Date.now()
  const got = run(`echo ${long}`)
  assert.equal(got.stdout, '')
  assert.ok(Date.now() - began < 2000, `${Date.now() - began} ms`)
  assert.equal(run('gh pr new --fill').stdout, 'ran', "gh's alias reaches the binary")
})
