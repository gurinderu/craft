// The 2.x side of the host against a fake `ctx` shaped as opencode-v2.d.ts pins it (observed on 2.2.7).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ChildSessionFailed, finishedReply, v2Host, v2Setup, v2Tool } from './host-v2.ts'
import { onV2, TOOLS } from './tools.ts'

const assistant = (/** @type {string} */ text) => ({
  type: 'assistant',
  finish: 'stop',
  content: [
    { type: 'reasoning', text: 'hm' },
    { type: 'text', text },
  ],
})

// The entry that ends a session's context once its agent loop succeeded, as 2.2.7 returns it (realm @nick/craft, nodes
// #626, #627).
const IDLE = { type: 'idle', outcome: 'succeeded' }
/** A finished child's context: the prompt, the reply, the idle entry. @param {string} text */
const answered = text => [{ type: 'user' }, assistant(text), IDLE]

/** @param {unknown[][]} contexts what successive `context` reads return */
function fakeCtx(contexts = []) {
  /** @type {unknown[]} */
  const sent = []
  /** @type {any[]} */
  const tools = []
  /** @type {Record<string, (input: any) => unknown>} */
  const hooks = {}
  /** @type {any[]} */
  const queue = []
  let disposed = 0
  const reg = {
    dispose: () => {
      disposed++
      return Promise.resolve()
    },
  }
  const ctx = /** @type {import('./opencode-v2.js').V2Context} */ (
    /** @type {unknown} */ ({
      app: { version: '2.2.7' },
      location: { directory: '/repo', project: { directory: '/root' } },
      agent: { list: () => Promise.resolve({ location: { directory: '/repo' }, data: [{ id: 'build' }, { id: 'review-task' }] }) },
      tool: {
        transform: (/** @type {any} */ edit) => {
          edit({ add: (/** @type {any} */ d) => tools.push(d) })
          return Promise.resolve(reg)
        },
      },
      session: {
        create: (/** @type {unknown} */ input) => {
          sent.push(['create', input])
          return Promise.resolve({ id: 'ses_1' })
        },
        get: (/** @type {{ sessionID: string }} */ { sessionID }) =>
          Promise.resolve(sessionID === 'ses_set' ? { id: sessionID, model: { providerID: 'p', id: 'm', variant: 'default' } } : { id: sessionID }),
        prompt: (/** @type {unknown} */ input) => {
          sent.push(['prompt', input])
          return Promise.resolve()
        },
        wait: () => {
          sent.push(['wait'])
          return Promise.resolve()
        },
        interrupt: (/** @type {unknown} */ input) => {
          sent.push(['interrupt', input])
          return Promise.resolve({ interrupted: true })
        },
        context: () => Promise.resolve(contexts.shift() ?? []),
        hook: (/** @type {string} */ name, /** @type {any} */ cb) => {
          hooks[name] = cb
          return Promise.resolve(reg)
        },
      },
      event: {
        subscribe: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve(queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }),
            return: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
      },
    })
  )
  return { ctx, sent, tools, hooks, queue, disposed: () => disposed }
}

test('a child session is created with its agent and model, prompted, and read once it has finished', async () => {
  // The first read finds only the admitted prompt: `wait` can return before the loop starts.
  const f = fakeCtx([[{ type: 'user' }], answered('VERDICT: APPROVE')])
  /** @type {string[]} */
  const named = []
  const text = await v2Host(f.ctx, 0).runChild({
    title: 'craft:rust-reviewer',
    agent: 'rust-reviewer',
    prompt: 'p',
    model: { providerID: 'anthropic', modelID: 'claude-x' },
    onSession: id => named.push(id),
  })
  assert.equal(text, 'VERDICT: APPROVE')
  assert.deepEqual(named, ['ses_1'])
  assert.deepEqual(f.sent, [
    ['create', { title: 'craft:rust-reviewer', agent: 'rust-reviewer', model: { providerID: 'anthropic', id: 'claude-x' } }],
    ['prompt', { sessionID: 'ses_1', text: 'p' }],
    ['wait'],
    ['wait'],
  ])
})

test("a child nests under its parent, and the caller's model is the one its session records", async () => {
  const f = fakeCtx([answered('x')])
  const host = v2Host(f.ctx, 0)
  await host.runChild({ title: 't', agent: '', prompt: 'p', parentID: 'ses_parent' })
  assert.deepEqual(f.sent[0], ['create', { title: 't', parentID: 'ses_parent' }])
  assert.deepEqual(await host.callerModel('ses_set'), { providerID: 'p', modelID: 'm', variant: 'default' }, 'its variant kept')
  assert.equal(await host.callerModel('ses_unset'), undefined, 'a session that set none runs on the runtime default')
  assert.deepEqual(await host.agents?.(), ['build', 'review-task'], "the runtime's agents by id")
})

test("a model's variant goes to the session with it", async () => {
  const f = fakeCtx([answered('x')])
  await v2Host(f.ctx, 0).runChild({ title: 't', agent: '', prompt: 'p', model: { providerID: 'p', modelID: 'm', variant: 'high' } })
  assert.deepEqual(f.sent[0], ['create', { title: 't', model: { providerID: 'p', id: 'm', variant: 'high' } }])
})

test('the default agent and model are left to the session', async () => {
  const f = fakeCtx([answered('x')])
  await v2Host(f.ctx, 0).runChild({ title: 't', agent: '', prompt: 'p' })
  assert.deepEqual(f.sent[0], ['create', { title: 't' }])
})

test('only an idle loop has a reply: the last assistant message before the idle entry', () => {
  assert.equal(finishedReply([]), null)
  assert.equal(finishedReply([{ type: 'user' }]), null, 'admitted, the loop not started')
  assert.equal(finishedReply([{ type: 'user' }, assistant('mid-loop')]), null, 'an assistant message ends a step, not the loop')
  assert.equal(finishedReply(answered(' a ')), 'a', 'the reply sits behind the idle entry')
  assert.equal(finishedReply([{ type: 'user' }, assistant('first'), { type: 'tool' }, assistant('last'), IDLE]), 'last')
  assert.equal(finishedReply([{ type: 'user' }, IDLE]), '', 'idle, said nothing')
})

test('only a succeeded loop has a reply: an interrupted one, or an outcome this reader does not know, is a named error', () => {
  for (const outcome of ['interrupted', 'completed', undefined]) {
    assert.throws(
      () => finishedReply([{ type: 'user' }, assistant('half'), { type: 'idle', ...(outcome ? { outcome } : {}) }]),
      (/** @type {unknown} */ e) =>
        e instanceof ChildSessionFailed &&
        e.type === `outcome ${outcome ?? 'none'}` &&
        e.message === `the child session failed (outcome ${outcome ?? 'none'}): the agent loop ended without succeeding`,
      String(outcome),
    )
  }
})

test('a child given up before its session exists is never made, and one given up while it was made is never prompted', async () => {
  const before = fakeCtx()
  const stop = new AbortController()
  stop.abort()
  await assert.rejects(v2Host(before.ctx, 0).runChild({ title: 't', agent: '', prompt: 'p', signal: stop.signal }), /stopped at its deadline/)
  assert.deepEqual(before.sent, [])
  const during = fakeCtx()
  const late = new AbortController()
  const create = during.ctx.session.create.bind(during.ctx.session)
  during.ctx.session.create = async input => {
    const made = await create(input)
    late.abort()
    return made
  }
  await assert.rejects(v2Host(during.ctx, 0).runChild({ title: 't', agent: '', prompt: 'p', signal: late.signal }), /stopped at its deadline/)
  assert.deepEqual(
    during.sent.map(e => /** @type {unknown[]} */ (e)[0]),
    ['create'],
    'made, never prompted',
  )
})

test('a failed loop throws its error, by type and message', () => {
  const failed = [{ type: 'user' }, { type: 'idle', outcome: 'failed', error: { type: 'provider.no-route', message: 'no route to model x' } }]
  assert.throws(
    () => finishedReply(failed),
    (/** @type {unknown} */ e) =>
      e instanceof ChildSessionFailed &&
      e.type === 'provider.no-route' &&
      e.detail === 'no route to model x' &&
      e.message === 'the child session failed (provider.no-route): no route to model x',
  )
  assert.throws(() => finishedReply([{ type: 'idle', outcome: 'failed' }]), /the child session failed \(unknown\)$/)
})

test('a child whose loop failed rejects with that error, not a silent empty reply', async () => {
  const f = fakeCtx([
    [{ type: 'user' }],
    [{ type: 'user' }, { type: 'idle', outcome: 'failed', error: { type: 'provider.usage-limit', message: "You've hit your usage limit" } }],
  ])
  await assert.rejects(v2Host(f.ctx, 0).runChild({ title: 't', agent: '', prompt: 'p' }), {
    name: 'ChildSessionFailed',
    type: 'provider.usage-limit',
    message: "the child session failed (provider.usage-limit): You've hit your usage limit",
  })
})

test('a tool spec becomes a JSON Schema tool whose result is text content, a titled answer its output', async () => {
  /** @type {unknown[]} */
  const ran = []
  const spec = {
    name: 'probe',
    description: 'd',
    args: { base: { optional: true }, locator: { optional: false } },
    run: (/** @type {unknown} */ _host, /** @type {Record<string, string | undefined>} */ args, /** @type {unknown} */ call) => {
      ran.push([args, call])
      return Promise.resolve({ title: 't', output: 'out' })
    },
  }
  const def = v2Tool(v2Host(fakeCtx().ctx), spec)
  assert.deepEqual(def.input, {
    type: 'object',
    properties: { base: { type: 'string' }, locator: { type: 'string' } },
    required: ['locator'],
    additionalProperties: false,
  })
  const signal = new AbortController().signal
  const result = await def.execute({ locator: 'x' }, { sessionID: 's', messageID: 'm', id: 'c', agent: 'build', signal })
  assert.deepEqual(result, { content: [{ type: 'text', text: 'out' }] })
  assert.deepEqual(ran, [
    [
      { base: undefined, locator: 'x' },
      { sessionID: 's', signal },
    ],
  ])
})

test('setup registers the tools, hooks the prompt, maps the events, and disposes all of it', async () => {
  const f = fakeCtx()
  /** @type {unknown[]} */
  const seen = []
  const work = {
    childCreated: (/** @type {unknown[]} */ ...a) => {
      seen.push(['child', ...a])
    },
    compacted: (/** @type {string} */ s) => {
      seen.push(['compacted', s])
      return Promise.resolve()
    },
    message: (/** @type {string} */ s, /** @type {string} */ p, /** @type {unknown} */ a, /** @type {(t: string) => boolean} */ deliver) => {
      seen.push(['message', s, p, a, deliver('craft lines')])
      return Promise.resolve()
    },
  }
  f.queue.push(
    { type: 'session.created', data: { sessionID: 'top' } },
    { type: 'session.created', data: { sessionID: 'c', parentID: 'p', agent: 'general' } },
    { type: 'session.compaction.ended', data: { sessionID: 'p' } },
  )
  const spec = { name: 'probe', description: 'd', args: {}, run: () => Promise.resolve('') }
  const dispose = await v2Setup(f.ctx, [spec], work)
  assert.deepEqual(
    f.tools.map(t => t.name),
    ['probe'],
  )
  const input = { sessionID: 'p', messageID: 'm', prompt: { text: 'review it' }, delivery: 'steer' }
  await f.hooks['prompt']?.(input)
  assert.equal(input.prompt.text, 'review it\n\ncraft lines', 'the lines are appended to the prompt itself')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(seen, [
    ['child', 'c', 'p', 'general'],
    ['compacted', 'p'],
    ['message', 'p', 'review it', undefined, true],
  ])
  await dispose()
  assert.equal(f.disposed(), 2)
})

test('a deadline interrupts the session and stops the polling', async () => {
  const f = fakeCtx([[{ type: 'user' }], [{ type: 'user' }], [{ type: 'user' }]])
  const stop = new AbortController()
  const ctx = f.ctx
  const wait = ctx.session.wait.bind(ctx.session)
  ctx.session.wait = async input => {
    await wait(input)
    stop.abort()
  }
  await assert.rejects(v2Host(ctx, 0).runChild({ title: 't', agent: '', prompt: 'p', signal: stop.signal }), /stopped at its deadline/)
  assert.deepEqual(f.sent.filter(e => Array.isArray(e) && e[0] === 'wait').length, 1, 'no read after the abort')
  assert.deepEqual(f.sent.at(-1), ['interrupt', { sessionID: 'ses_1' }])
})

test('the audit and the triage on the 2.x entry refuse up front and say so; the review runs its tasks as child sessions', async () => {
  const f = fakeCtx()
  await v2Setup(f.ctx, onV2(TOOLS), { childCreated: () => {}, compacted: async () => {}, message: async () => {} })
  assert.deepEqual(
    f.tools.map(t => t.name),
    ['rust-audit', 'triage-findings', 'review'],
    'all three stay registered',
  )
  const [review, ...workflows] = [f.tools.find(t => t.name === 'review'), ...f.tools.filter(t => t.name !== 'review')]
  assert.match(review?.description ?? '', /each task runs as a child session of this session/, 'the review runs child sessions, not opencode run')
  for (const tool of workflows) {
    const out = await tool.execute({ locator: 'x' }, { sessionID: 'ses_set', messageID: 'm', id: 'c', agent: 'build', signal: new AbortController().signal })
    assert.match(
      out.content[0].text,
      new RegExp(
        `INCOMPLETE — craft's \`${tool.name}\` is not yet enabled in OpenCode 2\\.x: .*use OpenCode 1\\.x, Claude Code, Codex or pi\\. Nothing ran\\.`,
      ),
    )
    assert.match(tool.description, /^Not available on OpenCode 2\.x yet/)
  }
  assert.equal(f.sent.filter(s => /** @type {unknown[]} */ (s)[0] === 'create').length, 0)
})

test('the polling leaves no abort listener behind, however many reads it takes', async () => {
  const f = fakeCtx([[{ type: 'user' }], [{ type: 'user' }], [{ type: 'user' }], answered('done')])
  const stop = new AbortController()
  let live = 0
  let most = 0
  const add = stop.signal.addEventListener.bind(stop.signal)
  const remove = stop.signal.removeEventListener.bind(stop.signal)
  stop.signal.addEventListener = (/** @type {any[]} */ ...a) => {
    most = Math.max(most, ++live)
    add(.../** @type {[any, any, any]} */ (a))
  }
  stop.signal.removeEventListener = (/** @type {any[]} */ ...a) => {
    live--
    remove(.../** @type {[any, any]} */ (a))
  }
  assert.equal(await v2Host(f.ctx, 0).runChild({ title: 't', agent: '', prompt: 'p', signal: stop.signal }), 'done')
  assert.equal(live, 0)
  assert.ok(most <= 2, `at most the session's stop and one poll's listener at once, saw ${most}`)
})

test('a wait that never returns does not hold the polling past the abort', async () => {
  const f = fakeCtx()
  const stop = new AbortController()
  f.ctx.session.wait = () => {
    setTimeout(() => stop.abort(), 5)
    return new Promise(() => {})
  }
  await assert.rejects(v2Host(f.ctx, 0).runChild({ title: 't', agent: '', prompt: 'p', signal: stop.signal }), /stopped at its deadline/)
  assert.deepEqual(f.sent.at(-1), ['interrupt', { sessionID: 'ses_1' }])
})

test("setup carries a tool's progress to the craft.review channel and disposes it", async () => {
  const f = fakeCtx()
  /** @type {unknown[]} */
  const emitted = []
  let rpcDisposed = 0
  Object.assign(f.ctx, {
    rpc: {
      register: async () => ({
        dispose: async () => {
          rpcDisposed++
        },
        events: { emit: async (/** @type {string} */ name, /** @type {unknown} */ data) => emitted.push([name, data]) },
      }),
    },
  })
  const spec = {
    name: 'review',
    description: 'd',
    args: {},
    run: async (/** @type {unknown} */ _h, /** @type {unknown} */ _a, /** @type {import('./host.ts').ToolCall} */ call) => {
      call.progress?.('half')
      return { title: 'craft review: Approve', output: 'out' }
    },
  }
  const work = { childCreated: () => {}, compacted: async () => {}, message: async () => {} }
  const dispose = await v2Setup(f.ctx, [spec], work)
  const signal = new AbortController().signal
  await f.tools[0].execute({}, { sessionID: 's', messageID: 'm', id: 'c', agent: 'build', signal })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(emitted, [
    ['progress', { sessionID: 's', line: 'half', done: false }],
    ['progress', { sessionID: 's', line: 'craft review: Approve', done: true }],
  ])
  await dispose()
  assert.equal(rpcDisposed, 1)
})

test('a child that broke after its session was made is interrupted before the error reaches the caller', async () => {
  const f = fakeCtx()
  f.ctx.session.context = () => Promise.reject(new Error('context unreadable'))
  await assert.rejects(v2Host(f.ctx, 0).runChild({ title: 't', agent: '', prompt: 'p' }), /context unreadable/)
  assert.deepEqual(f.sent.at(-1), ['interrupt', { sessionID: 'ses_1' }])
  const failed = fakeCtx([[{ type: 'user' }, { type: 'idle', outcome: 'failed', error: { type: 'x', message: 'y' } }]])
  await assert.rejects(v2Host(failed.ctx, 0).runChild({ title: 't', agent: '', prompt: 'p' }), ChildSessionFailed)
  assert.equal(
    failed.sent.some(e => /** @type {unknown[]} */ (e)[0] === 'interrupt'),
    false,
    'a loop that ended failed needs no stop',
  )
})

test('a stop OpenCode fails or does not confirm in time is logged, and the error still reaches the caller', async () => {
  /** @type {string[]} */
  const logged = []
  const log = (/** @type {string} */ l) => logged.push(l)
  const refused = fakeCtx()
  refused.ctx.session.context = () => Promise.reject(new Error('context unreadable'))
  refused.ctx.session.interrupt = () => Promise.reject(new Error('no such session'))
  await assert.rejects(v2Host(refused.ctx, 0, { log }).runChild({ title: 't', agent: '', prompt: 'p' }), /context unreadable/)
  assert.deepEqual(logged, ['craft: child session ses_1 could not be stopped (no such session); it may still be running'])
  const silent = fakeCtx()
  silent.ctx.session.context = () => Promise.reject(new Error('context unreadable'))
  silent.ctx.session.interrupt = () => new Promise(() => {})
  await assert.rejects(v2Host(silent.ctx, 0, { log, interruptMs: 5 }).runChild({ title: 't', agent: '', prompt: 'p' }), /context unreadable/)
  assert.equal(logged[1], 'craft: child session ses_1 did not confirm its stop within 5 ms; it may still be running')
})

test('polling given up after its last read stops the session before it returns nothing', async () => {
  const f = fakeCtx([[{ type: 'user' }], [{ type: 'user' }]])
  assert.equal(await v2Host(f.ctx, 0, { maxPolls: 2 }).runChild({ title: 't', agent: '', prompt: 'p' }), '')
  assert.deepEqual(f.sent.at(-1), ['interrupt', { sessionID: 'ses_1' }])
})
