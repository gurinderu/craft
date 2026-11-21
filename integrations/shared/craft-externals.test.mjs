// The legacy entry's transport; discovery/import behavior belongs to the native tests.
import { test, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./craft-externals.mjs', import.meta.url))
/** @type {string} */ let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-externals-adapter-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** @param {string} script @param {string[]} args @param {string} [input] */
function invoke(script, args, input = '') {
  fs.writeFileSync(path.join(tmp, '__craft-externals'), script)
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: tmp,
    env: { ...process.env, CRAFT_BIN: process.execPath },
    input,
    encoding: 'utf8',
  })
}

test.each(['discover', 'memory'])('legacy %s passes literal argv and UTF-16 JSON stdin through', verb => {
  const args = [verb, '--repo-root', 'a root with spaces', '--paths', '$(touch injected)']
  const input = '[{"versionMatch":"(\\ud800)","scope":"$HOME `id`"}]\n'
  const result = invoke(
    'const fs = require("node:fs"); console.log(JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,"utf8")})); console.error("warning")',
    args,
    input,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { args, input })
  assert.equal(result.stderr, 'warning\n')
  assert.equal(fs.existsSync(path.join(tmp, 'injected')), false)
})

test('a native invocation refusal keeps JSON stdout and exit 1', () => {
  const result = invoke('console.log(JSON.stringify({error:"unexpected option"})); process.exitCode=1', ['discover', '--bad'])
  assert.equal(result.status, 1)
  assert.deepEqual(JSON.parse(result.stdout), { error: 'unexpected option' })
  assert.equal(result.stderr, '')
})

test('a native failure stays a failure instead of becoming an empty import', () => {
  const result = invoke('console.error("read failed"); process.exitCode=7', ['memory'])
  assert.equal(result.status, 7)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'read failed\n')
})
