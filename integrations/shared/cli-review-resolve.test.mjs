// The review engine's resolve step (integrations/shared/cli-review-steps.mjs) run in a real sh: the fetcher is the plugin's
// POSIX entry integrations/shared/craft-cli.sh, so getting the binary needs no Node, and a fetcher stamped with
// another version than the engine's is refused before it runs. The binary is put in the cache first, so no download runs.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEngine } from './engine-harness.mjs'

const SHARED = dirname(fileURLToPath(import.meta.url))
const VERSION = /^version=(\S+) /m.exec(readFileSync(join(SHARED, 'craft-cli.sh'), 'utf8'))?.[1] ?? ''

let TMP = ''
beforeEach(() => {
  TMP = realpathSync(mkdtempSync(join(tmpdir(), 'craft-resolve-')))
})
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
})

/** A plugin root holding the shared POSIX entry and its fetch helpers, its stamp set to `version`. @param {string} version */
function pluginRoot(version) {
  const root = join(TMP, 'plugin')
  mkdirSync(join(root, 'integrations/shared'), { recursive: true })
  for (const f of ['craft-fetch.sh', 'craft-fetch-http.sh']) cpSync(join(SHARED, f), join(root, 'integrations/shared', f))
  const cli = readFileSync(join(SHARED, 'craft-cli.sh'), 'utf8').replace(/^version=\S+ /m, `version=${version} `)
  writeFileSync(join(root, 'integrations/shared/craft-cli.sh'), cli)
  return root
}

/** The resolve step's script as the engine writes it, run in sh with HOME at a cache holding this version's binary. @param {string} root */
async function resolve(root) {
  const repo = join(TMP, 'repo')
  mkdirSync(repo)
  const home = join(TMP, 'home')
  const bin = join(home, '.craft/bin', VERSION, 'craft')
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, '#!/bin/sh\n')
  chmodSync(bin, 0o755)
  const run = await runEngine('review', { args: { repo, craftRoot: root }, script: { 'step:resolve': null } })
  const script = /```sh\n([\s\S]*?)```/.exec(run.calls[0]?.prompt ?? '')?.[1]
  assert.ok(script, 'the resolve step carries one sh block')
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, CRAFT_BIN: '/nowhere/craft', CRAFT_REPO: 'evil/fork' }
  return { bin, out: spawnSync('sh', ['-c', script], { env, encoding: 'utf8' }) }
}

test.skipIf(process.platform === 'win32')('the resolve step gets the cached binary through craft-cli.sh, CRAFT_BIN ignored', async () => {
  const root = pluginRoot(VERSION)
  const { bin, out } = await resolve(root)
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout, `root=${root}\nbin=${bin}\n`)
})

test.skipIf(process.platform === 'win32')('a fetcher stamped with another version is refused before it runs', async () => {
  const { out } = await resolve(pluginRoot('0.0.1'))
  assert.equal(out.status, 1)
  assert.match(out.stderr, new RegExp(`craft-cli\\.sh is not stamped with craft ${VERSION.replace(/\./g, '\\.')}`))
  assert.equal(out.stdout, '')
})
