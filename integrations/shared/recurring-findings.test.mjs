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

test.skipIf(process.platform === 'win32').each([
  ['github wins', 'github-token', 'gh-token', 'github-token'],
  ['gh fallback', '', 'gh-token', 'gh-token'],
  ['anonymous', '', '', ''],
])('uncached adapter forwards downloader credentials: %s', (_name, github, gh, expected) => {
  // Stop at the download process boundary: no network or real credentials involved.
  fs.writeFileSync(path.join(tmp, 'sh'), '#!/bin/sh\nprintf "credential:%s:%s\\n" "$GITHUB_TOKEN" "$GH_TOKEN" >&2\nexit 23\n', { mode: 0o755 })
  const result = spawnSync(process.execPath, [entry], {
    cwd: tmp,
    env: { ...process.env, HOME: tmp, PATH: tmp, CRAFT_BIN: '', GITHUB_TOKEN: github, GH_TOKEN: gh },
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `recurring-findings: credential:${expected}:\n`)
})
