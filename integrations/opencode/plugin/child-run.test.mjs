// The child-run unit every workflow shares: a child marked as the engine's only while it runs, and an empty reply
// tried once more alone — the retries of all callers one at a time (#8528/#6573).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ENGINE_SESSIONS, retryingEmpty, runChildSession, solo } from './child-run.ts'

/** @param {(req: import('./host.ts').ChildRequest, n: number) => Promise<string>} answer */
function fakeHost(answer) {
  let n = 0
  /** @type {boolean[]} */
  const marked = []
  const host = {
    directory: '', worktree: '', sh: async () => '', callerModel: async () => undefined, agents: async () => null,
    runChild: async (/** @type {import('./host.ts').ChildRequest} */ req) => {
      const id = `ses_${n}`
      req.onSession?.(id)
      marked.push(ENGINE_SESSIONS.has(id))
      return answer(req, n++)
    },
  }
  return { host, marked, calls: () => n }
}

test('a child is the engine\'s while it runs and forgotten when it ends, even when it fails', async () => {
  const ok = fakeHost(async () => 'done')
  assert.equal(await runChildSession(ok.host, { title: 't', agent: '', prompt: 'p' }), 'done')
  const bad = fakeHost(async () => { throw new Error('boom') })
  await assert.rejects(runChildSession(bad.host, { title: 't', agent: '', prompt: 'p' }), /boom/)
  assert.deepEqual([...ok.marked, ...bad.marked], [true, true])
  assert.equal(ENGINE_SESSIONS.size, 0)
})

test('an empty reply is tried once more, a real one is not, and an aborted request starts no retry', async () => {
  const empty = fakeHost(async (_req, n) => (n === 0 ? '  ' : 'second'))
  assert.equal(await retryingEmpty(empty.host, { title: 't', agent: '', prompt: 'p' }), 'second')
  const full = fakeHost(async () => 'first')
  assert.equal(await retryingEmpty(full.host, { title: 't', agent: '', prompt: 'p' }), 'first')
  assert.equal(full.calls(), 1)
  const stop = new AbortController()
  const aborted = fakeHost(async () => { stop.abort(); return '' })
  assert.equal(await retryingEmpty(aborted.host, { title: 't', agent: '', prompt: 'p', signal: stop.signal }), '')
  assert.equal(aborted.calls(), 1)
})

test('retries run one at a time across callers, while first attempts keep their own concurrency', async () => {
  let live = 0
  let most = 0
  const empty = fakeHost(async (_req, n) => {
    if (n < 3) return ''
    live++
    most = Math.max(most, live)
    await new Promise(resolve => setTimeout(resolve, 20))
    live--
    return 'retried'
  })
  const req = { title: 't', agent: '', prompt: 'p' }
  const got = await Promise.all([retryingEmpty(empty.host, req), retryingEmpty(empty.host, req), retryingEmpty(empty.host, req)])
  assert.deepEqual(got, ['retried', 'retried', 'retried'])
  assert.equal(most, 1, 'never two retries at once')
  assert.equal(await solo(async () => 'after'), 'after', 'the queue keeps working after its works settled')
})
