// The 2.x review's delegated tasks as the plugin runs them: one child session each, under the caller, capped, a
// child that gave nothing back tried once more alone.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import os from 'node:os'
import { ENGINE_SESSIONS } from './child-run.ts'
import { ChildSessionFailed } from './host-v2.ts'
import { GIVEN_UP, childCap, childTasks, inRepository, modelRef, taskAgents, turns } from './review-children.ts'

/** @param {(req: import('./host.ts').ChildRequest) => Promise<string>} runChild @returns {import('./host.ts').Host & { asked: import('./host.ts').ChildRequest[] }} */
function fakeHost(runChild = () => Promise.resolve('reply')) {
  /** @type {import('./host.ts').ChildRequest[]} */
  const asked = []
  return {
    asked,
    directory: os.tmpdir(),
    worktree: os.tmpdir(),
    sh: () => Promise.resolve(''),
    callerModel: () => Promise.resolve(undefined),
    runChild: req => {
      asked.push(req)
      return runChild(req)
    },
  }
}

/** @param {Partial<import('../../shared/craft-review-run.mjs').DelegatedTask>} [over] @returns {import('../../shared/craft-review-run.mjs').DelegatedTask} */
const task = over => ({ key: 1, id: 't1', label: 'lens a', agent: 'review-task', model: null, cwd: '/wt', prompt: 'read p.md', ...over })

test("a model the binary names is read as provider, model and variant; none, no provider or no model is the caller's", () => {
  assert.deepEqual(modelRef('anthropic/claude-x'), { providerID: 'anthropic', modelID: 'claude-x' })
  assert.deepEqual(modelRef('openrouter/a/b#high'), { providerID: 'openrouter', modelID: 'a/b', variant: 'high' })
  for (const none of [null, 'bare', '/m', 'p/', 'p/#v']) assert.equal(modelRef(none), undefined, String(none))
})

test('a delegated task runs as one child session under the caller, on its agent and model, headed by its repository', async () => {
  const host = fakeHost(req => {
    req.onSession?.('ses_child')
    marked.push(ENGINE_SESSIONS.has('ses_child'))
    return Promise.resolve('reply')
  })
  /** @type {boolean[]} */
  const marked = []
  const stop = new AbortController()
  assert.equal(await childTasks(host, 'ses_caller')(task({ model: 'p/m#v' }), stop.signal), 'reply')
  const { onSession, ...asked } = host.asked[0] ?? {}
  assert.ok(onSession)
  assert.deepEqual(asked, {
    title: 'craft review: lens a',
    agent: 'review-task',
    prompt: inRepository('/wt', 'read p.md'),
    signal: stop.signal,
    model: { providerID: 'p', modelID: 'm', variant: 'v' },
    parentID: 'ses_caller',
  })
  assert.match(asked.prompt, /^WORKING DIRECTORY: this task reviews the repository at the absolute path "\/wt", not the directory/)
  assert.doesNotMatch(asked.prompt, /`cd /, 'never asked to cd')
  assert.match(inRepository('/a "b"; rm -rf ~', 'p'), /at the absolute path "\/a \\"b\\"; rm -rf ~", not/, 'quoted as a JSON string')
  assert.deepEqual(marked, [true], "the child is the engine's while it runs: the work hook stays silent there")
})

test("a task naming no agent runs on review-task, never the runtime's default; one naming no model on the caller's", async () => {
  const host = fakeHost()
  const caller = { providerID: 'p', modelID: 'm', variant: 'high' }
  await childTasks(host, undefined, caller)(task({ agent: null }), new AbortController().signal)
  const [child] = host.asked
  assert.ok(child)
  assert.equal(child.agent, 'review-task')
  assert.deepEqual(child.model, caller)
  assert.equal(child.parentID, undefined, 'no caller: top-level')
})

test('at most the cap of children run at once', async () => {
  let live = 0
  let most = 0
  const host = fakeHost(async () => {
    most = Math.max(most, ++live)
    await new Promise(resolve => setTimeout(resolve, 10))
    live--
    return 'ok'
  })
  const run = childTasks(host, 'ses_caller', undefined, 2)
  const signal = new AbortController().signal
  await Promise.all([1, 2, 3, 4, 5].map(key => run(task({ key }), signal)))
  assert.equal(host.asked.length, 5)
  assert.equal(most, 2)
})

/** A promise settled by hand. */
function manual() {
  /** @type {(v: string) => void} */
  let resolve = () => {}
  /** @type {(e: unknown) => void} */
  let reject = () => {}
  const promise = /** @type {Promise<string>} */ (
    new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
  )
  return { promise, resolve, reject }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('a child that gave nothing back or broke is tried once more; a failed loop is not', async () => {
  const answers = ['', 'second']
  const empty = fakeHost(() => Promise.resolve(answers.shift() ?? ''))
  assert.equal(await childTasks(empty, 'c')(task(), new AbortController().signal), 'second')
  assert.equal(empty.asked.length, 2)

  let broke = true
  const broken = fakeHost(() => (broke ? ((broke = false), Promise.reject(new Error('session never ran'))) : Promise.resolve('ok')))
  assert.equal(await childTasks(broken, 'c')(task(), new AbortController().signal), 'ok')
  assert.equal(broken.asked.length, 2)

  const failed = fakeHost(() => Promise.reject(new ChildSessionFailed('provider.no-route', 'no route')))
  await assert.rejects(childTasks(failed, 'c')(task(), new AbortController().signal), /provider\.no-route/)
  assert.equal(failed.asked.length, 1, "the runtime's own error is the task's answer")
})

test('a given-up task is never tried again, whether its child broke or gave nothing back', async () => {
  const given = (/** @type {() => Promise<string>} */ settle) => {
    const stop = new AbortController()
    const host = fakeHost(() => {
      stop.abort()
      return settle()
    })
    return { host, ran: childTasks(host, 'c')(task(), stop.signal) }
  }
  const broke = given(() => Promise.reject(new Error('stopped')))
  await assert.rejects(broke.ran, (/** @type {unknown} */ e) => e instanceof Error && e.message === 'stopped')
  assert.equal(broke.host.asked.length, 1)
  const empty = given(() => Promise.resolve(''))
  assert.equal(await empty.ran, '', 'its empty reply stands: no retry was asked for')
  assert.equal(empty.host.asked.length, 1)
})

test('when the retry fails too, the first error is kept and the retry said beside it', async () => {
  const errors = [new Error('prompt refused'), new Error('context unreadable')]
  const host = fakeHost(() => Promise.reject(errors.shift() ?? new Error('?')))
  await assert.rejects(childTasks(host, 'c')(task(), new AbortController().signal), (/** @type {unknown} */ e) => {
    assert.ok(e instanceof Error)
    assert.equal(e.message, 'prompt refused (tried once more alone: context unreadable)')
    assert.equal(/** @type {Error} */ (e.cause).message, 'prompt refused')
    return true
  })
})

test('the retry runs alone: it waits for every other child of the review, and none starts beside it', async () => {
  /** @type {Map<string, ReturnType<typeof manual>>} */
  const open = new Map()
  /** @type {string[]} */
  const log = []
  let calls = 0
  const host = fakeHost(req => {
    const name = `${req.title}#${++calls}`
    log.push(`+${name}`)
    const m = manual()
    open.set(name, m)
    return m.promise.finally(() => log.push(`-${name}`))
  })
  const run = childTasks(host, 'c', undefined, 3)
  const signal = new AbortController().signal
  const a = run(task({ label: 'a' }), signal)
  const b = run(task({ label: 'b' }), signal)
  await tick()
  open.get('craft review: a#1')?.resolve('') // a gave nothing back: its retry must wait for b
  await tick()
  const c = run(task({ label: 'c' }), signal) // asked after the retry: waits behind it
  await tick()
  assert.deepEqual(log, ['+craft review: a#1', '+craft review: b#2', '-craft review: a#1'])
  open.get('craft review: b#2')?.resolve('b')
  await tick()
  assert.deepEqual(log.slice(3), ['-craft review: b#2', '+craft review: a#3'], 'the retry alone, c not beside it')
  open.get('craft review: a#3')?.resolve('a')
  await tick()
  assert.deepEqual(log.slice(5), ['-craft review: a#3', '+craft review: c#4'])
  open.get('craft review: c#4')?.resolve('c')
  assert.deepEqual(await Promise.all([a, b, c]), ['a', 'b', 'c'])
})

test("a queued retry is bounded by the task's deadline: given up while it waits, it never starts", async () => {
  const hold = manual()
  let calls = 0
  const host = fakeHost(() => (++calls === 1 ? hold.promise : Promise.resolve('')))
  const run = childTasks(host, 'c', undefined, 2)
  const busy = run(task({ label: 'busy' }), new AbortController().signal) // holds a turn: the retry must wait
  await tick()
  const stop = new AbortController()
  const waiting = run(task({ label: 'w' }), stop.signal)
  await tick()
  stop.abort()
  await assert.rejects(waiting, new RegExp(GIVEN_UP))
  hold.resolve('done')
  assert.equal(await busy, 'done')
  assert.equal(await run(task({ label: 'next' }), new AbortController().signal), '', 'the given-up wait holds no turn')
  assert.equal(host.asked.filter(r => r.title === 'craft review: w').length, 1, 'the retry never started')
})

test('turns: at most the cap shared, each in the order it asked, and a place freed after a failure', async () => {
  const turn = turns(1)
  const signal = new AbortController().signal
  /** @type {string[]} */
  const order = []
  const work = (/** @type {string} */ name) =>
    turn.shared(async () => {
      order.push(`${name}+`)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(`${name}-`)
      return name
    }, signal)
  assert.deepEqual(await Promise.all([work('a'), work('b'), work('c')]), ['a', 'b', 'c'])
  assert.deepEqual(order, ['a+', 'a-', 'b+', 'b-', 'c+', 'c-'])
  await assert.rejects(turn.shared(() => Promise.reject(new Error('x')), signal))
  assert.equal(await turn.alone(() => Promise.resolve('free'), signal), 'free')
  const gone = new AbortController()
  gone.abort()
  await assert.rejects(
    turn.shared(() => Promise.resolve('never'), gone.signal),
    new RegExp(GIVEN_UP),
  )
})

test("the cap is the review's --concurrency, else CRAFT_OPENCODE_CONCURRENCY, from 1 to 16, else 4", () => {
  assert.equal(childCap([], {}), 4)
  assert.equal(childCap([], { CRAFT_OPENCODE_CONCURRENCY: '7' }), 7)
  for (const bad of ['0', '17', '2.5', 'x']) assert.equal(childCap([], { CRAFT_OPENCODE_CONCURRENCY: bad }), 4, bad)
  assert.equal(childCap([], { CRAFT_OPENCODE_CONCURRENCY: '1' }), 1)
  assert.equal(childCap([], { CRAFT_OPENCODE_CONCURRENCY: '16' }), 16)
  assert.equal(childCap(['--base', 'main', '--concurrency', '2'], { CRAFT_OPENCODE_CONCURRENCY: '7' }), 2, 'the flag first')
  assert.equal(childCap(['--concurrency=3'], {}), 3)
  assert.equal(childCap(['--concurrency', '99'], { CRAFT_OPENCODE_CONCURRENCY: '5' }), 5, 'a flag out of range: the env')
})

test('the agents listing fails closed', async () => {
  assert.deepEqual(await taskAgents({ ...fakeHost(), agents: () => Promise.resolve(['review-task', 'x']) }), { agents: ['review-task', 'x'] })
  for (const host of [
    fakeHost(),
    { ...fakeHost(), agents: () => Promise.reject(new Error('gone')) },
    { ...fakeHost(), agents: () => Promise.resolve(['x']) },
  ]) {
    const got = await taskAgents(host)
    assert.ok('refused' in got)
    assert.match(got.refused, /^⚠️ INCOMPLETE — .*Nothing ran\.$/)
  }
})

test('the shared turns queued behind a given-up alone retry still run', async () => {
  const turn = turns(1)
  const signal = new AbortController().signal
  const hold = manual()
  const busy = turn.shared(() => hold.promise, signal)
  const stop = new AbortController()
  const alone = turn.alone(() => Promise.resolve('never'), stop.signal)
  const behind = turn.shared(() => Promise.resolve('behind'), signal)
  await tick()
  stop.abort()
  await assert.rejects(alone, new RegExp(GIVEN_UP))
  hold.resolve('busy')
  assert.deepEqual(await Promise.all([busy, behind]), ['busy', 'behind'])
})
