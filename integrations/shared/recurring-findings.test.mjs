// The legacy Node entry forwards arguments, streams and failure to the native reader.
// Native recurrence behavior is exercised by cli/bin/craft/tests/recurring.rs.
import { test, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./recurring-findings.mjs', import.meta.url))
/** @type {string} */
let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-recur-adapter-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** @param {string} script @param {string[]} args */
function invoke(script, args) {
  // Node stands in for an executable on every platform: its first argument is `runs`.
  fs.writeFileSync(path.join(tmp, 'runs'), script)
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: tmp,
    env: { ...process.env, CRAFT_BIN: process.execPath },
    encoding: 'utf8',
  })
}

test('legacy recurrence command forwards literal arguments and stdout/stderr', () => {
  const args = ['--store', 'store with spaces', '--project', 'project', '--path', '$(touch injected)', '--path', 'src/other']
  const result = invoke('console.log(JSON.stringify(process.argv.slice(2))); console.error("reader warning")', args)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), ['recurring', ...args])
  assert.equal(result.stderr, 'reader warning\n')
  assert.equal(fs.existsSync(path.join(tmp, 'injected')), false)
})

test('legacy recurrence command preserves a native argument refusal', () => {
  const result = invoke('console.error("--path needs a value"); process.exitCode = 2', ['--path'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '--path needs a value\n')
})

test('legacy recurrence command never turns a failing reader into empty successful output', () => {
  const result = invoke('console.error("store unreadable"); process.exitCode = 7', [])
  assert.equal(result.status, 7)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'store unreadable\n')
})

test('an unavailable explicit binary fails without downloading or showing empty groups', () => {
  const result = spawnSync(process.execPath, [entry], {
    cwd: tmp,
    env: { ...process.env, CRAFT_BIN: path.join(tmp, 'absent-binary') },
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /recurring-findings:.*ENOENT/)
})
