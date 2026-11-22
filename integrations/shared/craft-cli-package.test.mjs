// The POSIX acquisition entry runs from both isolated package layouts, with no Node on PATH.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { materialize } from './materialize-claude-code.mjs'
import { layPackage } from './opencode-package.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.release-please-manifest.json'), 'utf8'))['.']

for (const [name, lay] of /** @type {const} */ ([
  ['Claude Code', materialize],
  ['OpenCode', layPackage],
])) {
  test(`${name}: shared acquisition resolves the cache and override without bin/ or Node`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-cli-package-'))
    try {
      const pkg = lay(ROOT, tmp)
      fs.rmSync(path.join(pkg, 'bin'), { recursive: true, force: true })
      const tools = path.join(tmp, 'tools')
      fs.mkdirSync(tools)
      for (const tool of ['dirname', 'uname']) {
        const location = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
        fs.symlinkSync(location, path.join(tools, tool))
      }
      const env = { PATH: tools, HOME: tmp }
      assert.equal(spawnSync('/bin/sh', ['-c', 'command -v node'], { env }).status, 127)
      const cached = path.join(tmp, '.craft/bin', VERSION, 'craft')
      const local = path.join(tmp, 'local craft')
      for (const binary of [cached, local]) {
        fs.mkdirSync(path.dirname(binary), { recursive: true })
        fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s|" "$CRAFT_ROOT" "$@"\n', { mode: 0o755 })
      }
      const entry = path.join(pkg, 'integrations/shared/craft-cli.sh')
      const resolve = (/** @type {Record<string, string>} */ extra = {}) =>
        spawnSync('/bin/sh', [entry, '--ensure', '--print-path'], { env: { ...env, ...extra }, encoding: 'utf8' })
      for (const [extra, binary] of /** @type {[Record<string, string>, string][]} */ ([
        [{}, cached],
        [{ CRAFT_BIN: local }, local],
      ])) {
        const result = resolve(extra)
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout, `${binary}\n`)
        assert.equal(result.stderr, '')
      }
      const invoked = spawnSync('/bin/sh', [entry, 'init', 'a b'], { env, encoding: 'utf8' })
      assert.equal(invoked.status, 0, invoked.stderr)
      assert.equal(invoked.stdout, `${pkg}|init|a b|`)
      fs.rmSync(cached)
      const missing = resolve()
      assert.equal(missing.status, 127)
      assert.equal(missing.stdout, '')
      assert.match(missing.stderr, /neither curl nor wget/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
}
