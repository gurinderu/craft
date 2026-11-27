import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { v1Host } from './host-v1.ts'
import { ChildSessionFailed } from './host.ts'
import { childTasks } from './review-children.ts'
import { ENGINE_SESSIONS } from './child-run.ts'

const REQUEST = { title: 'review', agent: 'review-task', prompt: 'p', parentID: 'ses_parent' }
const TASK = { key: 1, id: 'one', label: 'one', agent: 'review-task', prompt: 'p', cwd: '/repo', model: null }

function deferred() {
  /** @type {(value: unknown) => void} */
  let resolve = () => {}
  /** @type {(error: unknown) => void} */
  let reject = () => {}
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup() {
  vi.useFakeTimers()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const client = {
    app: { agents: async () => ({ data: [] }) },
    session: {
      create: vi.fn(async () => /** @type {unknown} */ ({ data: { id: 'ses_child' } })),
      prompt: vi.fn(async (/** @type {unknown} */ _req) => /** @type {unknown} */ ({ text: 'ok' })),
      abort: vi.fn(async (/** @type {unknown} */ _req) => /** @type {unknown} */ ({ data: true })),
      messages: async () => [],
    },
  }
  return { client, log, host: v1Host({ client, directory: '/repo', worktree: '/repo' }) }
}

/** @param {Promise<unknown>} work */
function outcome(work) {
  /** @type {{ settled: boolean; value?: unknown; error?: unknown }} */
  const state = { settled: false }
  void work.then(
    value => Object.assign(state, { settled: true, value }),
    (/** @type {unknown} */ error) => Object.assign(state, { settled: true, error }),
  )
  return state
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test.each(['transport-error', 'empty', 'null', 'whitespace'])('a %s reply waits for the exact child stop before retrying', async kind => {
  const { client, host } = setup()
  const stop = deferred()
  client.session.create.mockResolvedValueOnce({ data: { id: 'ses_first' } }).mockResolvedValueOnce({ data: { id: 'ses_retry' } })
  if (kind === 'transport-error') client.session.prompt.mockRejectedValueOnce(new Error('prompt connection lost'))
  else client.session.prompt.mockResolvedValueOnce(kind === 'null' ? null : { data: { parts: [{ type: 'text', text: kind === 'empty' ? '' : ' \n\t' }] } })
  client.session.abort.mockReturnValueOnce(stop.promise)
  const state = outcome(childTasks(host, 'ses_parent')(TASK, new AbortController().signal))
  await vi.advanceTimersByTimeAsync(0)
  assert.deepEqual(client.session.abort.mock.calls, [[{ path: { id: 'ses_first' } }]])
  assert.equal(client.session.create.mock.calls.length, 1, 'retry waits for stop confirmation')
  assert.equal(client.session.prompt.mock.calls.length, 1)
  assert.equal(state.settled, false)
  stop.resolve({ data: true })
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(state.value, 'ok')
  assert.equal(client.session.create.mock.calls.length, 2)
  assert.deepEqual(client.session.abort.mock.calls, [[{ path: { id: 'ses_first' } }]], 'the successful retry is not stopped')
  assert.equal(vi.getTimerCount(), 0)
})

test('an empty reply waits for a hung stop deadline before retrying', async () => {
  const { client, host, log } = setup()
  client.session.prompt.mockResolvedValueOnce({ data: { parts: [] } })
  client.session.abort.mockImplementationOnce(() => new Promise(() => {}))
  const state = outcome(childTasks(host, 'ses_parent')(TASK, new AbortController().signal))
  await vi.advanceTimersByTimeAsync(9_999)
  assert.equal(state.settled, false)
  assert.equal(client.session.create.mock.calls.length, 1)
  await vi.advanceTimersByTimeAsync(1)
  assert.equal(state.value, 'ok')
  assert.equal(client.session.create.mock.calls.length, 2)
  assert.deepEqual(client.session.abort.mock.calls, [[{ path: { id: 'ses_child' } }]])
  assert.match(String(log.mock.calls[0]), /ses_child.*10000 ms.*may still be running/)
  assert.equal(vi.getTimerCount(), 0)
})

test.each(['throw', 'reject', 'sdk-error', 'unconfirmed'])('a %s stop is logged without replacing the prompt transport error', async kind => {
  const { client, host, log } = setup()
  const original = new Error('prompt connection lost')
  client.session.prompt.mockImplementation(() => {
    throw original
  })
  client.session.abort.mockImplementation(() => {
    if (kind === 'throw') throw new Error('stop transport threw')
    if (kind === 'reject') return Promise.reject(new Error('stop transport rejected'))
    return Promise.resolve(kind === 'sdk-error' ? { error: { data: { message: 'stop refused' } } } : { data: false })
  })
  const state = outcome(host.runChild(REQUEST))
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(state.error, original)
  assert.equal(log.mock.calls.length, 1)
  assert.match(String(log.mock.calls[0]), /ses_child.*(could not be stopped|did not confirm).*may still be running/)
  const diagnostic = { throw: 'stop transport threw', reject: 'stop transport rejected', 'sdk-error': 'stop refused', unconfirmed: 'did not confirm' }
  assert.ok(String(log.mock.calls[0]).includes(diagnostic[/** @type {keyof typeof diagnostic} */ (kind)]))
  assert.equal(vi.getTimerCount(), 0)
})

test('a prompt SDK error waits at most ten seconds for a hung abort, preserving its diagnostic', async () => {
  const { client, host, log } = setup()
  const abort = deferred()
  client.session.prompt.mockResolvedValue({ error: { name: 'UnknownError', data: { message: 'prompt refused' } } })
  client.session.abort.mockReturnValue(abort.promise)
  const state = outcome(host.runChild(REQUEST))
  await vi.advanceTimersByTimeAsync(9_999)
  assert.equal(state.settled, false, 'no failure may escape before the stop wait ends')
  await vi.advanceTimersByTimeAsync(1)
  assert.equal(state.settled, true)
  assert.match(String(state.error), /prompt refused/)
  assert.match(String(log.mock.calls[0]), /ses_child.*10000 ms.*may still be running/)
  abort.reject(new Error('late abort failure'))
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(log.mock.calls.length, 1)
  assert.equal(vi.getTimerCount(), 0)
})

test.each(['confirmed', 'throw', 'reject', 'sdk-error', 'hung'])('cancelling a hung prompt releases the next child after a bounded %s stop', async kind => {
  const { client, host, log } = setup()
  const prompt = deferred()
  const stop = new AbortController()
  client.session.prompt.mockReturnValueOnce(prompt.promise)
  client.session.abort.mockImplementation(() => {
    if (kind === 'throw') throw new Error('stop threw')
    if (kind === 'reject') return Promise.reject(new Error('stop rejected'))
    if (kind === 'hung') return new Promise(() => {})
    return Promise.resolve(kind === 'sdk-error' ? { error: { message: 'stop refused' } } : { data: true })
  })
  const run = childTasks(host, 'ses_parent', undefined, 1)
  const first = outcome(run(TASK, stop.signal))
  await vi.advanceTimersByTimeAsync(0)
  const next = outcome(run({ ...TASK, key: 2 }, new AbortController().signal))
  stop.abort()
  await vi.advanceTimersByTimeAsync(9_999)
  if (kind === 'hung') {
    assert.equal(first.settled, false)
    assert.equal(client.session.create.mock.calls.length, 1)
  }
  await vi.advanceTimersByTimeAsync(1)
  assert.equal(first.settled, true, 'cancellation settles even when both HTTP requests hang')
  assert.match(String(first.error), /stopped at its deadline/)
  assert.equal(next.value, 'ok', 'the queued child acquired the released slot')
  assert.equal(client.session.create.mock.calls.length, 2, 'the cancelled child was not retried')
  assert.deepEqual(client.session.abort.mock.calls, [[{ path: { id: 'ses_child' } }]])
  assert.equal(log.mock.calls.length, kind === 'confirmed' ? 0 : 1)
  prompt.reject(new Error('late prompt failure'))
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(vi.getTimerCount(), 0)
})

test('a failed agent loop keeps ChildSessionFailed and never retries or waits for abort', async () => {
  const { client, host } = setup()
  client.session.prompt.mockResolvedValue({ data: { info: { error: { name: 'APIError', data: { message: 'usage limit reached' } } }, parts: [] } })
  client.session.abort.mockImplementation(() => new Promise(() => {}))
  const state = outcome(childTasks(host, 'ses_parent')(TASK, new AbortController().signal))
  await vi.advanceTimersByTimeAsync(0)
  assert.ok(state.error instanceof ChildSessionFailed)
  assert.equal(state.error.type, 'APIError')
  assert.equal(state.error.detail, 'usage limit reached')
  assert.equal(client.session.create.mock.calls.length, 1)
  assert.equal(client.session.abort.mock.calls.length, 0)
})

test('cancellation during a hung create releases its slot and stops the exact late child without prompting or marking it', async () => {
  const { client, host, log } = setup()
  const create = deferred()
  const stop = new AbortController()
  client.session.create.mockReturnValueOnce(create.promise)
  client.session.abort.mockImplementation(() => new Promise(() => {}))
  const run = childTasks(host, 'ses_parent', undefined, 1)
  const first = outcome(run(TASK, stop.signal))
  await vi.advanceTimersByTimeAsync(0)
  const next = outcome(run({ ...TASK, key: 2 }, new AbortController().signal))
  stop.abort()
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(first.settled, true, 'the cancelled create cannot hold a turn waiting for its ID')
  assert.equal(next.value, 'ok')
  create.resolve({ data: { id: 'ses_late_exact' } })
  await vi.advanceTimersByTimeAsync(0)
  assert.deepEqual(client.session.abort.mock.calls, [[{ path: { id: 'ses_late_exact' } }]])
  assert.equal(client.session.prompt.mock.calls.length, 1, 'only the next child was prompted')
  assert.equal(ENGINE_SESSIONS.has('ses_late_exact'), false, 'late creation cannot leak the engine-session marker')
  await vi.advanceTimersByTimeAsync(10_000)
  assert.match(String(log.mock.calls[0]), /ses_late_exact.*10000 ms/)
  assert.equal(vi.getTimerCount(), 0)
})

test('a create that rejects after cancellation is handled without prompting', async () => {
  const { client, host } = setup()
  const create = deferred()
  const stop = new AbortController()
  client.session.create.mockReturnValueOnce(create.promise)
  const state = outcome(host.runChild({ ...REQUEST, signal: stop.signal }))
  await vi.advanceTimersByTimeAsync(0)
  stop.abort()
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(state.settled, true)
  create.reject(new Error('late create failure'))
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(client.session.prompt.mock.calls.length, 0)
  assert.equal(client.session.abort.mock.calls.length, 0)
})

test('cancellation on the published ID stops that child once and waits boundedly without prompting', async () => {
  const { client, host, log } = setup()
  const stop = new AbortController()
  client.session.abort.mockImplementation(() => new Promise(() => {}))
  const state = outcome(host.runChild({ ...REQUEST, signal: stop.signal, onSession: () => stop.abort() }))
  await vi.advanceTimersByTimeAsync(9_999)
  assert.equal(state.settled, false)
  assert.equal(client.session.prompt.mock.calls.length, 0)
  assert.deepEqual(client.session.abort.mock.calls, [[{ path: { id: 'ses_child' } }]])
  await vi.advanceTimersByTimeAsync(1)
  assert.match(String(state.error), /stopped at its deadline/)
  assert.equal(log.mock.calls.length, 1)
  assert.equal(vi.getTimerCount(), 0)
})

test('a create that cancels synchronously still stops its returned ID only once within the bound', async () => {
  const { client, host, log } = setup()
  const stop = new AbortController()
  client.session.create.mockImplementationOnce(async () => {
    stop.abort()
    return { data: { id: 'ses_sync_late' } }
  })
  client.session.abort.mockImplementation(() => new Promise(() => {}))
  const state = outcome(host.runChild({ ...REQUEST, signal: stop.signal }))
  await vi.advanceTimersByTimeAsync(10_000)
  assert.equal(state.settled, true)
  assert.match(String(state.error), /stopped at its deadline/)
  assert.deepEqual(client.session.abort.mock.calls, [[{ path: { id: 'ses_sync_late' } }]])
  assert.equal(client.session.prompt.mock.calls.length, 0)
  assert.equal(log.mock.calls.length, 1)
  assert.equal(vi.getTimerCount(), 0)
})

test('an aborted signal immediately after runChild does not start an SDK create', async () => {
  const { client, host } = setup()
  const stop = new AbortController()
  const state = outcome(host.runChild({ ...REQUEST, signal: stop.signal }))
  stop.abort()
  await vi.advanceTimersByTimeAsync(0)
  assert.match(String(state.error), /stopped at its deadline/)
  assert.equal(client.session.create.mock.calls.length, 0)
})

test.each([null, { error: { message: 'create refused' } }])('a create response without an ID fails without prompting or guessing an ID: %j', async reply => {
  const { client, host } = setup()
  client.session.create.mockResolvedValueOnce(reply)
  const state = outcome(host.runChild(REQUEST))
  await vi.advanceTimersByTimeAsync(0)
  assert.match(String(state.error), reply ? /create refused/ : /did not return a child session ID/)
  assert.equal(client.session.prompt.mock.calls.length, 0)
  assert.equal(client.session.abort.mock.calls.length, 0)
})
