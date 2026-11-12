// The Codex and OpenCode installs follow a git ref, and `bin/craft` runs the binary of the plugin's release version,
// so the documented installs pin the release tag: a ref that followed main would run newer content with an older
// binary. release-please's generic updater moves the version inside each marked block with the manifest.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/** @param {string} file */
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const version = JSON.parse(read('.release-please-manifest.json'))['.']

/** @param {string} text @returns {string[]} the text of every release-please version block */
const blocks = text => [...text.matchAll(/<!-- x-release-please-start-version -->\n([\s\S]*?)<!-- x-release-please-end -->/g)].map(m => m[1] ?? '')

/** @type {Array<[string, RegExp]>} */
const pins = [
  ['README.md', /^codex plugin marketplace add gurinderu\/craft --ref v(\S+)$/m],
  ['integrations/opencode/README.md', /^git clone --branch v(\S+) https:\/\/github\.com\/gurinderu\/craft /m],
]

test.each(pins)('%s pins its install to the release tag inside a block release-please moves', (file, pin) => {
  const inside = blocks(read(file))
    .map(b => pin.exec(b)?.[1])
    .filter(Boolean)
  assert.deepEqual(inside, [version])
  assert.equal(read(file).match(new RegExp(pin.source, 'gm'))?.length, 1, 'no pinned line outside the block')
})

test('release-please rewrites both install docs', () => {
  const extra = JSON.parse(read('release-please-config.json')).packages['.']['extra-files']
  for (const [file] of pins)
    assert.ok(
      extra.some((/** @type {{ type: string, path: string }} */ f) => f.type === 'generic' && f.path === file),
      file,
    )
})
