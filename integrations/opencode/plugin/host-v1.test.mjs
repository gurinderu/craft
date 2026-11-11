// The 1.x side of the host against a fake SDK client: what it sends, and how it reads the answer back.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { extractText, lastModel, v1Host, v1Hooks } from './host-v1.ts'
import { TOOLS } from './tools.ts'

/** @param {unknown} reply */
function fakeClient(reply) {
  /** @type {unknown[]} */
  const sent = []
  return {
    sent,
    session: {
      create: async (/** @type {unknown} */ req) => { sent.push(['create', req]); return { data: { id: 'ses_1' } } },
      prompt: async (/** @type {unknown} */ req) => { sent.push(['prompt', req]); return reply },
      abort: async (/** @type {unknown} */ req) => { sent.push(['abort', req]); return { data: true } },
      messages: async (/** @type {unknown} */ req) => { sent.push(['messages', req]); return { data: [{ info: { role: 'user', model: { providerID: 'p', modelID: 'm' } } }, { info: { role: 'assistant' } }] } },
    },
    app: { agents: async () => ({ data: [{ name: 'build' }, { name: 'rust-reviewer' }] }) },
  }
}

test('a child session is created, named to the orchestrator, and prompted with the agent and model', async () => {
  const client = fakeClient({ parts: [{ type: 'text', text: 'done' }] })
  /** @type {string[]} */
  const named = []
  const host = v1Host({ client, directory: '/repo', worktree: '/repo' })
  const text = await host.runChild({
    title: 'craft:rust-reviewer', agent: 'rust-reviewer', prompt: 'p',
    model: { providerID: 'anthropic', modelID: 'claude-x' }, onSession: id => named.push(id),
  })
  assert.equal(text, 'done')
  assert.deepEqual(named, ['ses_1'])
  assert.deepEqual(client.sent, [
    ['create', { body: { title: 'craft:rust-reviewer' } }],
    ['prompt', { path: { id: 'ses_1' }, body: { agent: 'rust-reviewer', parts: [{ type: 'text', text: 'p' }], model: { providerID: 'anthropic', modelID: 'claude-x' } } }],
  ])
})

test('a child nests under its parent, and the caller\'s model is its newest message\'s', async () => {
  const client = fakeClient({ text: 'ok' })
  const host = v1Host({ client, directory: '', worktree: '' })
  await host.runChild({ title: 't', agent: '', prompt: 'p', parentID: 'ses_parent' })
  assert.deepEqual(client.sent[0], ['create', { body: { title: 't', parentID: 'ses_parent' } }])
  assert.deepEqual(await host.callerModel('ses_parent'), { providerID: 'p', modelID: 'm' })
  assert.deepEqual(client.sent.at(-1), ['messages', { path: { id: 'ses_parent' } }])
  // The shapes observed on opencode 1.19.5: a user message's `model`, an assistant's own ids; none at all.
  assert.deepEqual(lastModel({ data: [{ info: { role: 'user', model: { providerID: 'a', modelID: 'b' } } }, { info: { role: 'assistant', providerID: 'c', modelID: 'd' } }] }), { providerID: 'c', modelID: 'd' })
  assert.equal(lastModel({ data: [{ info: { role: 'user' } }] }), undefined)
  assert.equal(lastModel(null), undefined)
})

test('without a model the prompt carries none, and the session keeps its own', async () => {
  const client = fakeClient({ text: 'ok' })
  await v1Host({ client, directory: '', worktree: '' }).runChild({ title: 't', agent: '', prompt: 'p' })
  assert.deepEqual(client.sent[1], ['prompt', { path: { id: 'ses_1' }, body: { agent: '', parts: [{ type: 'text', text: 'p' }] } }])
})

test('the answer is read from every response shape a session may return', () => {
  // A response may carry its parts at the top, under `data` or under `message`, may arrive as an array
  // whose last element is the message, or may carry only a top-level `text`. Each shape is an answer.
  const line = 'VERDICT: APPROVE'
  /** @type {Record<string, unknown>} */
  const shapes = {
    top: { parts: [{ type: 'text', text: line }] },
    data: { data: { parts: [{ type: 'text', text: line }] } },
    message: { message: { parts: [{ type: 'text', text: line }] } },
    array: [{ parts: [] }, { parts: [{ type: 'text', text: line }] }],
    text: { text: `  ${line}  ` },
  }
  for (const [shape, res] of Object.entries(shapes)) assert.deepEqual([shape, extractText(res)], [shape, line])
  assert.equal(extractText({ parts: [{ type: 'image', text: line }] }), '', 'a part that is not text carries no answer')
  assert.equal(extractText(null), '')
})

test('each tool spec becomes a 1.x tool that hands its string arguments to the spec', async () => {
  /** @type {unknown[]} */
  const ran = []
  const spec = {
    name: 'probe', description: 'd', args: { base: { optional: true }, locator: { optional: false } },
    run: async (/** @type {unknown} */ _host, /** @type {Record<string, string | undefined>} */ args, /** @type {unknown} */ call) => { ran.push([args, call]); return 'out' },
  }
  const work = { childCreated() {}, compacted: async () => {}, message: async () => {} }
  const hooks = v1Hooks({ client: fakeClient(null), directory: '/r', worktree: '/r' }, [spec], work)
  const probe = hooks.tool?.['probe']
  assert.ok(probe, 'the tool is registered under its name')
  assert.equal(probe.description, 'd')
  assert.deepEqual(Object.keys(probe.args).sort(), ['base', 'locator'])
  const out = await probe.execute({ locator: 'x', base: 3 }, /** @type {any} */ ({ sessionID: 'ses_caller' }))
  assert.equal(out, 'out')
  assert.deepEqual(ran, [[{ base: undefined, locator: 'x' }, { sessionID: 'ses_caller' }]], 'only string arguments reach the spec, with the caller')
  assert.equal(typeof hooks['chat.message'], 'function')
  assert.equal(typeof hooks.event, 'function')
})

test('a deadline stops the session and gives up on it; a refused prompt throws its error; the agents are listed', async () => {
  const stop = new AbortController()
  const hung = fakeClient(null)
  hung.session.prompt = async (/** @type {unknown} */ req) => { hung.sent.push(['prompt', req]); stop.abort(); return { data: {} } }
  await assert.rejects(v1Host({ client: hung, directory: '', worktree: '' }).runChild({ title: 't', agent: '', prompt: 'p', signal: stop.signal }), /stopped at its deadline/)
  assert.deepEqual(hung.sent.at(-1), ['abort', { path: { id: 'ses_1' } }])
  // As opencode 1.19.5 answers an unknown agent (observed): an error object, not a throw.
  const refused = fakeClient({ error: { name: 'UnknownError', data: { message: 'Unexpected server error.' } } })
  await assert.rejects(v1Host({ client: refused, directory: '', worktree: '' }).runChild({ title: 't', agent: 'x', prompt: 'p' }), /Unexpected server error/)
  assert.deepEqual([...await v1Host({ client: refused, directory: '', worktree: '' }).agents() ?? []], ['build', 'rust-reviewer'])
})

test('the review tool on a 1.x without review-task refuses up front and opens no session', async () => {
  const client = fakeClient({ text: 'ok' })
  const review = TOOLS.find(t => t.name === 'review')
  const answer = await review?.run(v1Host({ client, directory: '/r', worktree: '/r' }), {}, { sessionID: 'ses_caller' })
  assert.doesNotMatch(String(answer), /does not yet work in OpenCode 2\.x/, '1.x runs the review as before')
  assert.match(String(answer), /INCOMPLETE — the craft OpenCode agents are not installed or are out of date: rerun integrations\/opencode\/install\.sh/)
  assert.equal(client.sent.filter(s => /** @type {unknown[]} */ (s)[0] === 'create').length, 0)
})
