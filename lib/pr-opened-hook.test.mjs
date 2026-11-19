// The PostToolUse Bash hook in hooks/hooks.json, lib/pr-opened-hook.sh, which runs `craft hook pr-opened` (realm
// @nick/craft, node #541), run as the harness runs it: the command line through `sh -c`, CLAUDE_PLUGIN_ROOT the
// Claude Code delivery, HOME a fresh one, the hook input on stdin. The binary's own decision is the CLI's tests'
// (cli/bin/craft/tests/pr_opened_hook.rs); this holds what the script around it does.
import { beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(ROOT, 'lib', 'pr-opened-hook.sh')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.release-please-manifest.json'), 'utf8'))['.']
const HOOKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', 'claude-code', 'hooks', 'hooks.json'), 'utf8'))

/** The one PostToolUse Bash hook that runs the script, and no other hook runs it. @returns {{ command: string, timeout: number }} */
function prOpened() {
  /** @type {Record<string, { matcher?: string, hooks: { command: string, timeout: number }[] }[]>} */
  const all = HOOKS.hooks
  const runs = Object.entries(all).flatMap(([event, groups]) =>
    groups.flatMap(g => g.hooks.filter(h => h.command.includes('lib/pr-opened-hook.sh')).map(h => ({ event, matcher: g.matcher, h }))),
  )
  assert.deepEqual(
    runs.map(r => [r.event, r.matcher]),
    [['PostToolUse', 'Bash']],
  )
  const found = runs.map(r => r.h)
  return /** @type {{ command: string, timeout: number }} */ (found[0])
}

let HOME = ''
beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-prpr-home-'))
})

const OPENED = 'https://github.com/o/r/pull/7\n'

/** The hook run after `command` printed `stdout`; its exit code and stdout. @param {string} command @param {Record<string, string>} [extra] @param {string} [stdout] */
function run(command, extra = {}, stdout = OPENED) {
  const input = JSON.stringify({
    cwd: ROOT,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout, stderr: '', interrupted: false },
  })
  const env = { PATH: process.env['PATH'] ?? '', HOME, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'integrations', 'claude-code'), ...extra }
  try {
    return { code: 0, stdout: execFileSync('sh', ['-c', prOpened().command], { input, env, encoding: 'utf8' }) }
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

test('a call whose input names no pull request runs nothing and says nothing', () => {
  cache('echo ran')
  assert.deepEqual(run('gh pr create', {}, 'nothing opened\n'), { code: 0, stdout: '' })
})

test('with no binary cached it says the check could not run and downloads nothing', () => {
  const got = run('gh pr create --fill')
  assert.equal(got.code, 0)
  assert.equal(
    human(got.stdout),
    `craft: could not check the opened PR for a full craft review: the craft binary ${VERSION} is not on this machine yet (${HOME}/.craft/bin/${VERSION}/craft); a craft review fetches it.`,
  )
  assert.deepEqual(fs.readdirSync(HOME), [])
})

test("the cached binary of this version gets the input, its output is the hook's, and its failure is said", () => {
  cache('cat > "$HOME/input"; printf "%s" "$*"')
  assert.deepEqual(run('rtk gh pr create'), { code: 0, stdout: 'hook pr-opened' })
  assert.equal(JSON.parse(fs.readFileSync(path.join(HOME, 'input'), 'utf8')).tool_input.command, 'rtk gh pr create')
  cache('exit 3')
  const failed = run('gh pr create')
  assert.equal(failed.code, 0)
  assert.match(
    human(failed.stdout),
    new RegExp(`could not check the opened PR for a full craft review: the craft binary ${VERSION.replace(/\./g, '\\.')} failed\\.`),
  )
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
  assert.ok(extra.some((/** @type {{ type: string, path: string }} */ f) => f.type === 'generic' && f.path === 'lib/pr-opened-hook.sh'))
  assert.equal(prOpened().timeout, 30)
})

test('the text test before the binary stays cheap on a long output that names no pull request', () => {
  cache('echo ran')
  const long = 'through print high process pull '.repeat(800)
  const began = Date.now()
  const got = run('gh pr create', {}, long)
  assert.equal(got.stdout, '')
  assert.ok(Date.now() - began < 2000, `${Date.now() - began} ms`)
})
