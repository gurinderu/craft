// The child-run unit every workflow shares: a child marked as the engine's only while it runs, and the retries of all
// callers one at a time (#8528/#6573).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ENGINE_SESSIONS, runChildSession, solo } from './child-run.ts'

/** @param {(req: import('./host.ts').ChildRequest, n: number) => Promise<string>} answer */
function fakeHost(answer) {
  let n = 0
  /** @type {boolean[]} */
  const marked = []
  const host = {
    directory: '', worktree: '', sh: async () => '', callerModel: async () => undefined,
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

test('solo work runs one at a time across callers, and the queue goes on after a failure', async () => {
  let live = 0
  let most = 0
  const work = async () => {
    live++
    most = Math.max(most, live)
    await new Promise(resolve => setTimeout(resolve, 20))
    live--
    return 'done'
  }
  assert.deepEqual(await Promise.all([solo(work), solo(work), solo(work)]), ['done', 'done', 'done'])
  assert.equal(most, 1, 'never two at once')
  await assert.rejects(solo(async () => { throw new Error('boom') }), /boom/)
  assert.equal(await solo(async () => 'after'), 'after', 'the queue keeps working after its works settled')
})
