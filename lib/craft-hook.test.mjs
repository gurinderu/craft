// The role hooks in hooks/hooks.json, lib/craft-hook.sh, which runs `craft hook <name>` (realm @nick/craft, node #538),
// run as the harness runs them: the command line through `sh -c`, CLAUDE_PLUGIN_ROOT the Claude Code delivery, HOME a
// fresh one, the hook input on stdin. The binary's own decisions are the CLI's tests' (cli/bin/craft/src/hook/role/,
// held to content/parity/hook-cases.json); this holds what the script around it does.
import { beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(ROOT, 'lib', 'craft-hook.sh')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.release-please-manifest.json'), 'utf8'))['.']
const HOOKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', 'claude-code', 'hooks', 'hooks.json'), 'utf8'))
const EVENTS = /** @type {const} */ ([
  ['SessionStart', 'session-start'],
  ['UserPromptSubmit', 'user-prompt'],
  ['SubagentStart', 'subagent-start'],
  ['PreToolUse', 'reviewer-dispatch'],
])

/** The command each hooks.json entry that runs the script gives, by event. @returns {Map<string, { command: string, timeout: number }>} */
function commands() {
  /** @type {Record<string, { matcher?: string, hooks: { command: string, timeout: number }[] }[]>} */
  const all = HOOKS.hooks
  return new Map(
    Object.entries(all).flatMap(([event, groups]) => groups.flatMap(g => g.hooks.filter(h => h.command.includes('lib/craft-hook.sh')).map(h => [event, h]))),
  )
}

let HOME = ''
beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-hook-home-'))
})

/** One hook run as the harness runs it. @param {string} event @param {Record<string, string>} [extra] */
function run(event, extra = {}) {
  const hook = commands().get(event)
  assert.ok(hook, event)
  const env = { PATH: process.env['PATH'] ?? '', HOME, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'integrations', 'claude-code'), ...extra }
  const r = spawnSync('sh', ['-c', hook.command], { input: JSON.stringify({ hook_event_name: event, cwd: ROOT }), env, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** The binary of this version in the cache, a script with `body`. @param {string} body */
function cache(body) {
  const dir = path.join(HOME, '.craft', 'bin', VERSION)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'craft'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/** @param {string} stdout */
const human = stdout => /** @type {{ systemMessage: string }} */ (JSON.parse(stdout)).systemMessage

test('the four role hooks each run the script with their own hook name, bounded at 10 s', () => {
  const all = commands()
  assert.deepEqual([...all.keys()].sort(), EVENTS.map(([e]) => e).sort())
  for (const [event, name] of EVENTS) {
    assert.equal(all.get(event)?.command, `sh "\${CLAUDE_PLUGIN_ROOT}/lib/craft-hook.sh" ${name} || true`)
    assert.equal(all.get(event)?.timeout, 10)
  }
})

test('with no binary cached the start hook tells the human, the others say so on stderr, and nothing is downloaded', () => {
  const start = run('SessionStart')
  assert.equal(start.code, 0)
  assert.equal(
    human(start.stdout),
    `craft: the session-start hook did not run: the craft binary ${VERSION} is not on this machine yet (${HOME}/.craft/bin/${VERSION}/craft); a craft review fetches it.`,
  )
  for (const [event, name] of EVENTS.slice(1)) {
    const r = run(event)
    assert.deepEqual([r.code, r.stdout], [0, ''], event)
    assert.match(r.stderr, new RegExp(`^craft: the ${name} hook did not run: the craft binary .* is not on this machine yet`), event)
  }
  assert.deepEqual(fs.readdirSync(HOME), [])
})

test("under Codex a start with no binary also tells the model how the first review fetches it, as the binary's readiness line does", () => {
  const out = JSON.parse(run('SessionStart', { PLUGIN_ROOT: '/plugin/root/' }).stdout)
  assert.match(out.systemMessage, /^craft: the session-start hook did not run: the craft binary .* is not on this machine yet/)
  assert.equal(
    out.hookSpecificOutput.additionalContext,
    `craft: the craft binary ${VERSION} is not in ~/.craft/bin yet. When you run craft's review (the codex-review skill), its first run downloads it, which needs the network and writes outside the workspace: then run \`sh "/plugin/root/bin/craft" review run --backend codex …\` with escalated permissions and ask the user to approve it. This is not a request to start a review now.`,
  )
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(run('UserPromptSubmit', { PLUGIN_ROOT: '/plugin/root' }).stdout, '', 'only the start says it')
})

test("the cached binary of this version gets the input and its hook name, its output is the hook's, and its failure is said", () => {
  cache('cat > "$HOME/input"; printf "%s\\n" "$*"; echo noise >&2')
  for (const [event, name] of EVENTS) {
    assert.deepEqual(run(event), { code: 0, stdout: `hook ${name}\n`, stderr: '' }, event)
    assert.equal(JSON.parse(fs.readFileSync(path.join(HOME, 'input'), 'utf8')).hook_event_name, event)
  }
  cache('exit 0')
  assert.deepEqual(run('UserPromptSubmit'), { code: 0, stdout: '', stderr: '' }, 'silence stays silence')
  cache('echo partial; exit 101')
  for (const [event, name] of EVENTS) {
    const failed = run(event)
    assert.equal(failed.code, 0)
    assert.equal(human(failed.stdout), `craft: the ${name} hook did not run: the craft binary ${VERSION} failed (exit 101).`, event)
  }
})

test('CRAFT_BIN runs a local build; a path with a quote is escaped in the notice', () => {
  const local = path.join(HOME, 'my"craft')
  assert.match(human(run('SessionStart', { CRAFT_BIN: local }).stdout), /not on this machine yet \(.*my"craft\)/)
  fs.writeFileSync(local, '#!/bin/sh\nprintf local\n', { mode: 0o755 })
  assert.equal(run('SessionStart', { CRAFT_BIN: local }).stdout, 'local\n')
})

test('an unknown hook name says so on stderr and exits 0', () => {
  const r = spawnSync('sh', [SCRIPT, 'nope'], { input: '{}', env: { PATH: process.env['PATH'] ?? '', HOME }, encoding: 'utf8' })
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', 'craft: no craft hook named "nope".\n'])
})

test('it carries the plugin version on the line release-please moves', () => {
  const lines = fs
    .readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter(l => l.includes('x-release-please-version'))
  assert.deepEqual(lines, [`version=${VERSION} # x-release-please-version`])
  const extra = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-please-config.json'), 'utf8')).packages['.']['extra-files']
  assert.ok(extra.some((/** @type {{ type: string, path: string }} */ f) => f.type === 'generic' && f.path === 'lib/craft-hook.sh'))
})
