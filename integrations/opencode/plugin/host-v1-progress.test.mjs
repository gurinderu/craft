import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { runV1Tool } from './host-v1-progress.ts'
import { v1Hooks } from './host-v1.ts'

afterEach(() => vi.useRealTimers())

function fixture() {
  vi.useFakeTimers()
  /** @type {import('./host.ts').ToolCall | undefined} */
  let call
  /** @type {(value: import('./host.ts').ToolAnswer) => void} */
  let resolve = () => {}
  /** @type {(reason: Error) => void} */
  let reject = () => {}
  const answer = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  const metadata = vi.fn()
  const log = vi.fn()
  const abort = new AbortController()
  const spec = {
    name: 'review',
    description: 'probe',
    args: {},
    run: (/** @type {import('./host.ts').Host} */ _host, /** @type {unknown} */ _args, /** @type {import('./host.ts').ToolCall} */ given) => {
      call = given
      return answer
    },
  }
  const context = {
    sessionID: 'ses_parent',
    messageID: 'msg_parent',
    agent: 'build',
    directory: '/repo',
    worktree: '/repo',
    metadata,
    abort: abort.signal,
    ask: async () => {},
  }
  const host = /** @type {import('./host.ts').Host} */ ({})
  const showToast = vi.fn().mockResolvedValue({ data: true })
  const start = (tui = true) => runV1Tool(host, spec, {}, context, tui ? { showToast } : undefined, log)
  const progress = (/** @type {string} */ title) => call?.progress?.(title)
  return { start, progress, resolve, reject, showToast, metadata, log, abort, spec, context }
}

test('review progress stays visible during a quiet child and expires after its final result', async () => {
  const f = fixture()
  const running = f.start()
  f.progress('scout — 1 running, 0 done')
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(f.showToast.mock.calls[0]?.[0].body.message, 'scout — 1 running, 0 done')
  assert.deepEqual(f.metadata.mock.calls[0], [{ title: 'scout — 1 running, 0 done' }])
  await vi.advanceTimersByTimeAsync(15000)
  assert.ok(f.showToast.mock.calls.length >= 3, 'quiet phases renew the finite notice')
  for (const [input] of f.showToast.mock.calls) assert.equal(input.body.duration, 10000)
  f.progress('review — 2 running, 3 done')
  const answer = { title: 'craft review: Warning', output: 'the report' }
  f.resolve(answer)
  await vi.advanceTimersByTimeAsync(0)
  assert.deepEqual(await running, answer)
  assert.deepEqual(f.showToast.mock.lastCall?.[0].body, { title: 'craft review', message: answer.title, variant: 'info', duration: 5000 })
  const count = f.showToast.mock.calls.length
  f.progress('late callback')
  await vi.advanceTimersByTimeAsync(20000)
  assert.equal(f.showToast.mock.calls.length, count, 'completion stops renewal and ignores late progress')
  assert.equal(vi.getTimerCount(), 0)
})

test.each([0, 1, 2, 3, 4, 5, 6, 7])('the final notice survives completion %i microtasks after the previous delivery', async delay => {
  const f = fixture()
  /** @type {(value: unknown) => void} */
  let delivered = () => {}
  f.showToast.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        delivered = resolve
      }),
  )
  const running = f.start()
  f.progress('running')
  delivered({ data: true })
  for (let i = 0; i < delay; i++) await Promise.resolve()
  f.resolve({ title: 'end', output: 'ok' })
  await running
  assert.equal(f.showToast.mock.lastCall?.[0].body.message, 'end')
  assert.equal(vi.getTimerCount(), 0)
})

test('a stalled UI request is bounded, coalesces progress and cannot hold the review result', async () => {
  const f = fixture()
  f.showToast.mockImplementationOnce(() => new Promise(() => {}))
  const running = f.start()
  f.progress('old')
  await vi.advanceTimersByTimeAsync(0)
  const firstSignal = f.showToast.mock.calls[0]?.[0].signal
  f.progress('intermediate')
  f.progress('newest')
  assert.equal(f.showToast.mock.calls.length, 1, 'at most one toast request in flight')
  await vi.advanceTimersByTimeAsync(2000)
  assert.equal(firstSignal.aborted, true)
  assert.equal(f.showToast.mock.lastCall?.[0].body.message, 'newest')
  assert.equal(f.log.mock.calls.length, 1)
  f.resolve({ title: 'end', output: 'ok' })
  await vi.advanceTimersByTimeAsync(0)
  assert.deepEqual(await running, { title: 'end', output: 'ok' })
  assert.equal(vi.getTimerCount(), 0)
})

test('failed UI deliveries are said once and cancellation keeps its original error', async () => {
  const f = fixture()
  f.showToast.mockResolvedValue({ error: { message: 'UI gone' } })
  const error = new Error('review aborted')
  const running = f.start()
  const checked = assert.rejects(running, e => e === error)
  f.progress('first')
  await vi.advanceTimersByTimeAsync(0)
  f.progress('second')
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(f.log.mock.calls.length, 1)
  f.abort.abort()
  f.reject(error)
  await vi.advanceTimersByTimeAsync(0)
  await checked
  assert.equal(f.showToast.mock.lastCall?.[0].body.message, 'craft review: stopped')
  assert.equal(vi.getTimerCount(), 0)
})

test('synchronous UI throws and hung final notices never replace the report', async () => {
  const f = fixture()
  f.showToast
    .mockImplementationOnce(() => {
      throw new Error('broken SDK')
    })
    .mockImplementation(() => new Promise(() => {}))
  const running = f.start()
  f.progress('start')
  await vi.advanceTimersByTimeAsync(0)
  f.resolve({ title: 'end', output: 'ok' })
  await vi.advanceTimersByTimeAsync(2000)
  assert.deepEqual(await running, { title: 'end', output: 'ok' })
  assert.equal(f.log.mock.calls.length, 1)
  assert.equal(vi.getTimerCount(), 0)
})

test('other tools keep metadata without review notifications', async () => {
  const f = fixture()
  f.spec.name = 'rust-audit'
  const running = f.start()
  f.progress('half')
  f.resolve({ title: 'end', output: 'ok' })
  await running
  assert.equal(f.showToast.mock.calls.length, 0)
  assert.deepEqual(f.metadata.mock.calls, [[{ title: 'half' }]])
})

test('a host without notifications still gives its report and says what was unavailable', async () => {
  const f = fixture()
  const running = f.start(false)
  f.progress('phase')
  f.resolve({ title: 'end', output: 'ok' })
  assert.deepEqual(await running, { title: 'end', output: 'ok' })
  assert.equal(f.showToast.mock.calls.length, 0)
  assert.match(String(f.log.mock.calls[0]?.[0]), /no TUI notification API/)
  assert.equal(vi.getTimerCount(), 0)
})

test('the registered 1.x review tool connects the SDK TUI to live progress', async () => {
  const f = fixture()
  const hooks = v1Hooks({ client: { tui: { showToast: f.showToast } }, directory: '/repo', worktree: '/repo' }, [f.spec], {
    childCreated() {},
    message: async () => {},
    compacted: async () => {},
  })
  const tool = hooks.tool?.['review']
  assert.ok(tool)
  const running = tool.execute({}, f.context)
  f.progress('review — 1 running, 2 done')
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(f.showToast.mock.calls[0]?.[0].body.message, 'review — 1 running, 2 done')
  f.resolve({ title: 'end', output: 'ok' })
  await running
  assert.equal(vi.getTimerCount(), 0)
})
