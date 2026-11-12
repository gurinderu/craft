import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { binaryLine, codexPluginVersion, codexReadiness, sandboxLine, SANDBOX_TIMEOUT_MS } from './codex-readiness.mjs'
import { sessionStart } from './role-hook.mjs'

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

test('a working sandbox, a missing codex and a timed-out probe say nothing', () => {
  assert.equal(sandboxLine(answers({ status: 0, stderr: '' })), '')
  assert.equal(sandboxLine(answers({ status: null, stderr: '', error: new Error('spawnSync codex ENOENT') })), '')
  assert.equal(sandboxLine(answers({ status: null, stderr: '' })), '')
})

test('the plugin version is read from the Codex manifest, empty when unreadable', () => {
  assert.equal(codexPluginVersion(pluginRoot('1.2.3')), '1.2.3')
  assert.equal(codexPluginVersion(tmp()), '')
})

test('a binary missing from the cache asks for an escalated run of bin/craft', () => {
  const root = pluginRoot('9.8.7')
  const home = tmp()
  const line = binaryLine({ env: { PLUGIN_ROOT: root }, home, platform: 'linux' })
  assert.match(line, /9\.8\.7 is not in ~\/\.craft\/bin/)
  assert.ok(line.includes(`sh "${path.join(root, 'bin', 'craft')}" review run --backend codex`), line)
  assert.match(line, /escalated permissions/)
  fs.mkdirSync(path.join(home, '.craft', 'bin', '9.8.7'), { recursive: true })
  fs.writeFileSync(path.join(home, '.craft', 'bin', '9.8.7', 'craft'), '')
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
  assert.equal(codexReadiness({ env, home, runner: answers({ status: 1, stderr: 'x' }), platform: 'linux' }).length, 2)
  const thrown = codexReadiness({
    env,
    home,
    runner: () => {
      throw new Error('boom')
    },
    platform: 'linux',
  })
  assert.equal(thrown.length, 1)
  assert.match(thrown[0] ?? '', /2\.0\.0/)
})

test('the start hook appends the extra lines, even when the role text is silent, and only for the harness asked', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, '.git'))
  const input = JSON.stringify({ cwd: root })
  /** @param {import('./hook-harness.mjs').Harness} who @returns {string[]} */
  const extra = who => (who === 'codex' ? ['craft: ready?'] : [])
  const codex = sessionStart(input, { PLUGIN_ROOT: root }, root, new Date(0), extra)
  assert.match(codex.stdout, /craft: ready\?/)
  assert.equal(codex.entry.silent, 'nothing-declared')
  assert.equal(sessionStart(input, {}, root, new Date(0), extra).stdout, '')
})
