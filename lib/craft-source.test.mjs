// The external-sources CLI (lib/craft-source.mjs, realm @nick/craft, node #430) with git injected: every cache
// lives in a temporary CRAFT_SOURCES_DIR, never under the real ~/.craft, and no test needs the network.
import { test, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decodeSpec, run, sourcesRoot } from './craft-source.mjs'
import { gitEnv } from './source-checkout.mjs'


/** @type {string} */ let tmp
/** @type {string} */ let repo
/** @type {string} */ let cache
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-source-')))
  repo = path.join(tmp, 'repo')
  cache = path.join(tmp, 'cache')
  fs.mkdirSync(path.join(repo, 'chart'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'chart', 'values.yaml'), 'kubeovn:\n  tag: v1.13.2\nkubevirt: 0123456789abcdef0123456789abcdef01234567\n')
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('run prints the answer as one JSON line', async () => {
  const r = await run(['prepare'], { CRAFT_SOURCES_DIR: cache })
  assert.equal(r.exitCode, 1)
  assert.deepEqual(r.stdout.map(l => Object.keys(JSON.parse(l))), [['error']])
})

test('the cache defaults to ~/.craft/sources, and git never prompts', () => {
  assert.deepEqual(sourcesRoot({ HOME: '/home/x' }), { root: '/home/x/.craft/sources' })
  assert.deepEqual(sourcesRoot({ CRAFT_SOURCES_DIR: '/c', HOME: '/home/x' }), { root: '/c' })
  assert.deepEqual([gitEnv({}).GIT_TERMINAL_PROMPT, gitEnv({}).GIT_SSH_COMMAND], ['0', 'ssh -o BatchMode=yes'])
  assert.equal(gitEnv({ GIT_SSH_COMMAND: 'mine' }).GIT_SSH_COMMAND, 'mine')
})

test('a spec entry with both a file and a stated version uses the file, as a record does (node #440)', () => {
  const b64 = Buffer.from(JSON.stringify([{ system: 's', repo: 'r', versionFrom: 'f', versionMatch: '(m)', version: 'v1' }, { system: 't', repo: 'r', version: 'v2' }])).toString('base64url')
  assert.deepEqual(decodeSpec(b64), { entries: [{ system: 's', repo: 'r', versionFrom: 'f', versionMatch: '(m)' }, { system: 't', repo: 'r', version: 'v2' }] })
})
