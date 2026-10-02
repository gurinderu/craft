import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { FENCE_CLOSE, FENCE_OPEN } from './inline-regions.mjs'

// jscpd reads .jscpd.json, not this module: its ignorePattern is the fence pair spelled out by hand.
// A fence regex that moves without it would put every inlined region back into the duplication gate
// (red at once), or — loosened — let a stray fence-like comment hide real code from it (silent).
// jscpd also skips an ignorePattern its regex engine cannot compile, with only a warning.
test('.jscpd.json ignores exactly the craft-inline regions the checker reads', () => {
  /** @type {{ ignorePattern?: unknown }} */
  const config = JSON.parse(fs.readFileSync(new URL('../.jscpd.json', import.meta.url), 'utf8'))
  assert.deepEqual(config.ignorePattern, [`(?m)${FENCE_OPEN.source}[\\s\\S]*?${FENCE_CLOSE.source}`])
})
