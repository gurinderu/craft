// The module's two entries: `server` loads the 1.x host (host-v1.ts) only when called, so loading the module on 2.x
// never imports @opencode-ai/plugin; called, it hands 1.x craft's tools. `setup` hands 2.x craft's tools and hooks.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import craft from './index.ts'

test("the 1.x entry, called, registers craft's tools through the 1.x host", async () => {
  const hooks = await craft.server(/** @type {any} */ ({ client: {}, directory: '/r', worktree: '/r' }))
  assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), ['review', 'rust-audit', 'triage-findings'])
})

test("the 2.x entry registers the light agent's three hooks beside the work hook, and its disposer disposes all of them", async () => {
  /** @type {string[]} */
  const hooks = []
  let disposed = 0
  // Every registration the fake 2.x context hands back counts its disposal.
  const registration = () => ({
    dispose: () => {
      disposed++
      return Promise.resolve()
    },
  })
  const ctx = /** @type {any} */ ({
    app: { version: '2.2.7' },
    location: { directory: '/repo', project: { directory: '/root' } },
    tool: {
      transform: async (/** @type {(editor: { add(definition: unknown): void }) => void} */ edit) => {
        edit({ add() {} })
        return registration()
      },
    },
    session: {
      hook: async (/** @type {string} */ name) => {
        hooks.push(name)
        return registration()
      },
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true, value: undefined }),
          return: () => Promise.resolve({ done: true, value: undefined }),
        }),
      }),
    },
  })
  const dispose = await craft.setup(ctx)
  assert.deepEqual(hooks, ['prompt', 'context', 'compaction', 'generate'])
  await dispose()
  assert.equal(disposed, 5, 'the tools, the work hook and the three of the light agent')
})
