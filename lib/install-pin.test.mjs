// The Codex, OpenCode and pi installs follow a git ref, and `bin/craft` runs the binary of the plugin's release version,
// so the documented installs pin the release tag: a ref that followed main would run newer content with an older
// binary. release-please's generic updater moves the version inside each marked block with the manifest.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/** @param {string} file */
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const version = JSON.parse(read('.release-please-manifest.json'))['.']

// `-{2}`, not a literal `<!--`: semgrep's JS parser reads `<!--` in a regex as an HTML-like comment and drops the file.
/** @param {string} text @returns {string[]} the text of every release-please version block */
const blocks = text => [...text.matchAll(/<!-{2} x-release-please-start-version -->\n([\s\S]*?)<!-{2} x-release-please-end -->/g)].map(m => m[1] ?? '')

/** @type {Array<[string, RegExp]>} */
const pins = [
  ['README.md', /^codex plugin marketplace add gurinderu\/craft --ref v(\S+)$/gm],
  ['integrations/opencode/README.md', /^git clone --branch v(\S+) https:\/\/github\.com\/gurinderu\/craft /gm],
  ['integrations/opencode/README.md', /^opencode plugin add git\+https:\/\/github\.com\/gurinderu\/craft#opencode-v(\S+)$/gm],
  ['README.md', /^opencode plugin add git\+https:\/\/github\.com\/gurinderu\/craft#opencode-v(\S+)$/gm],
  ['integrations/pi/README.md', /^pi install git:github\.com\/gurinderu\/craft@v(\S+)$/gm],
  ['MAP.md', /^pi install git:github\.com\/gurinderu\/craft@v(\S+)$/gm],
]

// Each pin is global (`g`): `matchAll` and `match` count every pinned line, and neither leaves `lastIndex` set.
test.each(pins)('%s pins its install to the release tag inside a block release-please moves', (file, every) => {
  const inside = blocks(read(file)).flatMap(b => [...b.matchAll(every)].map(m => m[1]))
  assert.ok(inside.length > 0, 'a pinned line inside a block')
  assert.deepEqual(
    inside,
    inside.map(() => version),
    'every pinned line at the manifest version',
  )
  assert.equal(read(file).match(every)?.length, inside.length, 'no pinned line outside a block')
})

test('release-please rewrites every install doc', () => {
  const extra = JSON.parse(read('release-please-config.json')).packages['.']['extra-files']
  for (const [file] of pins)
    assert.ok(
      extra.some((/** @type {{ type: string, path: string }} */ f) => f.type === 'generic' && f.path === file),
      file,
    )
})
