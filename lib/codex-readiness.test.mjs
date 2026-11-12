import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { binaryLine, codexPluginVersion, codexReadiness, sandboxLine, SANDBOX_TIMEOUT_MS, withReadiness } from './codex-readiness.mjs'
import { readHookLog, hookLogPath } from './hook-log.mjs'
import { sessionStart } from './role-hook.mjs'
import { run } from './session-start-hook.mjs'

/** @type {string[]} */
const made = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

/** A fresh temporary directory. @returns {string} */
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-codex-readiness-'))
  made.push(dir)
  return dir
}

/** A plugin root with a Codex manifest of `version`. @param {string} version @returns {string} */
function pluginRoot(version) {
  const root = tmp()
  fs.mkdirSync(path.join(root, '.codex-plugin'))
  fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'craft', version }))
  return root
}

/** @param {import('./codex-readiness.mjs').ProbeResult} result @returns {import('./codex-readiness.mjs').Runner} */
const answers = result => () => result

test('the sandbox probe runs `codex sandbox true` with the timeout, no shell', () => {
  /** @type {unknown[]} */
  const calls = []
  sandboxLine((command, args, timeoutMs) => {
    calls.push([command, args, timeoutMs])
    return { status: 0, stderr: '' }
  })
  assert.deepEqual(calls, [['codex', ['sandbox', 'true'], SANDBOX_TIMEOUT_MS]])
})

test('a sandbox that cannot start is named with its first stderr line and the fix', () => {
  const line = sandboxLine(answers({ status: 1, stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\nmore\n' }))
  assert.match(line, /tell the user/)
  assert.match(line, /exited 1: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\)/)
  assert.ok(!line.includes('more'))
  assert.match(line, /codex exec -s read-only/)
  assert.match(line, /apparmor_restrict_unprivileged_userns/)
  const warned = sandboxLine(answers({ status: 1, stderr: 'WARNING: proceeding, even though…\nbwrap: setting up uid map: Permission denied\n' }))
  assert.match(warned, /exited 1: bwrap: setting up uid map: Permission denied\)/)
})

test('a sandbox refused by the kernel is named without bwrap in the line', () => {
  for (const stderr of ['unshare: Operation not permitted', 'cannot create user namespace', 'write /proc/self/uid_map: denied'])
    assert.match(sandboxLine(answers({ status: 1, stderr })), /tell the user/, stderr)
})

test('a failure without a sandbox-setup signature says nothing', () => {
  // An older codex-cli spelled it `codex sandbox linux …`: `sandbox true` is a usage error there.
  assert.equal(sandboxLine(answers({ status: 2, stderr: "error: unrecognized subcommand 'true'\n\nUsage: codex sandbox <COMMAND>\n" })), '')
  assert.equal(sandboxLine(answers({ status: 1, stderr: 'sandbox-exec: sandbox_apply: Operation forbidden by policy\n' })), '')
  assert.equal(sandboxLine(answers({ status: 1, stderr: '' })), '')
})

test('a working sandbox, a missing codex and a timed-out probe say nothing', () => {
  assert.equal(sandboxLine(answers({ status: 0, stderr: '' })), '')
  assert.equal(sandboxLine(answers({ status: null, stderr: '', error: new Error('spawnSync codex ENOENT') })), '')
  assert.equal(sandboxLine(answers({ status: null, stderr: '' })), '')
})

test('the plugin version is read from the Codex manifest, empty when unreadable', () => {
  assert.equal(codexPluginVersion(pluginRoot('1.2.3')), '1.2.3')
  assert.equal(codexPluginVersion(tmp()), '')
})

test('a binary missing from the cache says how to run the review when it is run, not to run one now', () => {
  const root = pluginRoot('9.8.7')
  const home = tmp()
  const line = binaryLine({ env: { PLUGIN_ROOT: root }, home, platform: 'linux' })
  assert.match(line, /9\.8\.7 is not in ~\/\.craft\/bin/)
  assert.match(line, /When you run craft's review \(the codex-review skill\)/)
  assert.match(line, /not a request to start a review now/)
  assert.ok(line.includes(`sh "${path.join(root, 'bin', 'craft')}" review run --backend codex`), line)
  assert.match(line, /escalated permissions/)
})

test('the cached binary counts only as an executable regular file, as bin/craft takes it', () => {
  const root = pluginRoot('9.8.7')
  const home = tmp()
  const bin = path.join(home, '.craft', 'bin', '9.8.7', 'craft')
  fs.mkdirSync(bin, { recursive: true })
  assert.notEqual(binaryLine({ env: { PLUGIN_ROOT: root }, home, platform: 'linux' }), '', 'a directory is not the binary')
  fs.rmSync(bin, { recursive: true })
  fs.writeFileSync(bin, '', { mode: 0o644 })
  assert.notEqual(binaryLine({ env: { PLUGIN_ROOT: root }, home, platform: 'linux' }), '', 'a file without the x bit is not the binary')
  fs.chmodSync(bin, 0o755)
  assert.equal(binaryLine({ env: { PLUGIN_ROOT: root }, home, platform: 'linux' }), '')
})

test('no binary line without a plugin root, a version, or with a local build named', () => {
  const home = tmp()
  assert.equal(binaryLine({ env: {}, home }), '')
  assert.equal(binaryLine({ env: { PLUGIN_ROOT: tmp() }, home }), '')
  assert.equal(binaryLine({ env: { PLUGIN_ROOT: pluginRoot('1.0.0'), CRAFT_BIN: '/x/craft' }, home }), '')
})

test('readiness collects both lines and turns a throwing probe into silence', () => {
  const env = { PLUGIN_ROOT: pluginRoot('2.0.0') }
  const home = tmp()
  const both = codexReadiness({ env, home, runner: answers({ status: 1, stderr: 'bwrap: x' }), platform: 'linux' })
  assert.deepEqual(
    both.map(l => l.name),
    ['sandbox', 'binary'],
  )
  const thrown = codexReadiness({
    env,
    home,
    runner: () => {
      throw new Error('boom')
    },
    platform: 'linux',
  })
  assert.equal(thrown.length, 1)
  assert.match(thrown[0]?.text ?? '', /2\.0\.0/)
})

/** A git repo with nothing declared, and the start input for it. @returns {{ root: string, input: string }} */
function bareRepo() {
  const root = tmp()
  fs.mkdirSync(path.join(root, '.git'))
  return { root, input: JSON.stringify({ cwd: root }) }
}

/** @type {import('./codex-readiness.mjs').ReadinessLine[]} */
const READY = [
  { name: 'sandbox', text: 'craft: sandbox?' },
  { name: 'binary', text: 'craft: binary?' },
]

test('under Codex the readiness lines are said even when the role text is silent, and logged as said', () => {
  const { root, input } = bareRepo()
  const { stdout, entry } = withReadiness(sessionStart(input, { PLUGIN_ROOT: root }, root, new Date(0)), () => READY)
  assert.match(stdout, /craft: sandbox\?\\ncraft: binary\?/)
  assert.equal(entry.spoke, true)
  assert.equal(entry.silent, null)
  assert.equal(entry.reason, 'codex-readiness')
  assert.deepEqual(entry.readiness, ['sandbox', 'binary'])
})

test("readiness lines follow the role text when it speaks, and the line stays the role hook's", () => {
  const { root, input } = bareRepo()
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Open a pull request.\n')
  const { stdout, entry } = withReadiness(sessionStart(input, { PLUGIN_ROOT: root }, root, new Date(0)), () => READY.slice(1))
  const text = /** @type {{ hookSpecificOutput: { additionalContext: string } }} */ (JSON.parse(stdout)).hookSpecificOutput.additionalContext
  assert.match(text, /^craft: this repo declares[\s\S]*\ncraft: binary\?$/)
  assert.equal(entry.reason, undefined)
  assert.deepEqual(entry.readiness, ['binary'])
})

test('nothing said under Codex leaves the entry as the role hook wrote it', () => {
  const { root, input } = bareRepo()
  const start = sessionStart(input, { PLUGIN_ROOT: root }, root, new Date(0))
  assert.deepEqual(
    withReadiness(start, () => []),
    start,
  )
})

test('both switches silence the readiness lines with the rest of the start hook', () => {
  const { root, input } = bareRepo()
  let asked = 0
  const readiness = () => (asked++, READY)
  const off = withReadiness(sessionStart(input, { PLUGIN_ROOT: root, CRAFT_ROLE_HOOK: '0' }, root, new Date(0)), readiness)
  assert.equal(off.stdout, '')
  assert.equal(off.entry.silent, 'off-env')
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'craft-role-hook: off\n')
  const line = withReadiness(sessionStart(input, { PLUGIN_ROOT: root }, root, new Date(0)), readiness)
  assert.equal(line.stdout, '')
  assert.equal(line.entry.silent, 'off-line')
  assert.equal(asked, 0)
})

test('under Claude Code the start hook never runs the readiness check', () => {
  const { root, input } = bareRepo()
  const home = tmp()
  let asked = 0
  const readiness = () => (asked++, READY)
  const r = run([], { CLAUDE_PLUGIN_ROOT: root }, () => input, home, readiness)
  assert.deepEqual(r.stdout, [])
  assert.equal(asked, 0)
  const codex = run([], { PLUGIN_ROOT: root }, () => input, home, readiness)
  assert.equal(asked, 1)
  assert.match(codex.stdout[0] ?? '', /craft: sandbox\?/)
  const logged = readHookLog(hookLogPath(home)) ?? []
  assert.deepEqual(
    logged.map(e => [e.harness, e.spoke, e.readiness]),
    [
      ['claude-code', false, undefined],
      ['codex', true, ['sandbox', 'binary']],
    ],
  )
})
