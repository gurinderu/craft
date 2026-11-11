// The 1.x side of the host against a fake SDK client: what it sends, and how it reads the answer back.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { extractText, v1Host, v1Hooks } from './host-v1.ts'

/** @param {unknown} reply */
function fakeClient(reply) {
  /** @type {unknown[]} */
  const sent = []
  return {
    sent,
    session: {
      create: async (/** @type {unknown} */ req) => { sent.push(['create', req]); return { data: { id: 'ses_1' } } },
      prompt: async (/** @type {unknown} */ req) => { sent.push(['prompt', req]); return reply },
    },
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
    run: async (/** @type {unknown} */ _host, /** @type {Record<string, string | undefined>} */ args) => { ran.push(args); return 'out' },
  }
  const work = { childCreated() {}, compacted: async () => {}, message: async () => {} }
  const hooks = v1Hooks({ client: fakeClient(null), directory: '/r', worktree: '/r' }, [spec], work)
  const probe = hooks.tool?.['probe']
  assert.ok(probe, 'the tool is registered under its name')
  assert.equal(probe.description, 'd')
  assert.deepEqual(Object.keys(probe.args).sort(), ['base', 'locator'])
  const out = await probe.execute({ locator: 'x', base: 3 }, /** @type {any} */ ({}))
  assert.equal(out, 'out')
  assert.deepEqual(ran, [{ base: undefined, locator: 'x' }], 'only string arguments reach the spec')
  assert.equal(typeof hooks['chat.message'], 'function')
  assert.equal(typeof hooks.event, 'function')
})
