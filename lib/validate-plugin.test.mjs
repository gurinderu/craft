import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DELIVERY, materialize, run } from './validate-plugin.mjs'

/** @type {string[]} */
const dirs = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-vp-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** A repo whose delivery reaches a shared skills/ through a symlink, as integrations/claude-code does. */
function repo() {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'skills', 'a'), { recursive: true })
  fs.writeFileSync(path.join(root, 'skills', 'a', 'SKILL.md'), 'body')
  fs.mkdirSync(path.join(root, DELIVERY, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(path.join(root, DELIVERY, '.claude-plugin', 'plugin.json'), '{}')
  fs.symlinkSync('../../skills', path.join(root, DELIVERY, 'skills'))
  return root
}

test('the copy holds real directories where the delivery has symlinks', () => {
  const copy = materialize(repo(), tmp())
  assert.equal(fs.lstatSync(path.join(copy, 'skills')).isSymbolicLink(), false)
  assert.equal(fs.readFileSync(path.join(copy, 'skills', 'a', 'SKILL.md'), 'utf8'), 'body')
})

test('the validator reads the copy\'s manifest; its exit decides, and the copy is removed', async () => {
  /** @type {string[][]} */
  const calls = []
  const seen = { manifest: '', existed: false }
  const exec = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    calls.push([cmd, ...args])
    seen.manifest = args[4] ?? ''
    seen.existed = fs.existsSync(path.join(path.dirname(path.dirname(seen.manifest)), 'skills', 'a', 'SKILL.md'))
    return 0
  }
  const ok = await run([], {}, { root: repo(), exec })
  assert.equal(ok.exitCode, 0)
  assert.deepEqual(calls[0]?.slice(0, 5), ['npx', '--yes', '@anthropic-ai/claude-code', 'plugin', 'validate'])
  assert.deepEqual(calls[0]?.slice(6), ['--strict'])
  assert.match(seen.manifest, /claude-code\/\.claude-plugin\/plugin\.json$/)
  assert.ok(seen.existed, 'the skills reached through the symlink are in the copy')
  assert.equal(fs.existsSync(seen.manifest), false, 'the temporary copy is removed')
  const bad = await run([], {}, { root: repo(), exec: () => 1 })
  assert.equal(bad.exitCode, 1)
  assert.match(bad.stderr.join('\n'), /the validator failed .* \(exit 1\)/)
})

test('a missing delivery fails with one line', async () => {
  const r = await run([], {}, { root: tmp(), exec: () => 0 })
  assert.equal(r.exitCode, 1)
  assert.match(r.stderr.join('\n'), /^validate-plugin: /)
})
