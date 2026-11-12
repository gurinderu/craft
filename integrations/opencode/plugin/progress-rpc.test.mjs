// The review's footer line, server side, against a fake `ctx.rpc` shaped as opencode-v2.d.ts pins it (2.2.7).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { progressChannel, withProgress } from './progress-rpc.ts'
import { REVIEW_RPC } from './review-rpc.mjs'

/** @param {{ refuse?: boolean, emitThrows?: boolean }} [o] */
function fakeRpc(o = {}) {
  /** @type {unknown[]} */
  const emitted = []
  /** @type {unknown[]} */
  const registered = []
  let disposed = 0
  const rpc = {
    register: async (/** @type {unknown} */ def, /** @type {unknown} */ handlers) => {
      if (o.refuse) throw new Error('refused')
      registered.push([def, handlers])
      return {
        dispose: async () => {
          disposed++
        },
        events: {
          emit: async (/** @type {string} */ name, /** @type {unknown} */ data) => {
            if (o.emitThrows) throw new Error('lost')
            emitted.push([name, data])
          },
        },
      }
    },
  }
  return { ctx: /** @type {any} */ ({ rpc }), emitted, registered, disposed: () => disposed }
}

test('the channel registers craft.review once and emits progress on it', async () => {
  const f = fakeRpc()
  const ch = await progressChannel(f.ctx)
  assert.deepEqual(f.registered, [[REVIEW_RPC, {}]])
  ch.say({ sessionID: 's', line: 'l', done: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(f.emitted, [['progress', { sessionID: 's', line: 'l', done: false }]])
  await ch.dispose()
  assert.equal(f.disposed(), 1)
})

test('a 2.x without ctx.rpc, a refused registration and a failed emit are silent', async () => {
  for (const ctx of [/** @type {any} */ ({}), fakeRpc({ refuse: true }).ctx, fakeRpc({ emitThrows: true }).ctx]) {
    const ch = await progressChannel(ctx)
    assert.doesNotThrow(() => ch.say({ sessionID: 's', line: 'l', done: false }))
    await ch.dispose()
  }
  await new Promise(resolve => setTimeout(resolve, 0))
})

test('a call says each progress line under its session, then its title as the end', async () => {
  /** @type {unknown[]} */
  const said = []
  const answer = await withProgress(
    'review',
    p => said.push(p),
    'ses',
    async progress => {
      progress?.('a')
      progress?.('b')
      return { title: 'craft review: Approve', output: 'o' }
    },
  )
  assert.deepEqual(answer, { title: 'craft review: Approve', output: 'o' })
  assert.deepEqual(said, [
    { sessionID: 'ses', line: 'a', done: false },
    { sessionID: 'ses', line: 'b', done: false },
    { sessionID: 'ses', line: 'craft review: Approve', done: true },
  ])
})

test('a string answer ends on its first line, a failure on why it stopped, and silence says no end', async () => {
  /** @type {any[]} */
  const said = []
  const say = (/** @type {unknown} */ p) => said.push(p)
  await withProgress('t', say, 'ses', async progress => {
    progress?.('x')
    return '\n## Verdict\nmore'
  })
  assert.equal(said.at(-1).line, '## Verdict')
  await assert.rejects(
    withProgress('review', say, 'ses', async progress => {
      progress?.('x')
      throw new Error('aborted')
    }),
    /aborted/,
  )
  assert.deepEqual(said.at(-1), { sessionID: 'ses', line: 'review: stopped — aborted', done: true })
  const before = said.length
  await withProgress('t', say, 'ses', async () => 'quiet')
  assert.equal(said.length, before, 'no progress, no end line')
})

test('without a channel or a session the call runs with no progress callback', async () => {
  /** @type {unknown[]} */
  const got = []
  await withProgress('t', undefined, 'ses', async progress => (got.push(progress), ''))
  await withProgress(
    't',
    () => undefined,
    undefined,
    async progress => (got.push(progress), ''),
  )
  assert.deepEqual(got, [undefined, undefined])
})
