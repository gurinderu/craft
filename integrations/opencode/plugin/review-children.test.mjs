// The 2.x review's delegated tasks as the plugin runs them: one child session each, under the caller, capped, a
// child that gave nothing back tried once more alone.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import os from 'node:os'
import { ENGINE_SESSIONS } from './child-run.ts'
import { ChildSessionFailed } from './host-v2.ts'
import { childCap, childTasks, inRepository, modelRef, slots, taskAgents } from './review-children.ts'

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
  assert.match(asked.prompt, /^WORKING DIRECTORY: this task reviews the repository at \/wt — run every command there \(`cd \/wt` first\)/)
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

test('a child that gave nothing back or broke is tried once more alone; a failed loop or a given-up task is not', async () => {
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

  const stop = new AbortController()
  const given = fakeHost(() => {
    stop.abort()
    return Promise.reject(new Error('stopped'))
  })
  await assert.rejects(childTasks(given, 'c')(task(), stop.signal), /stopped/)
  assert.equal(given.asked.length, 1)
})

test('slots hand each freed place to the next in turn', async () => {
  const slot = slots(1)
  /** @type {string[]} */
  const order = []
  const work = (/** @type {string} */ name) =>
    slot(async () => {
      order.push(`${name}+`)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(`${name}-`)
      return name
    })
  assert.deepEqual(await Promise.all([work('a'), work('b'), work('c')]), ['a', 'b', 'c'])
  assert.deepEqual(order, ['a+', 'a-', 'b+', 'b-', 'c+', 'c-'])
  await assert.rejects(slot(() => Promise.reject(new Error('x'))))
  assert.equal(await slot(() => Promise.resolve('after a failure the place is free')), 'after a failure the place is free')
})

test('the cap is CRAFT_OPENCODE_CONCURRENCY from 1 to 16, else 4', () => {
  assert.equal(childCap({}), 4)
  assert.equal(childCap({ CRAFT_OPENCODE_CONCURRENCY: '7' }), 7)
  for (const bad of ['0', '17', '2.5', 'x']) assert.equal(childCap({ CRAFT_OPENCODE_CONCURRENCY: bad }), 4, bad)
  assert.equal(childCap({ CRAFT_OPENCODE_CONCURRENCY: '1' }), 1)
  assert.equal(childCap({ CRAFT_OPENCODE_CONCURRENCY: '16' }), 16)
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
