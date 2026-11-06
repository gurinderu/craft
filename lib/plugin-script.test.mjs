// pluginRootCheck run by a real shell: a craftRoot given beside craftBin is held to the rule every located plugin
// script is (absolute, the manifest present, outside the reviewed repo, symlinks followed), with no fallback.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pluginRootCheck } from './plugin-script.mjs'

let TMP = ''
beforeEach(() => { TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-root-'))) })
afterEach(() => { fs.rmSync(TMP, { recursive: true, force: true }) })

/** A directory holding the plugin manifest. @param {string} dir */
function plugin(dir) {
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{}')
  return dir
}

/** @param {string} root @param {string} repo */
function check(root, repo) {
  const r = spawnSync('sh', ['-c', pluginRootCheck(root, repo)], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.trim() }
}

test('a plugin checkout outside the reviewed repo passes, printed as its resolved path', () => {
  const repo = path.join(TMP, 'repo')
  fs.mkdirSync(repo)
  const root = plugin(path.join(TMP, 'craft'))
  fs.symlinkSync(root, path.join(TMP, 'link'))
  assert.deepEqual(check(root, repo), { status: 0, stdout: `root=${root}\n`, stderr: '' })
  assert.equal(check(path.join(TMP, 'link'), repo).stdout, `root=${root}\n`, 'a symlinked root is followed')
})

test('a root without the manifest, relative, or inside the reviewed repo is refused with why', () => {
  const repo = path.join(TMP, 'repo')
  plugin(path.join(repo, 'vendor', 'craft'))
  fs.mkdirSync(path.join(TMP, 'empty'))
  fs.symlinkSync(path.join(repo, 'vendor', 'craft'), path.join(TMP, 'into-repo'))
  const empty = check(path.join(TMP, 'empty'), repo)
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /^no file at .*\/empty\/\.claude-plugin\/plugin\.json$/)
  assert.match(check('craft', repo).stderr, /^not absolute \(craft\/\.claude-plugin\/plugin\.json\)$/)
  assert.match(check(path.join(repo, 'vendor', 'craft'), repo).stderr, /^inside the reviewed repo /)
  const linked = check(path.join(TMP, 'into-repo'), repo)
  assert.deepEqual([linked.status, linked.stdout], [1, ''])
  assert.match(linked.stderr, /^inside the reviewed repo /, 'a symlink into the repo is followed and refused')
})
