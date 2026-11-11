// The workspace probe both hosts share: bash, in the workspace, "" on failure.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shellIn } from './shell.mjs'

test('a probe runs in the workspace and returns its trimmed stdout, or "" when it fails', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'craft-sh-')))
  try {
    const sh = shellIn(dir)
    assert.equal(await sh('pwd'), dir)
    assert.equal(await sh('printf "  a b \\n\\n"'), 'a b')
    assert.equal(await sh('echo partial; exit 3'), '', 'a non-zero exit is "unknown", not its output')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
