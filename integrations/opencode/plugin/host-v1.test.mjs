// The 1.x side of the host against a fake SDK client: what it sends, and how it reads the answer back.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMarkdown } from './frontmatter.ts'
import { ChildSessionFailed } from './host.ts'
import { extractText, lastModel, v1Host, v1Hooks } from './host-v1.ts'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** @param {unknown} reply @param {() => Promise<unknown>} [agents] */
function fakeClient(reply, agents = () => Promise.resolve({ data: [] })) {
  /** @type {unknown[]} */
  const sent = []
  return {
    sent,
    app: { agents },
    session: {
      create: (/** @type {unknown} */ req) => {
        sent.push(['create', req])
        return Promise.resolve({ data: { id: 'ses_1' } })
      },
      prompt: (/** @type {unknown} */ req) => {
        sent.push(['prompt', req])
        return Promise.resolve(reply)
      },
      abort: (/** @type {unknown} */ req) => {
        sent.push(['abort', req])
        return Promise.resolve({ data: true })
      },
      messages: (/** @type {unknown} */ req) => {
        sent.push(['messages', req])
        return Promise.resolve({ data: [{ info: { role: 'user', model: { providerID: 'p', modelID: 'm' } } }, { info: { role: 'assistant' } }] })
      },
    },
  }
}

test('a child session is created, named to the orchestrator, and prompted with the agent and model', async () => {
  const client = fakeClient({ parts: [{ type: 'text', text: 'done' }] })
  /** @type {string[]} */
  const named = []
  const host = v1Host({ client, directory: '/repo', worktree: '/repo' })
  const text = await host.runChild({
    title: 'craft:rust-reviewer',
    agent: 'rust-reviewer',
    prompt: 'p',
    model: { providerID: 'anthropic', modelID: 'claude-x' },
    onSession: id => named.push(id),
  })
  assert.equal(text, 'done')
  assert.deepEqual(named, ['ses_1'])
  assert.deepEqual(client.sent, [
    ['create', { body: { title: 'craft:rust-reviewer' } }],
    [
      'prompt',
      {
        path: { id: 'ses_1' },
        body: { agent: 'rust-reviewer', parts: [{ type: 'text', text: 'p' }], model: { providerID: 'anthropic', modelID: 'claude-x' } },
      },
    ],
  ])
})

test("a child nests under its parent, and the caller's model is its newest message's", async () => {
  const client = fakeClient({ text: 'ok' })
  const host = v1Host({ client, directory: '', worktree: '' })
  await host.runChild({ title: 't', agent: '', prompt: 'p', parentID: 'ses_parent' })
  assert.deepEqual(client.sent[0], ['create', { body: { title: 't', parentID: 'ses_parent' } }])
  assert.deepEqual(await host.callerModel('ses_parent'), { providerID: 'p', modelID: 'm' })
  assert.deepEqual(client.sent.at(-1), ['messages', { path: { id: 'ses_parent' } }])
  // The shapes observed on opencode 1.19.5: a user message's `model`, an assistant's own ids; none at all.
  assert.deepEqual(
    lastModel({ data: [{ info: { role: 'user', model: { providerID: 'a', modelID: 'b' } } }, { info: { role: 'assistant', providerID: 'c', modelID: 'd' } }] }),
    { providerID: 'c', modelID: 'd' },
  )
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

test('each tool spec becomes a 1.x tool that hands its string arguments, the abort and a progress title to the spec', async () => {
  /** @type {unknown[]} */
  const ran = []
  const spec = {
    name: 'probe',
    description: 'd',
    args: { base: { optional: true }, locator: { optional: false } },
    run: (/** @type {unknown} */ _host, /** @type {Record<string, string | undefined>} */ args, /** @type {import('./host.ts').ToolCall} */ call) => {
      call.progress?.('half way')
      ran.push([args, Object.fromEntries(Object.entries(call).filter(([k]) => k !== 'progress'))])
      return Promise.resolve({ title: 't', output: 'out' })
    },
  }
  const work = { childCreated() {}, compacted: async () => {}, message: async () => {} }
  const hooks = v1Hooks({ client: fakeClient(null), directory: '/r', worktree: '/r' }, [spec], work)
  const probe = hooks.tool?.['probe']
  assert.ok(probe, 'the tool is registered under its name')
  assert.equal(probe.description, 'd')
  assert.deepEqual(Object.keys(probe.args).sort(), ['base', 'locator'])
  /** @type {unknown[]} */
  const titles = []
  const abort = new AbortController().signal
  const out = await probe.execute(
    { locator: 'x', base: 3 },
    /** @type {any} */ ({ sessionID: 'ses_caller', abort, metadata: (/** @type {unknown} */ m) => titles.push(m) }),
  )
  assert.deepEqual(out, { title: 't', output: 'out' }, 'a titled answer reaches 1.x as it is')
  assert.deepEqual(
    ran,
    [
      [
        { base: undefined, locator: 'x' },
        { sessionID: 'ses_caller', signal: abort },
      ],
    ],
    'only string arguments reach the spec, with the caller and its abort',
  )
  assert.deepEqual(titles, [{ title: 'half way' }], "progress is the tool's title")
  assert.equal(typeof hooks['chat.message'], 'function')
  assert.equal(typeof hooks.event, 'function')
})

test("the 1.x hooks carry the review-task agent's lightening: its system text is cut in place, any other request's passes, and a throw never reaches the host", async () => {
  /** @type {string[]} */
  const said = []
  const work = { childCreated() {}, compacted: async () => {}, message: async () => {} }
  const hooks = v1Hooks({ client: fakeClient(null), directory: '/r', worktree: '/r' }, [], work, line => said.push(line))
  const transform = hooks['experimental.chat.system.transform']
  assert.equal(typeof transform, 'function', 'the hook stands under the name the 1.x types give it')
  const call = /** @type {(input: unknown, output: unknown) => Promise<void>} */ (transform)
  const { body } = parseMarkdown(fs.readFileSync(path.join(REPO, 'integrations/opencode/agents/review-task.md'), 'utf8'))
  const MODEL_LINE = 'You are powered by the model named fake-model. The exact model ID is fake/fake-model'
  const RULES = 'Instructions from: /r/AGENTS.md\n# Rules\n\nMARKER-HOOK-RULES-c2d4\n'
  const light = { system: [`${body}\n${MODEL_LINE}\n${RULES}`] }
  await call({ sessionID: 'ses_1', model: { providerID: 'fake', modelID: 'fake-model' } }, light)
  assert.deepEqual(light, { system: [`${body}\n${MODEL_LINE}\n`] }, 'the rule file goes, the rest stays byte for byte')
  // The session's title request comes under the session's own id (opencode 1.19.5): the id cannot tell the requests apart.
  const TITLE = 'You are a title generator. You output ONLY a thread title. Nothing else.'
  const title = { system: [`${TITLE}\n${RULES}`] }
  await call({ sessionID: 'ses_1', model: { providerID: 'fake', modelID: 'fake-model' } }, title)
  assert.deepEqual(title, { system: [`${TITLE}\n${RULES}`] }, "a request that is not the agent's passes as it came")
  const sealed = {
    get system() {
      throw new Error('system is sealed')
    },
  }
  await call(undefined, sealed)
  await call(undefined, sealed)
  assert.deepEqual(said, ["craft: could not lighten the review-task agent's context on this OpenCode: system is sealed"], 'said once per reason')
  assert.deepEqual(Object.keys(hooks).sort(), ['chat.message', 'event', 'experimental.chat.system.transform', 'tool'])
})

test('a deadline stops the session and gives up on it; a refused prompt throws its error', async () => {
  const stop = new AbortController()
  const hung = fakeClient(null)
  hung.session.prompt = (/** @type {unknown} */ req) => {
    hung.sent.push(['prompt', req])
    stop.abort()
    return Promise.resolve({ data: {} })
  }
  await assert.rejects(
    v1Host({ client: hung, directory: '', worktree: '' }).runChild({ title: 't', agent: '', prompt: 'p', signal: stop.signal }),
    /stopped at its deadline/,
  )
  assert.deepEqual(hung.sent.at(-1), ['abort', { path: { id: 'ses_1' } }])
  // As opencode 1.19.5 answers an unknown agent (observed): an error object, not a throw.
  const refused = fakeClient({ error: { name: 'UnknownError', data: { message: 'Unexpected server error.' } } })
  await assert.rejects(v1Host({ client: refused, directory: '', worktree: '' }).runChild({ title: 't', agent: 'x', prompt: 'p' }), /Unexpected server error/)
})

test("a turn that failed inside throws the runtime's error by its type and message, as 2.x does", async () => {
  // As opencode 1.19.6 answers a turn the provider refused (observed): the reply's assistant message carries the error.
  const limit = 'Claude Max usage limit reached, resets 5pm'
  const failed = fakeClient({ data: { info: { role: 'assistant', error: { name: 'APIError', data: { message: limit } } }, parts: [] } })
  await assert.rejects(
    v1Host({ client: failed, directory: '', worktree: '' }).runChild({ title: 't', agent: 'review-task', prompt: 'p' }),
    (/** @type {unknown} */ e) =>
      e instanceof ChildSessionFailed && e.type === 'APIError' && e.detail === limit && e.message === `the child session failed (APIError): ${limit}`,
  )
  const bare = fakeClient({ data: { info: { role: 'assistant', error: { data: {} } }, parts: [{ type: 'text', text: 'half' }] } })
  await assert.rejects(
    v1Host({ client: bare, directory: '', worktree: '' }).runChild({ title: 't', agent: '', prompt: 'p' }),
    (/** @type {unknown} */ e) => e instanceof ChildSessionFailed && e.message === 'the child session failed (unknown)',
  )
  const fine = fakeClient({ data: { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] } })
  assert.equal(await v1Host({ client: fine, directory: '', worktree: '' }).runChild({ title: 't', agent: '', prompt: 'p' }), 'ok')
})

test('the agents are the names the runtime lists; a refused or unreadable list throws', async () => {
  // `GET /agent` as the 1.x SDK's `app.agents()` answers it: the agents under `data`, each by its `name`.
  const listed = fakeClient(null, () =>
    Promise.resolve({ data: [{ name: 'build', mode: 'primary' }, { name: 'review-task', mode: 'all' }, { mode: 'subagent' }] }),
  )
  assert.deepEqual(await v1Host({ client: listed, directory: '', worktree: '' }).agents?.(), ['build', 'review-task'])
  const refused = fakeClient(null, () => Promise.resolve({ error: { name: 'UnknownError', data: { message: 'agent list gone' } } }))
  await assert.rejects(v1Host({ client: refused, directory: '', worktree: '' }).agents?.() ?? Promise.resolve(), /agent list gone/)
  const odd = fakeClient(null, () => Promise.resolve({ data: { agents: 'none' } }))
  await assert.rejects(v1Host({ client: odd, directory: '', worktree: '' }).agents?.() ?? Promise.resolve(), /not a list/)
})
