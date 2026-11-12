// The module's 1.x entry: `server` loads the 1.x host (host-v1.ts) only when called, so loading the module on 2.x
// never imports @opencode-ai/plugin; called, it hands 1.x craft's tools.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import craft from './index.ts'

test("the 1.x entry, called, registers craft's tools through the 1.x host", async () => {
  const hooks = await craft.server(/** @type {any} */ ({ client: {}, directory: '/r', worktree: '/r' }))
  assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), ['review', 'rust-audit', 'triage-findings'])
})
