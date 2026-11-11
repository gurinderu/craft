// The 2.x side of the host against a fake `ctx` shaped as opencode-v2.d.ts pins it (observed on 2.2.7).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { finishedReply, v2Host, v2Setup, v2Tool } from './host-v2.ts'
import { onV2, TOOLS } from './tools.ts'

const assistant = (/** @type {string} */ text) => ({ type: 'assistant', finish: 'stop', content: [{ type: 'reasoning', text: 'hm' }, { type: 'text', text }] })

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
  const reg = { dispose: async () => { disposed++ } }
  const ctx = /** @type {import('./opencode-v2.js').V2Context} */ (/** @type {unknown} */ ({
    app: { version: '2.2.7' },
    location: { directory: '/repo', project: { directory: '/root' } },
    agent: { list: async () => ({ location: { directory: '/repo' }, data: [{ id: 'build' }, { id: 'review-task' }] }) },
    tool: { transform: async (/** @type {any} */ edit) => { edit({ add: (/** @type {any} */ d) => tools.push(d) }); return reg } },
    session: {
      create: async (/** @type {unknown} */ input) => { sent.push(['create', input]); return { id: 'ses_1' } },
      get: async (/** @type {{ sessionID: string }} */ { sessionID }) => (sessionID === 'ses_set' ? { id: sessionID, model: { providerID: 'p', id: 'm', variant: 'default' } } : { id: sessionID }),
      prompt: async (/** @type {unknown} */ input) => { sent.push(['prompt', input]) },
      wait: async () => { sent.push(['wait']) },
      interrupt: async (/** @type {unknown} */ input) => { sent.push(['interrupt', input]); return { interrupted: true } },
      context: async () => contexts.shift() ?? [],
      hook: async (/** @type {string} */ name, /** @type {any} */ cb) => { hooks[name] = cb; return reg },
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }),
          return: async () => ({ done: true, value: undefined }),
        }),
      }),
    },
  }))
  return { ctx, sent, tools, hooks, queue, disposed: () => disposed }
}

test('a child session is created with its agent and model, prompted, and read once it has finished', async () => {
  // The first read finds only the admitted prompt: `wait` can return before the loop starts.
  const f = fakeCtx([[{ type: 'user' }], [{ type: 'user' }, assistant('VERDICT: APPROVE')]])
  /** @type {string[]} */
  const named = []
  const text = await v2Host(f.ctx, 0).runChild({
    title: 'craft:rust-reviewer', agent: 'rust-reviewer', prompt: 'p',
    model: { providerID: 'anthropic', modelID: 'claude-x' }, onSession: id => named.push(id),
  })
  assert.equal(text, 'VERDICT: APPROVE')
  assert.deepEqual(named, ['ses_1'])
  assert.deepEqual(f.sent, [
    ['create', { title: 'craft:rust-reviewer', agent: 'rust-reviewer', model: { providerID: 'anthropic', id: 'claude-x' } }],
    ['prompt', { sessionID: 'ses_1', text: 'p' }],
    ['wait'], ['wait'],
  ])
})

test('a child nests under its parent, and the caller\'s model is the one its session records', async () => {
  const f = fakeCtx([[assistant('x')]])
  const host = v2Host(f.ctx, 0)
  await host.runChild({ title: 't', agent: '', prompt: 'p', parentID: 'ses_parent' })
  assert.deepEqual(f.sent[0], ['create', { title: 't', parentID: 'ses_parent' }])
  assert.deepEqual(await host.callerModel('ses_set'), { providerID: 'p', modelID: 'm' })
  assert.equal(await host.callerModel('ses_unset'), undefined, 'a session that set none runs on the runtime default')
})

test('the default agent and model are left to the session', async () => {
  const f = fakeCtx([[assistant('x')]])
  await v2Host(f.ctx, 0).runChild({ title: 't', agent: '', prompt: 'p' })
  assert.deepEqual(f.sent[0], ['create', { title: 't' }])
})

test('only a finished assistant turn is a reply', () => {
  assert.equal(finishedReply([]), null)
  assert.equal(finishedReply([{ type: 'user' }]), null)
  assert.equal(finishedReply([{ type: 'assistant', content: [{ type: 'text', text: 'half' }] }]), null, 'still streaming')
  assert.equal(finishedReply([{ type: 'assistant', time: { created: 1, completed: 2 } }]), '', 'finished, said nothing')
  assert.equal(finishedReply([assistant(' a ')]), 'a')
})

test('a tool spec becomes a JSON Schema tool whose result is text content, a titled answer its output', async () => {
  /** @type {unknown[]} */
  const ran = []
  const spec = {
    name: 'probe', description: 'd', args: { base: { optional: true }, locator: { optional: false } },
    run: async (/** @type {unknown} */ _host, /** @type {Record<string, string | undefined>} */ args, /** @type {unknown} */ call) => { ran.push([args, call]); return { title: 't', output: 'out' } },
  }
  const def = v2Tool(v2Host(fakeCtx().ctx), spec)
  assert.deepEqual(def.input, {
    type: 'object', properties: { base: { type: 'string' }, locator: { type: 'string' } }, required: ['locator'], additionalProperties: false,
  })
  const signal = new AbortController().signal
  const result = await def.execute({ locator: 'x' }, { sessionID: 's', messageID: 'm', id: 'c', agent: 'build', signal })
  assert.deepEqual(result, { content: [{ type: 'text', text: 'out' }] })
  assert.deepEqual(ran, [[{ base: undefined, locator: 'x' }, { sessionID: 's', signal }]])
})

test('setup registers the tools, hooks the prompt, maps the events, and disposes all of it', async () => {
  const f = fakeCtx()
  /** @type {unknown[]} */
  const seen = []
  const work = {
    childCreated: (/** @type {unknown[]} */ ...a) => { seen.push(['child', ...a]) },
    compacted: async (/** @type {string} */ s) => { seen.push(['compacted', s]) },
    message: async (/** @type {string} */ s, /** @type {string} */ p, /** @type {unknown} */ a, /** @type {(t: string) => boolean} */ deliver) => {
      seen.push(['message', s, p, a, deliver('craft lines')])
    },
  }
  f.queue.push(
    { type: 'session.created', data: { sessionID: 'top' } },
    { type: 'session.created', data: { sessionID: 'c', parentID: 'p', agent: 'general' } },
    { type: 'session.compaction.ended', data: { sessionID: 'p' } },
  )
  const spec = { name: 'probe', description: 'd', args: {}, run: async () => '' }
  const dispose = await v2Setup(f.ctx, [spec], work)
  assert.deepEqual(f.tools.map(t => t.name), ['probe'])
  const input = { sessionID: 'p', messageID: 'm', prompt: { text: 'review it' }, delivery: 'steer' }
  await f.hooks['prompt']?.(input)
  assert.equal(input.prompt.text, 'review it\n\ncraft lines', 'the lines are appended to the prompt itself')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(seen, [['child', 'c', 'p', 'general'], ['compacted', 'p'], ['message', 'p', 'review it', undefined, true]])
  await dispose()
  assert.equal(f.disposed(), 2)
})

test('a deadline interrupts the session and stops the polling', async () => {
  const f = fakeCtx([[{ type: 'user' }], [{ type: 'user' }], [{ type: 'user' }]])
  const stop = new AbortController()
  const ctx = f.ctx
  const wait = ctx.session.wait
  ctx.session.wait = async (input) => { await wait(input); stop.abort() }
  await assert.rejects(v2Host(ctx, 0).runChild({ title: 't', agent: '', prompt: 'p', signal: stop.signal }), /stopped at its deadline/)
  assert.deepEqual(f.sent.filter(e => Array.isArray(e) && e[0] === 'wait').length, 1, 'no read after the abort')
  assert.deepEqual(f.sent.at(-1), ['interrupt', { sessionID: 'ses_1' }])
})

test('the audit and the triage on the 2.x entry refuse up front and say so; the review runs as it is', async () => {
  const f = fakeCtx()
  await v2Setup(f.ctx, onV2(TOOLS), { childCreated: () => {}, compacted: async () => {}, message: async () => {} })
  assert.deepEqual(f.tools.map(t => t.name), ['rust-audit', 'triage-findings', 'review'], 'all three stay registered')
  const [review, ...workflows] = [f.tools.find(t => t.name === 'review'), ...f.tools.filter(t => t.name !== 'review')]
  assert.equal(review?.description, TOOLS.find(t => t.name === 'review')?.description, 'the review goes through opencode run, not child sessions')
  for (const tool of workflows) {
    const out = await tool.execute({ locator: 'x' }, { sessionID: 'ses_set', messageID: 'm', id: 'c', agent: 'build', signal: new AbortController().signal })
    assert.match(out.content[0].text, new RegExp(`INCOMPLETE — craft's \`${tool.name}\` does not yet work in OpenCode 2\\.x: .*A route through \`opencode run\` is in progress; until it ships, use OpenCode 1\\.x, Claude Code, Codex or pi\\. Nothing ran\\.`))
    assert.match(tool.description, /^Not available on OpenCode 2\.x yet/)
  }
  assert.equal(f.sent.filter(s => /** @type {unknown[]} */ (s)[0] === 'create').length, 0)
})

test('the polling leaves no abort listener behind, however many reads it takes', async () => {
  const f = fakeCtx([[{ type: 'user' }], [{ type: 'user' }], [{ type: 'user' }], [assistant('done')]])
  const stop = new AbortController()
  let live = 0
  let most = 0
  const add = stop.signal.addEventListener.bind(stop.signal)
  const remove = stop.signal.removeEventListener.bind(stop.signal)
  stop.signal.addEventListener = (/** @type {any[]} */ ...a) => { most = Math.max(most, ++live); add(.../** @type {[any, any, any]} */ (a)) }
  stop.signal.removeEventListener = (/** @type {any[]} */ ...a) => { live--; remove(.../** @type {[any, any]} */ (a)) }
  assert.equal(await v2Host(f.ctx, 0).runChild({ title: 't', agent: '', prompt: 'p', signal: stop.signal }), 'done')
  assert.equal(live, 0)
  assert.ok(most <= 2, `at most the session's stop and one poll's listener at once, saw ${most}`)
})

test('a wait that never returns does not hold the polling past the abort', async () => {
  const f = fakeCtx()
  const stop = new AbortController()
  f.ctx.session.wait = () => { setTimeout(() => stop.abort(), 5); return new Promise(() => {}) }
  await assert.rejects(v2Host(f.ctx, 0).runChild({ title: 't', agent: '', prompt: 'p', signal: stop.signal }), /stopped at its deadline/)
  assert.deepEqual(f.sent.at(-1), ['interrupt', { sessionID: 'ses_1' }])
})
